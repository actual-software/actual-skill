#!/usr/bin/env bash
# run.sh - Test harness for the actual plan-stage governance hooks.
#
# Exercises the shell decision logic end to end against recorded hook payloads and
# a fake `actual` CLI (bin/actual). No network, no real CLI, no plugin install.
#
# Unlike the shipped hooks, this harness may use jq -- it is a development tool.
# The hooks themselves must stay dependency-free; the dependency-hygiene check
# below enforces that.
#
# Usage: bash hooks/tests/run.sh

set -uo pipefail

TESTS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HOOKS_DIR=$(cd -- "${TESTS_DIR}/.." && pwd)
FIXTURES="${TESTS_DIR}/fixtures"

pass_count=0
fail_count=0

pass() { printf '  [PASS] %s\n' "$1"; pass_count=$((pass_count + 1)); }
fail() { printf '  [FAIL] %s\n' "$1"; printf '         %s\n' "${2:-}"; fail_count=$((fail_count + 1)); }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/actual-hook-tests.XXXXXX") || exit 1
trap 'rm -rf "$WORK"' EXIT

REPO_WITH_RULES="${WORK}/with-rules"
REPO_NO_RULES="${WORK}/no-rules"
mkdir -p "${REPO_WITH_RULES}/.actual/rules" "${REPO_NO_RULES}" "${WORK}/empty-bin"
cat > "${REPO_WITH_RULES}/.actual/rules/cross-cutting-persistence-abc123.md" <<'EOF'
# Persistence

These rules are ALWAYS ACTIVE for all data access code in the project.

### Rules
**R-001** MUST: all persistence goes through the repository layer.
EOF

