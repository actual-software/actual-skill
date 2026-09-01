#!/usr/bin/env bash
# run.sh - Live demo of the plan-stage governance gate.
#
# Every run starts from an identical, freshly materialized scratch repo, so the demo
# is repeatable: no leftover git state, no stale log, no edits from the last run.
#
# All paths are derived from this script's own location, so a teammate can clone the
# repo and run ./demo/run.sh with no edits.

set -uo pipefail

DEMO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PLUGIN_ROOT=$(cd -- "${DEMO_DIR}/.." && pwd)

WORK="${ACTUAL_DEMO_DIR:-${TMPDIR:-/tmp}/actual-plan-gate-demo}"
LOG="${WORK}/rounds.log"

# --- Fresh scratch repo every run ---
rm -rf "$WORK"
mkdir -p "$WORK"
cp -R "${DEMO_DIR}/repo/." "$WORK/"
mkdir -p "$WORK/.actual"
mv "$WORK/rules" "$WORK/.actual/rules"

# Its own git repo, so it is never confused with the plugin checkout and so the
# hook's repo-root resolution is unambiguous.
git -C "$WORK" init -q
git -C "$WORK" add -A
git -C "$WORK" -c user.email=demo@example.com -c user.name=demo commit -qm "Demo service with data-access layering ADR"

: > "$LOG"

cat <<BANNER

  Actual plan-stage governance - live demo
  ---------------------------------------
  scratch repo : $WORK
  rule set     : 1 file (R-001 MUST: persistence goes through src/repositories/)
  plan-check   : ${DEMO_DIR}/bin/actual  (content-aware stand-in for AK-676)
  round log    : $LOG

  1. Expect a startup line: governance active, 1 rule file.
  2. Press Shift+Tab until you are in plan mode.
  3. Paste the prompt below (copied to your clipboard on macOS).
  4. Expect NO approval dialog on the first ExitPlanMode - the plan is blocked,
     the agent is told which rule it broke, and it revises.
  5. The second ExitPlanMode should show the approval dialog normally.

  Afterwards:  cat "$LOG"

BANNER

PROMPT=$(cat "${DEMO_DIR}/PROMPT.md")
printf '  ----- prompt to paste -----\n\n%s\n\n  ---------------------------\n\n' "$PROMPT"
command -v pbcopy >/dev/null 2>&1 && printf '%s' "$PROMPT" | pbcopy && echo "  (copied to clipboard)"
echo

# --dry-run sets the scenario up and reports what it would launch, without starting
# a session. Use it to rehearse, to verify a teammate's checkout, or in CI.
if [ "${1:-}" = "--dry-run" ]; then
  printf '  DRY RUN - not launching claude\n'
  printf '  would run: cd %s && claude --plugin-dir %s\n' "$WORK" "$PLUGIN_ROOT"
  printf '  rules found: %s\n' "$(ls -1 "$WORK/.actual/rules" | wc -l | tr -d ' ')"
  printf '  plan-check on PATH: %s\n' "$(PATH="${DEMO_DIR}/bin:${PATH}" command -v actual)"
  PATH="${DEMO_DIR}/bin:${PATH}" actual plan-check --help >/dev/null 2>&1 \
    && printf '  plan-check capability probe: ok\n' \
    || printf '  plan-check capability probe: FAILED\n'
  exit 0
fi

cd "$WORK" || exit 1
exec env SCENARIO_LOG="$LOG" PATH="${DEMO_DIR}/bin:${PATH}" \
  claude --plugin-dir "$PLUGIN_ROOT" "$@"
