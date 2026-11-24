#!/usr/bin/env bash
# report-use-allow.sh - PreToolUse hook on Bash: lets the agent answer the Stop
# hook's ADR question without a permission prompt.
#
# After a turn that changed files, impl-gate.sh asks the agent which of the
# session's ADRs it used, and the agent answers by running
# `actual rules report-use ...`. In Claude Code's default mode that Bash call
# would ask the user's permission every turn. This hook allows exactly that
# command and nothing else: the words `actual rules report-use`, then only the
# flags report-use takes, each value made of letters, digits and `._/:=@+,-`.
# A command holding anything else -- a pipe, `;`, `&&`, `$(...)`, a redirect,
# a quote, a glob, a newline, an env assignment, another flag -- gets no
# decision from this hook, so Claude Code's normal permission flow applies.
#
# The grant is also scoped to the question it answers: --repo must be this
# session's repository root, --rules-dir (when given) must sit inside it, both
# must be absolute with no `..` component (the CLI never writes one),
# --claude-session must be this session's id, and the repository must have
# committed rules, since a repository without them is never asked. Anything
# else gets no decision.
#
# It runs on every Bash call, so a payload that cannot hold the command, or one
# too large for it, is turned away before any per-character work.
#
# The payload is scanned, never parsed (dependency-free, like every hook here),
# so the same guards render_stop_verdict relies on come first: no \uXXXX escape
# anywhere, exactly one "command" key, and no backslash in its value. A JSON
# escape in the command means it holds a character this hook never allows.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

payload=$(cat)

if [ "${ACTUAL_PLAN_GATE:-on}" = "off" ] || inside_actual_subprocess; then
  exit 0
fi

# The CLI's ADR refresh runs first, on a tool call's time box, as in every hook
# but session-end.sh (lib/bootstrap.sh). Its news waits for the next prompt.
adr_refresh_first tool

# Larger than any answer the CLI asks for, and small enough that the scan
# below stays well inside the hook's timeout.
REPORT_USE_MAX_PAYLOAD=8192

# True when $1 names the key $2 exactly once.
has_one_key() {
  local key="\"$2\"" rest
  rest="${1#*"$key"}"
  [ "$rest" != "$1" ] && [ "${rest#*"$key"}" = "$rest" ]
}

# True when $1 is an absolute path with no `..` component.
plain_absolute_path() {
  case "$1" in /*) ;; *) return 1 ;; esac
  case "$1" in */..|*/../*) return 1 ;; esac
}

# Prints the allow decision when $1, the raw payload, is a Bash call of exactly
# the report-use form. Returns 1, printing nothing, otherwise.
allow_report_use() {
  local LC_ALL=C
  local payload="$1" tool command re word flag i
  local -a words
  case "$payload" in
    *'"command":"actual rules report-use '*|*'"command": "actual rules report-use '*) ;;
    *) return 1 ;;
  esac
  [ "${#payload}" -le "$REPORT_USE_MAX_PAYLOAD" ] || return 1
  has_unicode_escape "$payload" && return 1
  tool=$(extract_json_string_field "$payload" "tool_name") || return 1
  [ "$tool" = "Bash" ] || return 1
  has_one_key "$payload" "command" || return 1
  has_one_key "$payload" "session_id" || return 1
  command=$(extract_json_string_field "$payload" "command") || return 1
  case "$command" in *\\*) return 1 ;; esac

  re='^actual rules report-use( [A-Za-z0-9._/:=@+,-]+)+$'
  [[ "$command" =~ $re ]] || return 1

  read -r -a words <<<"$command"
  local session="" turn="" repo="" rules=""
  i=3
  while [ "$i" -lt "${#words[@]}" ]; do
    flag="${words[$i]}"
    case "$flag" in
      --none)
        i=$((i + 1))
        continue
        ;;
      --claude-session|--turn|--repo|--rules-dir|--claim|--plan-claim) ;;
      *) return 1 ;;
    esac
    word="${words[$((i + 1))]:-}"
    case "$word" in ''|-*) return 1 ;; esac
    case "$flag" in
      --claude-session) [ -z "$session" ] || return 1; session="$word" ;;
      --turn) [ -z "$turn" ] || return 1; turn="$word" ;;
      --repo) [ -z "$repo" ] || return 1; repo="$word" ;;
      --rules-dir) [ -z "$rules" ] || return 1; rules="$word" ;;
    esac
    i=$((i + 2))
  done
  [ -n "$session" ] && [ -n "$turn" ] && [ -n "$repo" ] || return 1

  local session_id root canon
  session_id=$(extract_json_string_field "$payload" "session_id") || return 1
  [ "$session" = "$session_id" ] || return 1

  plain_absolute_path "$repo" || return 1
  root=$(canonical_dir "$(resolve_repo_root)") || return 1
  canon=$(canonical_dir "$repo") || return 1
  [ "$canon" = "$root" ] || return 1
  if [ -n "$rules" ]; then
    plain_absolute_path "$rules" || return 1
    canon=$(canonical_dir "$rules") || return 1
    is_within "$root" "$canon" || return 1
  fi
  rules_present "$(rules_dir "$root")" || return 1

  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Actual: the agent is recording which ADRs shaped this turn (actual rules report-use)."}}'
}

allow_report_use "$payload"
exit 0