# Materialize fixtures with real absolute paths substituted in.
RESOLVED="${WORK}/fixtures"
mkdir -p "$RESOLVED"
for f in "${FIXTURES}"/*; do
  base=$(basename "$f")
  sed -e "s|__FIXTURE_DIR__|${RESOLVED}|g" -e "s|__REPO_ROOT__|${REPO_WITH_RULES}|g" "$f" > "${RESOLVED}/${base}"
done

run_hook() {
  local script="$1" payload="$2" project_dir="$3"
  shift 3
  local status
  env -u ACTUAL_RULES_DIR -u ACTUAL_PLAN_GATE \
      PATH="${TESTS_DIR}/bin:${PATH}" \
      CLAUDE_PROJECT_DIR="$project_dir" \
      "$@" \
      bash "$script" < "$payload" > "${WORK}/out" 2> "${WORK}/err"
  status=$?
  printf '%s' "$status"
}

# Same, but with no `actual` on PATH at all. PATH still carries the standard system
# utilities the hook legitimately needs (cat, git, mktemp) -- stripping those would
# test a condition that cannot occur, not a missing CLI.
run_hook_no_cli() {
  local script="$1" payload="$2" project_dir="$3"
  local status
  env -u ACTUAL_RULES_DIR -u ACTUAL_PLAN_GATE \
      PATH="${WORK}/empty-bin:/usr/bin:/bin" \
      CLAUDE_PROJECT_DIR="$project_dir" \
      bash "$script" < "$payload" > "${WORK}/out" 2> "${WORK}/err"
  status=$?
  printf '%s' "$status"
}

decision() {
  if [ ! -s "${WORK}/out" ]; then
    printf 'none'
    return
  fi
  jq -r '.hookSpecificOutput.permissionDecision // "none"' < "${WORK}/out" 2>/dev/null || printf 'unparseable'
}

echo
echo "=== plan-gate: no committed rules ==="
for shape in inline file; do
  st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-${shape}.json" "$REPO_NO_RULES" ACTUAL_TEST_MODE=deny)
  if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
    pass "plan-${shape}: silent no-op (exit 0, no stdout, no stderr)"
  else
    fail "plan-${shape}: expected silent exit 0" "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err")"
  fi
done

echo
echo "=== plan-gate: CLI bootstrap preflight ==="

st=$(run_hook_no_cli "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES")
if [ "$st" = "0" ] && grep -q "npm install -g @actualai/actual" "${WORK}/out"; then
  pass "missing binary: exit 0 with install guidance"
else
  fail "missing binary: expected exit 0 + install matrix" "status=$st stdout=$(cat "${WORK}/out")"
fi

if [ "$(decision)" = "none" ]; then
  pass "missing binary: makes no permission decision"
else
  fail "missing binary: must not decide (a decision would grant ExitPlanMode)" "decision=$(decision)"
fi

st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=no-plan-check)
if [ "$st" = "0" ] && grep -q 'no .plan-check. subcommand' "${WORK}/out"; then
  pass "old CLI: exit 0 with upgrade guidance, not a flag error"
else
  fail "old CLI: expected exit 0 + upgrade message" "status=$st stdout=$(cat "${WORK}/out")"
fi

if [ "$(decision)" = "none" ]; then
  pass "old CLI: makes no permission decision"
else
  fail "old CLI: must not decide" "decision=$(decision)"
fi

echo
echo "=== plan-gate: verdict passthrough ==="
for shape in inline file; do
  st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-${shape}.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=allow)
  if [ "$st" = "0" ] && [ "$(decision)" = "none" ] && [ ! -s "${WORK}/out" ]; then
    pass "plan-${shape}: conforming plan makes no permission decision"
  else
    fail "plan-${shape}: expected silent pass (no decision)" "status=$st decision=$(decision) stdout=$(cat "${WORK}/out")"
  fi

  st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-${shape}.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny)
  if [ "$st" = "0" ] && [ "$(decision)" = "deny" ] && grep -q "R-001" "${WORK}/out"; then
    pass "plan-${shape}: deny verdict passed through, names the rule id"
  else
    fail "plan-${shape}: expected deny naming R-001" "status=$st decision=$(decision)"
  fi
done

st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny-exit2)
if [ "$st" = "2" ] && grep -q "R-001" "${WORK}/err"; then
  pass "exit-2 fallback: blocks with the reason on stderr"
else
  fail "exit-2 fallback: expected exit 2 + stderr reason" "status=$st stderr=$(cat "${WORK}/err")"
fi

st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=emit-allow)
if [ "$st" = "0" ] && [ "$(decision)" = "none" ]; then
  pass "CLI allow verdict is not forwarded (leaves the approval dialog intact)"
else
  fail "allow must not be forwarded" "status=$st decision=$(decision) stdout=$(cat "${WORK}/out")"
fi

echo
echo "=== plan-gate: envelope passthrough ==="
CAPTURE="${WORK}/captured.json"
st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=allow ACTUAL_TEST_CAPTURE="$CAPTURE")
if [ -s "$CAPTURE" ] \
   && [ "$(jq -r '.tool_name' "$CAPTURE")" = "ExitPlanMode" ] \
   && [ "$(jq -r '.prompt_id' "$CAPTURE")" = "feb8f53b-f97b-4b59-a872-5d0a38b8dd11" ] \
   && [ -f "$(jq -r '.transcript_path' "$CAPTURE")" ]; then
  pass "raw envelope reaches the CLI with prompt_id and a readable transcript_path"
else
  fail "envelope passthrough broken" "captured=$(cat "$CAPTURE" 2>/dev/null)"
fi

resolved_plan=$(jq -r 'select(.attachment.type=="plan_mode") | .attachment.planFilePath' "${RESOLVED}/transcript-plan-file.jsonl" 2>/dev/null | tail -1)
if [ -n "$resolved_plan" ] && [ -f "$resolved_plan" ] && grep -q "Redis cache" "$resolved_plan"; then
  pass "plan-file shape: plan text resolvable via transcript plan_mode attachment"
else
  fail "plan-file shape: could not resolve plan via transcript" "resolved=$resolved_plan"
fi

inline_plan=$(jq -r '.tool_input.plan // ""' "${RESOLVED}/pretooluse-plan-inline.json")
if printf '%s' "$inline_plan" | grep -q "Redis cache"; then
  pass "plan-inline shape: plan text present in tool_input.plan"
else
  fail "plan-inline shape: tool_input.plan missing" ""
fi

echo
echo "=== plan-gate: fail open ==="
for mode in crash garbage; do
  st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE="$mode")
  if [ "$st" = "0" ] && [ "$(decision)" != "deny" ]; then
    pass "$mode: fails open (exit 0, no deny)"
  else
    fail "$mode: expected fail-open exit 0" "status=$st decision=$(decision)"
  fi
done

st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny ACTUAL_PLAN_GATE=off)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
  pass "ACTUAL_PLAN_GATE=off: silent no-op even with a deny verdict available"
else
  fail "opt-out did not disable the gate" "status=$st stdout=$(cat "${WORK}/out")"
fi

echo
echo "=== preflight: SessionStart ==="
st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_NO_RULES" ACTUAL_TEST_MODE=allow)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
  pass "no rules: silent"
else
  fail "no rules: expected silence" "status=$st stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=allow)
ctx=$(jq -r '.hookSpecificOutput.additionalContext // ""' < "${WORK}/out" 2>/dev/null)
if [ "$st" = "0" ] && [ "$(jq -r '.hookSpecificOutput.hookEventName' < "${WORK}/out" 2>/dev/null)" = "SessionStart" ] \
   && printf '%s' "$ctx" | grep -q "1 rule file"; then
  pass "rules + working CLI: reports governance active with the rule count"
else
  fail "healthy preflight context wrong" "status=$st stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook_no_cli "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES")
if [ "$st" = "0" ] && grep -q "brew install actual-software/actual/actual" "${WORK}/out"; then
  pass "rules + no CLI: install matrix as session context"
else
  fail "missing-CLI preflight wrong" "status=$st stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=no-plan-check)
if [ "$st" = "0" ] && grep -q "brew upgrade" "${WORK}/out"; then
  pass "rules + old CLI: upgrade guidance as session context"
else
  fail "old-CLI preflight wrong" "status=$st stdout=$(cat "${WORK}/out")"
fi

echo
echo "=== rules directory override ==="
env ACTUAL_RULES_DIR="${REPO_WITH_RULES}/.actual/rules" \
    PATH="${TESTS_DIR}/bin:${PATH}" CLAUDE_PROJECT_DIR="$REPO_NO_RULES" ACTUAL_TEST_MODE=deny \
    bash "${HOOKS_DIR}/plan-gate.sh" < "${RESOLVED}/pretooluse-plan-file.json" > "${WORK}/out" 2>"${WORK}/err"
st=$?
if [ "$st" = "0" ] && [ "$(decision)" = "deny" ]; then
  pass "ACTUAL_RULES_DIR points the gate at another directory"
else
  fail "ACTUAL_RULES_DIR override ignored" "status=$st decision=$(decision)"
fi

echo
echo "=== dependency hygiene ==="
if grep -nE '(^|[^-_[:alnum:]])(jq|python3?|node)([^-_[:alnum:]]|$)' \
     "${HOOKS_DIR}/plan-gate.sh" "${HOOKS_DIR}/preflight.sh" "${HOOKS_DIR}/lib/bootstrap.sh" \
     | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' > "${WORK}/deps" 2>/dev/null; then
  fail "shipped hooks reference a JSON/runtime dependency" "$(cat "${WORK}/deps")"
else
  pass "shipped hooks reference no jq/python/node"
fi

for f in "${HOOKS_DIR}/plan-gate.sh" "${HOOKS_DIR}/preflight.sh"; do
  if [ -x "$f" ]; then pass "$(basename "$f") is executable"; else fail "$(basename "$f") is not executable" ""; fi
done

echo
echo "=== Summary ==="
printf '  %s passed, %s failed\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ]
