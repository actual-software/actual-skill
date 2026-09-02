#!/usr/bin/env bash
# bootstrap.sh - Shared preflight helpers for the actual plan-stage governance hooks.
#
# Sourced by hooks/plan-gate.sh (PreToolUse:ExitPlanMode) and hooks/preflight.sh
# (SessionStart). Read-only: never modifies files, config, or state.
#
# Portability: bash 3.2+ (stock macOS) and Linux. Deliberately depends on NOTHING
# beyond bash builtins, `command`, and `git`. In particular it never parses JSON,
# so `jq` and `python3` are not required -- neither ships on stock macOS. JSON is
# only ever *written* here, which is trivial. Parsing the hook envelope is the
# CLI's job (see `actual plan-check --claude-hook`).
#
# Note: these scripts intentionally do NOT `set -e`. The governance gate must fail
# open -- an unexpected error has to leave the agent's work untouched, never abort
# a tool call. Errors are handled explicitly at each call site instead.

set -uo pipefail

# --- Repo and rules discovery ---

# Canonicalize a directory path -- resolves symlinks and trailing slashes so two
# paths can be compared as plain strings. Fails for anything that is not a directory.
canonical_dir() {
  [ -n "${1:-}" ] || return 1
  [ -d "$1" ] || return 1
  (cd -- "$1" 2>/dev/null && pwd -P) || return 1
}

# True when $2 is $1 itself or a directory beneath it. Both arguments must already
# be canonical.
is_within() {
  local outer="${1%/}" inner="$2"
  [ -n "$outer" ] || return 0        # "/" contains every absolute path
  [ "$inner" = "$outer" ] || [ "${inner#"${outer}/"}" != "$inner" ]
}

# Resolve the repository root the hook is running against -- the checkout whose
# .actual/rules/ must govern this decision.
#
# Two signals, neither sufficient alone:
#
#   CLAUDE_PROJECT_DIR  Claude Code's project root. It does NOT follow the session
#                       into a git worktree: it keeps naming the original checkout
#                       while the session works in another one, on another branch.
#   git toplevel of cwd The checkout actually being worked in. But when Claude Code
#                       was launched inside a subdirectory of a larger repository,
#                       this is the outer repo, not the subproject.
#
# When one contains the other, the DEEPER path is the more specific context and wins:
#
#   worktree   project=/repo, toplevel=/repo/.claude/worktrees/x  -> the worktree.
#              Claude Code puts worktrees under the project root, so the active
#              checkout is nested inside CLAUDE_PROJECT_DIR, not outside it.
#   monorepo   project=/repo/packages/api, toplevel=/repo         -> the subproject.
#   ordinary   the two are equal                                  -> either.
#
# Otherwise they are unrelated (a worktree created outside the project root, say) and
# the active checkout under cwd wins. All of this reads cwd rather than the hook
# envelope's `cwd` field, which would mean parsing JSON; Claude Code runs the hook
# from that directory, so the two agree.
resolve_repo_root() {
  local project_dir here git_root

  project_dir=$(canonical_dir "${CLAUDE_PROJECT_DIR:-}") || project_dir=""
  here=$(pwd -P 2>/dev/null) || here="$PWD"

  git_root=$(git rev-parse --show-toplevel 2>/dev/null) || git_root=""
  if [ -n "$git_root" ]; then
    git_root=$(canonical_dir "$git_root") || git_root=""
  fi

  # Only one signal available.
  if [ -z "$project_dir" ]; then
    [ -n "$git_root" ] && { printf '%s' "$git_root"; return 0; }
    printf '%s' "$here"
    return 0
  fi
  if [ -z "$git_root" ]; then
    printf '%s' "$project_dir"
    return 0
  fi

  # Both known: the deeper of the two when nested, else the active checkout.
  if is_within "$project_dir" "$git_root"; then
    printf '%s' "$git_root"
    return 0
  fi
  if is_within "$git_root" "$project_dir"; then
    printf '%s' "$project_dir"
    return 0
  fi
  printf '%s' "$git_root"
}

# Directory holding the committed rule files. ACTUAL_RULES_DIR overrides it, which
# is how a monorepo points the gate at a subproject's rules. plan-gate.sh passes
# this path to the CLI as --rules-dir so scoring uses the same directory.
rules_dir() {
  if [ -n "${ACTUAL_RULES_DIR:-}" ]; then
    printf '%s' "${ACTUAL_RULES_DIR}"
    return 0
  fi
  printf '%s/.actual/rules' "$(resolve_repo_root)"
}

