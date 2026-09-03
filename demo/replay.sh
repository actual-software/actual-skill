#!/usr/bin/env bash
# replay.sh - Deterministic, scripted proof of the block -> feedback -> revise loop.
#
# Drives the REAL hook with two recorded plans and the same content-aware plan-check
# stand-in the live demo uses. No agent, no model, no network -- so it produces the
# same output every time.
#
# Use it to rehearse, to show the loop when the live demo has no time budget, and as
# the fallback if the live agent declines to propose the violating plan (which it is
# entitled to do -- it can see the repository pattern in the code).

set -uo pipefail

DEMO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HOOK="${DEMO_DIR}/../hooks/plan-gate.sh"

WORK=$(mktemp -d "${TMPDIR:-/tmp}/actual-demo-replay.XXXXXX") || exit 1
trap 'rm -rf "$WORK"' EXIT
LOG="${WORK}/rounds.log"

cp -R "${DEMO_DIR}/repo/." "$WORK/"
mkdir -p "$WORK/.actual"
mv "$WORK/rules" "$WORK/.actual/rules"
: > "$LOG"

# Read the decision out of a hook response. An EMPTY response is the "no decision"
# case (the gate never forwards allow), and jq given no input prints nothing at all,
# so `// "none"` cannot cover it -- handle empty before calling jq.
decision_of() {
  [ -n "$1" ] || { printf 'none'; return 0; }
  printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // "none"'
}

rule() { printf '\n\033[1m%s\033[0m\n%s\n' "$1" "$(printf '%.0s-' $(seq 1 ${#1}))"; }

send() {
  jq -nc --arg p "$(cat "$1")" \
    '{hook_event_name:"PreToolUse",tool_name:"ExitPlanMode",tool_input:{plan:$p}}' \
  | env SCENARIO_LOG="$LOG" PATH="${DEMO_DIR}/bin:${PATH}" CLAUDE_PROJECT_DIR="$WORK" \
        bash "$HOOK"
}

rule "Round 1 - the agent proposes SQL directly in the handler"
sed -n '/## Approach/,$p' "${DEMO_DIR}/fixtures/plan-round1-violating.md" | sed 's/^/  /'
out1=$(send "${DEMO_DIR}/fixtures/plan-round1-violating.md")
dec1=$(decision_of "$out1")
printf '\n  >> hook decision: \033[1;31m%s\033[0m\n\n' "$dec1"
printf '%s' "$out1" | jq -r '.hookSpecificOutput.permissionDecisionReason // empty' | sed 's/^/  /'

rule "Round 2 - the agent revises: the query moves into the repository"
sed -n '/## Approach/,$p' "${DEMO_DIR}/fixtures/plan-round2-revised.md" | sed 's/^/  /'
out2=$(send "${DEMO_DIR}/fixtures/plan-round2-revised.md")
dec2=$(decision_of "$out2")
printf '\n  >> hook decision: \033[1;32m%s\033[0m  (no decision = normal approval dialog)\n' "$dec2"

rule "Round log"
sed 's/^/  /' "$LOG"

echo
if [ "$dec1" = "deny" ] && [ "$dec2" = "none" ]; then
  printf '\033[1;32mPASS\033[0m  conflicting plan blocked, revised plan allowed through.\n'
  exit 0
fi
printf '\033[1;31mFAIL\033[0m  expected deny then none; got %s then %s.\n' "$dec1" "$dec2"
exit 1
