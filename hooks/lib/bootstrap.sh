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

# Resolve the repository root the hook is running against.
# CLAUDE_PROJECT_DIR is set by Claude Code; git and $PWD are fallbacks.
resolve_repo_root() {
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
    printf '%s' "${CLAUDE_PROJECT_DIR}"
    return 0
  fi

  local root
  if root=$(git rev-parse --show-toplevel 2>/dev/null) && [ -n "$root" ]; then
    printf '%s' "$root"
    return 0
  fi

  printf '%s' "$PWD"
}

# Directory holding the committed rule files. ACTUAL_RULES_DIR overrides it, which
# is how a monorepo points the gate at a subproject's rules.
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

# Advisory for a PreToolUse hook that is NOT making a permission decision.
#
# Deliberately emits no `permissionDecision`. Per the hook protocol a hook "can deny
# the call, but staying silent doesn't approve it" -- so omitting the field leaves the
# normal permission flow intact. Returning "allow" here would *grant* ExitPlanMode and
# skip the user's plan-approval dialog, which is exactly wrong for an advisory.
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