# Count the *.md rule files in a directory. Top level only -- the observed
# `.actual/rules/` layout is flat. Prints 0 for a missing or empty directory.
rules_count() {
  local dir="$1"
  [ -d "$dir" ] || { printf '0'; return 0; }

  local f count=0
  for f in "$dir"/*.md; do
    # Guards the literal glob pattern when nothing matches (no nullglob in bash 3.2).
    [ -e "$f" ] && count=$((count + 1))
  done
  printf '%s' "$count"
}

# True when this repo has committed rules to govern against. When false every hook
# must be a completely silent no-op, so installing the plugin never affects
# unrelated repositories.
rules_present() {
  [ "$(rules_count "$(rules_dir)")" -gt 0 ]
}

# --- CLI detection ---

have_actual() {
  command -v actual >/dev/null 2>&1
}

# Capability probe rather than a version comparison: it is version-agnostic, and it
# turns "unrecognized subcommand" noise into a clean boolean. A CLI too old to know
# `plan-check` fails this and gets an actionable upgrade message instead of a
# confusing flag error.
have_plan_check() {
  actual plan-check --help >/dev/null 2>&1
}

# True when plan-check exited 2 because this CLI build has no such subcommand.
# Used by the gate instead of a second --help spawn: an unknown subcommand must
# fail open with upgrade guidance, not be treated as a deny (exit 2 fallback).
is_unrecognized_plan_check() {
  local err
  err=$(<"$1") || return 1
  case "$err" in
    *unrecognized\ subcommand*plan-check*) return 0 ;;
  esac
  return 1
}

# --- Operator-facing messages ---

# Install matrix mirrors the one documented in skills/actual/SKILL.md.
install_message() {
  cat <<'EOF'
Actual plan-stage governance is configured for this repository (.actual/rules/ is
present), but the `actual` CLI is not on PATH, so plans are not being checked.

Install it with one of:
  npm install -g @actualai/actual
  brew install actual-software/actual/actual

Then verify with: actual --version
Docs: https://cli.actual.ai
EOF
}

upgrade_message() {
  cat <<'EOF'
Actual plan-stage governance is configured for this repository (.actual/rules/ is
present), but the installed `actual` CLI has no `plan-check` subcommand, so plans
are not being checked.

Upgrade with one of:
  npm install -g @actualai/actual@latest
  brew upgrade actual-software/actual/actual

Then verify with: actual plan-check --help
EOF
}

# --- JSON writing ---

# Escape a string for use inside a JSON string literal. Pure parameter expansion,
# no subprocesses. Order matters: backslashes first.
json_escape() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/\\r}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

# True when a JSON object names permissionDecision:allow. Whitespace-insensitive so
# pretty-printed CLI output is still caught. A substring match, not a parse: enough
# to refuse the unsafe shape without jq/python.
is_allow_decision() {
  local s="$1"
  s=${s// /}
  s=${s//$'\n'/}
  s=${s//$'\t'/}
  s=${s//$'\r'/}
  [ "${s#*\"permissionDecision\":\"allow\"}" != "$s" ]
}

# Advisory for a PreToolUse hook that is NOT making a permission decision.
#
# Deliberately emits no `permissionDecision`. Per the hook protocol a hook "can deny
# the call, but staying silent doesn't approve it" -- so omitting the field leaves the
# normal permission flow intact. A conforming plan must stay silent on that field;
# only `deny` (or exit 2) may block.
#
# `allow` is never correct on this gate, because it is a grant: a gate has no business
# approving a plan on the user's behalf. Measured on Claude Code 2.1.231, an `allow`
# here does NOT in fact bypass the plan-approval dialog -- Claude Code logs "Hook
# returned 'allow' for ExitPlanMode, but ask rule/safety check requires full
# permission pipeline" and prompts the user anyway. That upstream safety check is
# undocumented, so this wrapper drops an `allow` verdict rather than depending on it.
#
# systemMessage is emitted both top level and inside hookSpecificOutput because its
# documented location has moved between versions; unknown fields are ignored.
emit_pretooluse_notice() {
  local msg
  msg=$(json_escape "$1")
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"PreToolUse","systemMessage":"%s"}}\n' \
    "$msg" "$msg"
}

emit_sessionstart_context() {
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
    "$(json_escape "$1")"
}
