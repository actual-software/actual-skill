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

# Prints the allow decision when $1, the raw payload, is a Bash call of exactly
# the report-use form. Returns 1, printing nothing, otherwise.
allow_report_use() {
  local LC_ALL=C
  local payload="$1" tool command rest re word flag i
  local -a words
  has_unicode_escape "$payload" && return 1
  tool=$(extract_json_string_field "$payload" "tool_name") || return 1
  [ "$tool" = "Bash" ] || return 1
  rest="${payload#*\"command\"}"
  [ "$rest" != "$payload" ] || return 1
  [ "${rest#*\"command\"}" = "$rest" ] || return 1
  command=$(extract_json_string_field "$payload" "command") || return 1
  case "$command" in *\\*) return 1 ;; esac

  re='^actual rules report-use( [A-Za-z0-9._/:=@+,-]+)+$'
  [[ "$command" =~ $re ]] || return 1

  read -r -a words <<<"$command"
  local session="" turn=""
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
      --claude-session) session="$word" ;;
      --turn) turn="$word" ;;
    esac
    i=$((i + 2))
  done
  [ -n "$session" ] && [ -n "$turn" ] || return 1

  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Actual: the agent is recording which ADRs shaped this turn (actual rules report-use)."}}'
}

allow_report_use "$payload"
exit 0
