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

# impl-check's own counterpart of have_plan_check -- see that function's
# comment. Checked separately because a CLI can have one subcommand without
# the other: plan-check shipped first (AK-672-era builds), impl-check later
# (AK-755), so "has plan-check" does not imply "has impl-check".
have_impl_check() {
  actual impl-check --help >/dev/null 2>&1
}

# impl-check's own counterpart of is_unrecognized_plan_check.
is_unrecognized_impl_check() {
  local err
  err=$(<"$1") || return 1
  case "$err" in
    *unrecognized\ subcommand*impl-check*) return 0 ;;
  esac
  return 1
}

# --- Operator-facing messages ---

# Install matrix mirrors the one documented in skills/actual/SKILL.md.
#
# Phrased as an instruction to the agent, not just information for a human: this
# text is consumed as hook context (SessionStart additionalContext, or a PreToolUse
# systemMessage), so ask the agent to actively offer the install rather than passively
# describe it. It must still ask the user first -- installing a global CLI is a
# machine-wide change the agent should never make unprompted.
#
# additionalContext/systemMessage is advisory, not a directive the agent is forced to
# act on -- unlike a deny, nothing about the hook protocol makes the agent interrupt
# what it is already doing to surface this. Observed on Claude Code 2.1.206, in two
# stages:
#   1. A softer "offer to install" phrasing, dropped into a session already mid-task
#      (a feature plan already underway), was silently absorbed into context and
#      never mentioned in any reply.
#   2. Adding "regardless of what else is in progress" / "in your very next reply"
#      fixed that -- the agent did mention it -- but then proceeded straight through
#      plan approval into implementation without ever getting an actual answer.
#      Mentioning something in passing and pausing for a decision are different
#      behaviors, and the text has to ask for the second one explicitly: naming the
#      question tool (AskUserQuestion, matching SKILL.md's existing convention) and
#      saying in so many words that a mention followed by continuing anyway does not
#      count as asking.
# This is still a probability improvement, not a guarantee: the fail-open contract
# (see plan-gate.sh) means a missing CLI can never become a real interrupt (a deny)
# just to make this more reliable, so the agent is always free to disregard it.
install_message() {
  cat <<'EOF'
Actual plan-stage governance is configured for this repository (.actual/rules/ is
present), but the `actual` CLI is not on PATH, so plans are not being checked.

This is worth interrupting the current task for: mention it in your very next reply,
regardless of what else is in progress. Offer to install it now rather than just
describing the steps -- ask using an interactive question tool (e.g. AskUserQuestion)
so your turn actually pauses for the user's answer, and do not continue this task --
exploring, planning, or implementing -- until they respond. Mentioning this and then
carrying on anyway does not satisfy this; wait for the answer first.

If they agree, run one of these with the Bash tool:
  npm install -g @actualai/actual
  brew install actual-software/actual/actual

Then verify with: actual --version. If they decline, don't run anything --
installation stays optional -- but only resume the original task once they have
actually answered either way.
Docs: https://cli.actual.ai
EOF
}

upgrade_message() {
  cat <<'EOF'
Actual plan-stage governance is configured for this repository (.actual/rules/ is
present), but the installed `actual` CLI has no `plan-check` subcommand, so plans
are not being checked.

This is worth interrupting the current task for: mention it in your very next reply,
regardless of what else is in progress. Offer to upgrade it now rather than just
describing the steps -- ask using an interactive question tool (e.g. AskUserQuestion)
so your turn actually pauses for the user's answer, and do not continue this task --
exploring, planning, or implementing -- until they respond. Mentioning this and then
carrying on anyway does not satisfy this; wait for the answer first.

If they agree, run one of these with the Bash tool:
  npm install -g @actualai/actual@latest
  brew upgrade actual-software/actual/actual

Then verify with: actual plan-check --help. If they decline, don't run anything --
upgrading stays optional -- but only resume the original task once they have
actually answered either way.
EOF
}

# impl-check's own counterpart of upgrade_message, for a CLI build that has
# plan-check but predates AK-755 (no impl-check subcommand yet).
impl_upgrade_message() {
  cat <<'EOF'
Actual implementation-stage governance is configured for this repository
(.actual/rules/ is present), but the installed `actual` CLI has no `impl-check` subcommand,
so your changes are not being checked as you go.

This is worth interrupting the current task for: mention it in your very next reply,
regardless of what else is in progress. Offer to upgrade it now rather than just
describing the steps -- ask using an interactive question tool (e.g. AskUserQuestion)
so your turn actually pauses for the user's answer, and do not continue this task --
exploring, planning, or implementing -- until they respond. Mentioning this and then
carrying on anyway does not satisfy this; wait for the answer first.

If they agree, run one of these with the Bash tool:
  npm install -g @actualai/actual@latest
  brew upgrade actual-software/actual/actual

Then verify with: actual impl-check --help. If they decline, don't run anything --
upgrading stays optional -- but only resume the original task once they have
actually answered either way.
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

# True when a JSON object names permissionDecision:deny. Whitespace-insensitive so
# pretty-printed CLI output is still caught. A substring match, not a parse -- so
# plan-gate.sh forwards a verdict only when this recognizes it, never on the absence
# of some other shape. JSON lets any character be spelled as a \uXXXX escape, which
# defeats a literal-bytes match; an escaped "allow" that this function fails to
# recognize as deny is therefore refused (advisory, no decision), not forwarded.
# That asymmetry is deliberate: the failure mode of this match landing wrong must be
# fail-safe, and "no decision" is always safe here.
is_deny_decision() {
  local s="$1"
  s=${s// /}
  s=${s//$'\n'/}
  s=${s//$'\t'/}
  s=${s//$'\r'/}
  [ "${s#*\"permissionDecision\":\"deny\"}" != "$s" ]
}

# True when a JSON object names a systemMessage field at all (any value). Used
# together with has_permission_decision below to allowlist a second shape
# plan-gate.sh may forward: a bare notice, such as partial-coverage or
# round-limit disclosure, that carries no permission decision of any kind.
has_system_message() {
  local s="$1"
  s=${s// /}
  s=${s//$'\n'/}
  s=${s//$'\t'/}
  s=${s//$'\r'/}
  [ "${s#*\"systemMessage\":}" != "$s" ]
}

# True when a JSON object names a permissionDecision field at all, regardless of
# its value. Deliberately broader than is_deny_decision: a verdict that carries
# any permissionDecision -- deny (already forwarded on its own), allow, or an
# escaped/unrecognized value -- must never additionally be forwarded as a bare
# notice. Fail-safe means the notice path requires proven absence of this field,
# not merely a failed match against "allow" or "deny".
has_permission_decision() {
  local s="$1"
  s=${s// /}
  s=${s//$'\n'/}
  s=${s//$'\t'/}
  s=${s//$'\r'/}
  [ "${s#*\"permissionDecision\":}" != "$s" ]
}

# True when the payload contains a \uXXXX escape anywhere. JSON permits spelling any
# character this way, which is exactly what defeats the literal-bytes matching above:
# a payload can decode to "permissionDecision":"allow" while never containing those
# literal bytes (escape the key, the value, or both) -- and, on a duplicate key,
# whichever decoder reads it last wins, so an escaped duplicate can silently override
# even a literal "deny". Neither is_deny_decision's nor has_permission_decision's
# match can be trusted against such a payload, so plan-gate.sh must gate both the
# deny and the notice branch on this, not treat a failed literal match as proof of
# anything.
has_unicode_escape() {
  local s="$1"
  s=${s// /}
  s=${s//$'\n'/}
  s=${s//$'\t'/}
  s=${s//$'\r'/}
  case "$s" in
    *'\u'[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]*) return 0 ;;
  esac
  return 1
}

# True when the payload names permissionDecision twice in plain bytes, with no
# escape needed. A decoder resolving duplicate keys last-wins (as Claude Code's
# does) reads whichever value comes last, so a literal "deny" followed by a
# second, literal permissionDecision key decodes to that second value even
# though is_deny_decision's literal-bytes match is satisfied by the first
# occurrence alone. has_unicode_escape does not catch this -- nothing here is
# escaped -- so check for the duplicate explicitly, on the same fail-safe
# footing: cut at the first permissionDecision key and look for a second.
has_duplicate_permission_decision() {
  local s="$1"
  s=${s// /}
  s=${s//$'\n'/}
  s=${s//$'\t'/}
  s=${s//$'\r'/}
  local rest="${s#*\"permissionDecision\":}"
  [ "$rest" = "$s" ] && return 1
  [ "${rest#*\"permissionDecision\":}" != "$rest" ]
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

# --- Stop hook output (impl-gate.sh) ---
#
# Stop's decision control is NOT hookSpecificOutput.permissionDecision -- it is
# a top-level `decision`/`reason` pair, `{"decision":"block","reason":"..."}`,
# verified against https://code.claude.com/docs/en/hooks (Stop decision
# control), not assumed from the PreToolUse/ExitPlanMode precedent these
# PreToolUse emitters above were verified against. `actual impl-check
# --claude-hook` reuses plan-check's own JSON renderer, which always emits a
# PreToolUse-shaped hookSpecificOutput regardless of which Claude Code event is
# asking -- forwarded verbatim to Stop, that shape carries no `decision` field
# at all, so Claude Code would silently ignore it and let the turn end. Every
# function below therefore re-renders rather than forwards.

# Extract the value of the first top-level "<field>":"..." string in a JSON
# document, as a quote-aware byte scan -- never a JSON parse, matching this
# library's dependency-hygiene constraint (see the file header). The returned
# value is still JSON-string-escaped exactly as it appeared in $1: callers
# that copy it into a *_raw emitter below must not run it through json_escape
# again, or they will double-escape it.
#
# Callers MUST gate this on has_unicode_escape/has_duplicate_permission_decision
# returning false first (impl-gate.sh always does, via render_stop_verdict):
# a \uXXXX escape spells a literal double-quote a byte scan cannot see, so
# this function's quote-termination logic can only be trusted once those
# checks have ruled that out. Prints nothing and fails (exit 1) when the
# field is absent.
extract_json_string_field() {
  local s="$1" field="$2" needle rest out c i len
  needle="\"${field}\":\""
  rest="${s#*"$needle"}"
  [ "$rest" = "$s" ] && return 1

  out=""
  i=0
  len=${#rest}
  while [ "$i" -lt "$len" ]; do
    c="${rest:$i:1}"
    if [ "$c" = '\' ]; then
      # A backslash always introduces a single-char escape here (\\, \", \n,
      # \t, \r, \/, \b, \f) -- \uXXXX is excluded by the caller-side gate
      # above -- so consume it and the next byte together, verbatim, and
      # never test that next byte as a potential terminating quote.
      out="${out}${c}${rest:$((i + 1)):1}"
      i=$((i + 2))
      continue
    fi
    if [ "$c" = '"' ]; then
      printf '%s' "$out"
      return 0
    fi
    out="${out}${c}"
    i=$((i + 1))
  done
  return 1
}

# Stop's one blocking shape: top-level decision:"block" with a required
# reason (see the section comment above for why this differs from
# emit_pretooluse_notice's shape). $1 has already been extracted from another
# JSON document's string value via extract_json_string_field and is therefore
# already valid JSON-string-escaped bytes -- running it through json_escape
# here would double-escape it. (render_stop_verdict is impl-gate.sh's only
# caller today, and every reason it blocks with comes from extraction; a
# script-composed, not-yet-escaped reason would need a json_escape'd sibling
# of this function, which does not exist because nothing needs it yet.)
emit_stop_block_raw() {
  printf '{"decision":"block","reason":"%s"}\n' "$1"
}

# Advisory for a Stop hook that must NOT force continuation. Stop's only two
# channels that reach Claude -- decision:"block" and
# hookSpecificOutput.additionalContext -- both force continuation ("the same
# loop protections as decision: block", per the docs); neither is safe for a
# fail-open notice that must let the turn end normally. So this emits a plain,
# user-facing systemMessage and nothing else -- unlike
# emit_pretooluse_notice, there is no agent-facing counterpart here to also
# populate.
emit_stop_notice() {
  printf '{"systemMessage":"%s"}\n' "$(json_escape "$1")"
}

# Same shape, but $1 is already JSON-string-escaped (see emit_stop_block_raw).
emit_stop_notice_raw() {
  printf '{"systemMessage":"%s"}\n' "$1"
}

# Classify and re-render `actual impl-check --claude-hook`'s PreToolUse-shaped
# stdout ($1) into Stop's own JSON contract, printing the result (or nothing)
# to stdout. Mirrors the allowlist plan-gate.sh applies inline to its own
# verdict -- see that script's comments for the full rationale -- but ends in
# a re-render instead of a forward, and the deny branch here requires the
# reason to be safely extractable, not just present.
render_stop_verdict() {
  local verdict="$1" trimmed reason message

  trimmed=${verdict#"${verdict%%[![:space:]]*}"}
  trimmed=${trimmed%"${trimmed##*[![:space:]]}"}

  if [ "${trimmed#\{}" != "$trimmed" ] && [ "${trimmed%\}}" != "$trimmed" ]; then
    if has_unicode_escape "$trimmed" || has_duplicate_permission_decision "$trimmed"; then
      emit_stop_notice \
        "Actual implementation governance received a verdict it could not safely interpret (it contained an escaped character sequence or a duplicate permissionDecision key); this turn's diff was not checked against .actual/rules/."
    elif is_deny_decision "$trimmed"; then
      reason=$(extract_json_string_field "$verdict" "permissionDecisionReason") || reason=""
      if [ -n "$reason" ]; then
        emit_stop_block_raw "$reason"
      else
        emit_stop_notice \
          "Actual implementation governance denied this diff, but the reason could not be safely read; this turn's diff was not checked against .actual/rules/."
      fi
    elif has_system_message "$trimmed" && ! has_permission_decision "$trimmed"; then
      message=$(extract_json_string_field "$verdict" "systemMessage") || message=""
      [ -n "$message" ] && emit_stop_notice_raw "$message"
    fi
  fi
}
