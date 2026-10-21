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
# Physical path: on macOS TMPDIR sits under the /var -> /private/var symlink, and the
# hooks canonicalize the roots they resolve. Comparing a forwarded --rules-dir against
# a logical path would fail on that symlink alone.
WORK=$(cd "$WORK" && pwd -P) || exit 1

REPO_WITH_RULES="${WORK}/with-rules"
REPO_NO_RULES="${WORK}/no-rules"
mkdir -p "${REPO_WITH_RULES}/.actual/rules" "${REPO_NO_RULES}" "${WORK}/empty-bin"
# Real git repos, so resolve_repo_root's `git rev-parse` branch is deterministic
# no matter where TMPDIR lives (a TMPDIR nested inside a checkout would otherwise
# resolve to that outer repo and make the fallback tests flaky).
git -C "${REPO_WITH_RULES}" init -q
git -C "${REPO_NO_RULES}" init -q
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

# Run a hook the way Claude Code does in an ordinary session: from inside the
# project directory. Root resolution reads cwd (a worktree keeps CLAUDE_PROJECT_DIR
# on the original checkout), so a harness that ran hooks from an unrelated cwd would
# be exercising a configuration Claude Code never produces. Tests that deliberately
# separate the two use run_hook_cwd.
run_hook() {
  local script="$1" payload="$2" project_dir="$3"
  shift 3
  local status workdir="$PWD"
  [ -d "$project_dir" ] && workdir="$project_dir"
  ( cd "$workdir" || exit 1
    env -u ACTUAL_RULES_DIR -u ACTUAL_PLAN_GATE -u ACTUAL_CLI_SUBPROCESS -u ACTUAL_SKILL_MOD_SESSION \
        PATH="${TESTS_DIR}/bin:${PATH}" \
        CLAUDE_PROJECT_DIR="$project_dir" \
        "$@" \
        bash "$script" < "$payload" > "${WORK}/out" 2> "${WORK}/err" )
  status=$?
  printf '%s' "$status"
}

# Same, but with no `actual` on PATH at all. PATH still carries the standard system
# utilities the hook legitimately needs (cat, git, mktemp) -- stripping those would
# test a condition that cannot occur, not a missing CLI.
run_hook_no_cli() {
  local script="$1" payload="$2" project_dir="$3"
  local status workdir="$PWD"
  [ -d "$project_dir" ] && workdir="$project_dir"
  ( cd "$workdir" || exit 1
    env -u ACTUAL_RULES_DIR -u ACTUAL_PLAN_GATE -u ACTUAL_CLI_SUBPROCESS -u ACTUAL_SKILL_MOD_SESSION \
        PATH="${WORK}/empty-bin:/usr/bin:/bin" \
        CLAUDE_PROJECT_DIR="$project_dir" \
        bash "$script" < "$payload" > "${WORK}/out" 2> "${WORK}/err" )
  status=$?
  printf '%s' "$status"
}

# Run a hook from an explicit working directory, with CLAUDE_PROJECT_DIR set to an
# arbitrary value. Used to exercise the resolve_repo_root fallback chain, which only
# consults git/$PWD when CLAUDE_PROJECT_DIR is unset or does not name a directory.
run_hook_cwd() {
  local script="$1" payload="$2" project_dir="$3" workdir="$4"
  shift 4
  local status
  ( cd "$workdir" || exit 1
    env -u ACTUAL_RULES_DIR -u ACTUAL_PLAN_GATE -u ACTUAL_CLI_SUBPROCESS -u ACTUAL_SKILL_MOD_SESSION \
        PATH="${TESTS_DIR}/bin:${PATH}" \
        CLAUDE_PROJECT_DIR="$project_dir" \
        "$@" \
        bash "$script" < "$payload" > "${WORK}/out" 2> "${WORK}/err" )
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

# Stop's decision field is top-level, not nested under hookSpecificOutput --
# see impl-gate.sh's module comment. Distinct helper from decision() above so
# a test that reads the wrong field shape fails loudly instead of silently
# matching "none".
stop_decision() {
  if [ ! -s "${WORK}/out" ]; then
    printf 'none'
    return
  fi
  jq -r '.decision // "none"' < "${WORK}/out" 2>/dev/null || printf 'unparseable'
}

# Print the argv token after FLAG in a capture sidecar written by bin/actual.
argv_after() {
  local flag="$1" file="$2"
  awk -v f="$flag" '$0==f{getline; print; exit}' "$file"
}

echo
echo "=== plan-gate: no committed rules ==="
for shape in injected inline file; do
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

if grep -q "Offer to install it now" "${WORK}/out" && grep -q "ask using an interactive question tool" "${WORK}/out"; then
  pass "missing binary: instructs the agent to offer installing, not just describe it"
else
  fail "missing binary: expected an offer-to-install instruction" "stdout=$(cat "${WORK}/out")"
fi

if grep -q "regardless of what else is in progress" "${WORK}/out" && grep -q "your very next reply" "${WORK}/out"; then
  pass "missing binary: instructs the agent to surface this even mid-task"
else
  fail "missing binary: expected the mid-task interrupt instruction" "stdout=$(cat "${WORK}/out")"
fi

if grep -q "AskUserQuestion" "${WORK}/out" && grep -q "does not satisfy this" "${WORK}/out"; then
  pass "missing binary: instructs the agent to wait for an actual answer, not just mention it"
else
  fail "missing binary: expected the wait-for-answer instruction" "stdout=$(cat "${WORK}/out")"
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

if grep -q "Offer to upgrade it now" "${WORK}/out" && grep -q "ask using an interactive question tool" "${WORK}/out"; then
  pass "old CLI: instructs the agent to offer upgrading, not just describe it"
else
  fail "old CLI: expected an offer-to-upgrade instruction" "stdout=$(cat "${WORK}/out")"
fi

if grep -q "regardless of what else is in progress" "${WORK}/out" && grep -q "your very next reply" "${WORK}/out"; then
  pass "old CLI: instructs the agent to surface this even mid-task"
else
  fail "old CLI: expected the mid-task interrupt instruction" "stdout=$(cat "${WORK}/out")"
fi

if grep -q "AskUserQuestion" "${WORK}/out" && grep -q "does not satisfy this" "${WORK}/out"; then
  pass "old CLI: instructs the agent to wait for an actual answer, not just mention it"
else
  fail "old CLI: expected the wait-for-answer instruction" "stdout=$(cat "${WORK}/out")"
fi

if [ "$(decision)" = "none" ]; then
  pass "old CLI: makes no permission decision"
else
  fail "old CLI: must not decide" "decision=$(decision)"
fi

echo
echo "=== plan-gate: verdict passthrough ==="
for shape in injected inline file; do
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

# clap rejecting the invocation (here, an invalid ACTUAL_IMPL_CHECK_MAX_ROUNDS)
# exits 2 too, but it is not a deny: fail open with a notice naming the error.
st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=usage-error)
if [ "$st" = "0" ] && [ "$(decision)" = "none" ] && grep -q "rejected its invocation: error: invalid value" "${WORK}/out"; then
  pass "CLI usage error at exit 2 fails open with a notice, not a block"
else
  fail "CLI usage error must fail open" "status=$st decision=$(decision) stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err")"
fi

st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=emit-allow)
if [ "$st" = "0" ] && [ "$(decision)" = "none" ]; then
  pass "CLI allow verdict is not forwarded (leaves the approval dialog intact)"
else
  fail "allow must not be forwarded" "status=$st decision=$(decision) stdout=$(cat "${WORK}/out")"
fi

# \uXXXX-escaped "allow": the literal bytes "permissionDecision":"allow" never
# appear, so a blocklist for that exact string would miss it. has_unicode_escape
# catches the escape itself before is_deny_decision or has_permission_decision are
# even consulted, so this is refused with a diagnostic, not forwarded.
st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=emit-allow-escaped)
if [ "$st" = "0" ] && [ "$(decision)" = "none" ] && grep -q "could not safely interpret" "${WORK}/out"; then
  pass "escaped allow verdict is not forwarded, and the drop is diagnosed"
else
  fail "escaped allow must not be forwarded" "status=$st decision=$(decision) stdout=$(cat "${WORK}/out")"
fi

# A bare notice (partial coverage / round-limit disclosure) carries no
# permissionDecision at all, so it must reach stdout even though it isn't a deny --
# dropping it would silently discard the safety disclosure SKILL.md promises.
st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=notice)
if [ "$st" = "0" ] && [ "$(decision)" = "none" ] && grep -q "Partial coverage" "${WORK}/out"; then
  pass "CLI notice (no permission decision) is forwarded to stdout"
else
  fail "bare notice must be forwarded" "status=$st decision=$(decision) stdout=$(cat "${WORK}/out")"
fi

# A systemMessage alongside permissionDecision:allow, but with the key \uXXXX-escaped
# so the literal bytes "permissionDecision": never appear. has_system_message is true
# and a literal-bytes has_permission_decision check alone would be fooled into
# treating this as a decision-free notice and forwarding it -- which Claude Code's
# real JSON parser then decodes back to permissionDecision:allow. Must be refused,
# and the user must be told a verdict was dropped rather than hearing nothing.
st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=notice-escaped-key)
if [ "$st" = "0" ] && [ "$(decision)" = "none" ] && grep -q "could not safely interpret" "${WORK}/out"; then
  pass "notice with an escaped permissionDecision key is not forwarded, and the drop is diagnosed"
else
  fail "escaped-key notice must not be forwarded" "status=$st decision=$(decision) stdout=$(cat "${WORK}/out")"
fi

# A literal permissionDecision:deny plus a duplicate permissionDecision key spelled
# with a \uXXXX escape and set to allow. is_deny_decision matches the literal deny
# bytes, so without gating the deny branch on has_unicode_escape too, this would be
# forwarded verbatim -- and a decoder resolving the duplicate key last-wins (as
# Python's json.loads does) reads permissionDecision:allow. The escape check must
# cover this branch as well, not just the notice branch.
st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny-escaped-key)
if [ "$st" = "0" ] && [ "$(decision)" = "none" ] && grep -q "could not safely interpret" "${WORK}/out"; then
  pass "deny verdict with an escaped duplicate key is not forwarded, and the drop is diagnosed"
else
  fail "escaped-key deny must not be forwarded verbatim" "status=$st decision=$(decision) stdout=$(cat "${WORK}/out")"
fi

# A literal permissionDecision:deny plus a second, also literal, permissionDecision
# key set to allow -- no escape anywhere. is_deny_decision matches the first,
# literal deny bytes, so without a dedicated duplicate-key guard this would be
# forwarded verbatim -- and a decoder resolving the duplicate key last-wins (as
# Claude Code's does) reads permissionDecision:allow.
st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny-duplicate-key)
if [ "$st" = "0" ] && [ "$(decision)" = "none" ] && grep -q "could not safely interpret" "${WORK}/out"; then
  pass "deny verdict with a literal duplicate permissionDecision key is not forwarded, and the drop is diagnosed"
else
  fail "duplicate-key deny must not be forwarded verbatim" "status=$st decision=$(decision) stdout=$(cat "${WORK}/out")"
fi

# A deny quoting source that contains a \u00e9-style literal: the JSON carries an
# escaped backslash (\\u00e9), not an escape, so the deny must still go through.
st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny-escaped-span)
if [ "$st" = "0" ] && [ "$(decision)" = "deny" ] && grep -q "R-001" "${WORK}/out"; then
  pass "deny quoting an escaped backslash before u00e9 is still forwarded"
else
  fail "escaped-backslash deny must not be refused as uninterpretable" "status=$st decision=$(decision) stdout=$(cat "${WORK}/out")"
fi

# An escaped backslash followed by a real \u0070 escape: stripping the pair must
# not hide the escape after it.
st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny-escaped-backslash-escape)
if [ "$st" = "0" ] && [ "$(decision)" = "none" ] && grep -q "could not safely interpret" "${WORK}/out"; then
  pass "a real escape after an escaped backslash is still refused"
else
  fail "escape after an escaped backslash must be refused" "status=$st decision=$(decision) stdout=$(cat "${WORK}/out")"
fi

echo
echo "=== plan-gate: envelope passthrough ==="
# Three recorded ExitPlanMode shapes. The wrapper must forward each intact;
# plan-check --claude-hook resolves plan text (injected first, transcript last).
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

if grep -Fxq -- '--claude-hook' "${CAPTURE}.argv" \
   && [ "$(argv_after --rules-dir "${CAPTURE}.argv")" = "${REPO_WITH_RULES}/.actual/rules" ]; then
  pass "CLI is invoked with --claude-hook and --rules-dir pointing at the repo rules"
else
  fail "missing --claude-hook / --rules-dir" "argv=$(cat "${CAPTURE}.argv" 2>/dev/null)"
fi

CAPTURE_INJECTED="${WORK}/captured-injected.json"
st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-injected.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=allow ACTUAL_TEST_CAPTURE="$CAPTURE_INJECTED")
injected_plan=$(jq -r '.tool_input.plan // ""' "$CAPTURE_INJECTED" 2>/dev/null)
injected_path=$(jq -r '.tool_input.planFilePath // ""' "$CAPTURE_INJECTED" 2>/dev/null)
if [ "$st" = "0" ] && printf '%s' "$injected_plan" | grep -q "Redis cache" \
   && [ -f "$injected_path" ] && grep -q "Redis cache" "$injected_path"; then
  pass "injected shape: plan and planFilePath reach the CLI (no transcript scrape needed)"
else
  fail "injected shape: tool_input.plan / planFilePath not forwarded" "captured=$(cat "$CAPTURE_INJECTED" 2>/dev/null)"
fi

injected_src_plan=$(jq -r '.tool_input.plan // ""' "${RESOLVED}/pretooluse-plan-injected.json")
injected_src_path=$(jq -r '.tool_input.planFilePath // ""' "${RESOLVED}/pretooluse-plan-injected.json")
if printf '%s' "$injected_src_plan" | grep -q "Redis cache" \
   && [ -f "$injected_src_path" ]; then
  pass "injected shape: current envelope has tool_input.plan and a readable planFilePath"
else
  fail "injected shape: fixture missing injected plan fields" "path=$injected_src_path"
fi

resolved_plan=$(jq -r 'select(.attachment.type=="plan_mode") | .attachment.planFilePath' "${RESOLVED}/transcript-plan-file.jsonl" 2>/dev/null | tail -1)
if [ -n "$resolved_plan" ] && [ -f "$resolved_plan" ] && grep -q "Redis cache" "$resolved_plan"; then
  pass "legacy file shape: plan text resolvable via transcript when tool_input is empty"
else
  fail "legacy file shape: could not resolve plan via transcript" "resolved=$resolved_plan"
fi

inline_plan=$(jq -r '.tool_input.plan // ""' "${RESOLVED}/pretooluse-plan-inline.json")
if printf '%s' "$inline_plan" | grep -q "Redis cache"; then
  pass "legacy inline shape: plan text present in tool_input.plan"
else
  fail "legacy inline shape: tool_input.plan missing" ""
fi

echo
echo "=== plan-gate: fail open ==="
for mode in crash garbage cannot-run; do
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

rm -f "${WORK}/subprocess-capture" "${WORK}/subprocess-capture.argv"
st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny ACTUAL_CLI_SUBPROCESS=1 ACTUAL_TEST_CAPTURE="${WORK}/subprocess-capture")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -e "${WORK}/subprocess-capture.argv" ]; then
  pass "ACTUAL_CLI_SUBPROCESS=1: silent no-op that never invokes the CLI"
else
  fail "subprocess guard did not disable the plan-gate" "status=$st stdout=$(cat "${WORK}/out") argv=$(cat "${WORK}/subprocess-capture.argv" 2>/dev/null)"
fi

echo
echo "=== impl-gate: no committed rules ==="
st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_NO_RULES" ACTUAL_TEST_MODE=deny)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
  pass "no rules: silent no-op (exit 0, no stdout, no stderr)"
else
  fail "no rules: expected silent exit 0" "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err")"
fi

echo
echo "=== impl-gate: CLI bootstrap preflight ==="

st=$(run_hook_no_cli "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES")
if [ "$st" = "0" ] && grep -q "npm install -g @actualai/actual" "${WORK}/out" \
   && grep -q "not checked" "${WORK}/out" \
   && ! grep -q "AskUserQuestion" "${WORK}/out" \
   && [ "$(stop_decision)" = "none" ]; then
  pass "missing binary: exit 0 with a user-facing install warning, no decision:block"
else
  fail "missing binary: expected exit 0 + a short user-facing warning, no block" "status=$st stdout=$(cat "${WORK}/out")"
fi

if jq -e '.systemMessage' "${WORK}/out" >/dev/null 2>&1 && ! jq -e 'has("decision")' "${WORK}/out" >/dev/null 2>&1; then
  pass "missing binary: plain systemMessage, never a channel that forces continuation"
else
  fail "missing binary: expected a bare top-level systemMessage" "stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=no-impl-check)
if [ "$st" = "0" ] && grep -q "no .impl-check. subcommand" "${WORK}/out" \
   && grep -q "not checked" "${WORK}/out" \
   && ! grep -q "AskUserQuestion" "${WORK}/out" \
   && [ "$(stop_decision)" = "none" ]; then
  pass "old CLI (has plan-check, not impl-check yet): exit 0 with a user-facing upgrade warning, no block"
else
  fail "old CLI: expected exit 0 + a short user-facing warning, no block" "status=$st stdout=$(cat "${WORK}/out")"
fi

echo
echo "=== impl-gate: verdict passthrough ==="

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=allow)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "none" ] && [ ! -s "${WORK}/out" ]; then
  pass "conforming diff makes no decision (the turn ends normally)"
else
  fail "expected silent pass (no decision)" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "block" ] && grep -q "R-001" "${WORK}/out"; then
  pass "deny verdict is re-rendered as Stop's decision:block, names the rule id"
else
  fail "expected decision:block naming R-001" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

# The CLI's own renderer emits a PreToolUse-shaped hookSpecificOutput
# unconditionally (see impl-gate.sh's module comment) -- forwarded verbatim,
# Claude Code's Stop handler would read no `decision` field at all and let
# the turn end. Regression test for reverting to a forward instead of a
# re-render.
if jq -e 'has("hookSpecificOutput")' "${WORK}/out" >/dev/null 2>&1; then
  fail "deny verdict must not carry a leftover PreToolUse-shaped hookSpecificOutput" "stdout=$(cat "${WORK}/out")"
else
  pass "deny verdict is Stop's own top-level shape, not forwarded PreToolUse JSON"
fi

# is_deny_decision is whitespace-insensitive. The Stop re-render has to be too:
# a space after the colon used to classify as deny and then fail open, because
# the reason scan required `"permissionDecisionReason":"` with no whitespace.
st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny-spaced)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "block" ] \
   && [ "$(jq -r '.reason' "${WORK}/out")" = "R-001 MUST: all persistence goes through the repository layer. The plan adds direct SQL in the handler." ]; then
  pass "deny with whitespace around colons still blocks, and the reason keeps its spaces"
else
  fail "spaced deny must block with the extracted reason" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny-pretty)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "block" ] \
   && [ "$(jq -r '.reason' "${WORK}/out")" = "R-001 MUST: all persistence goes through the repository layer." ]; then
  pass "pretty-printed deny still blocks with the extracted reason"
else
  fail "pretty-printed deny must block with the extracted reason" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny-no-reason)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "block" ] \
   && grep -q "verdict reason could not be read" "${WORK}/out" \
   && ! grep -q "was not checked" "${WORK}/out"; then
  pass "deny with no readable reason still blocks, and does not claim the diff was unchecked"
else
  fail "unreadable deny reason must still block" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny-exit2)
if [ "$st" = "2" ] && grep -q "R-001" "${WORK}/err"; then
  pass "exit-2 fallback: blocks with the reason on stderr (Stop's exit-2 contract matches PreToolUse's)"
else
  fail "exit-2 fallback: expected exit 2 + stderr reason" "status=$st stderr=$(cat "${WORK}/err")"
fi

# The Stop case matters most: a block here would repeat at every turn's end,
# with no round limit to break the loop because the judge never ran.
st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=usage-error)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "none" ] && grep -q "rejected its invocation: error: invalid value" "${WORK}/out"; then
  pass "CLI usage error at exit 2 fails open with a notice, never forces continuation"
else
  fail "CLI usage error must fail open" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=emit-allow)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "none" ]; then
  pass "CLI allow verdict is not forwarded (never forces continuation)"
else
  fail "allow must not be forwarded" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=emit-allow-escaped)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "none" ] && grep -q "could not safely interpret" "${WORK}/out"; then
  pass "escaped allow verdict is not forwarded, and the drop is diagnosed"
else
  fail "escaped allow must not be forwarded" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=notice)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "none" ] && grep -q "Partial coverage" "${WORK}/out"; then
  pass "CLI notice (no permission decision) is re-rendered as a plain systemMessage"
else
  fail "bare notice must be forwarded" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=notice-spaced)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "none" ] \
   && [ "$(jq -r '.systemMessage' "${WORK}/out")" = "Partial coverage: 60 of 118 rules checked for this plan." ]; then
  pass "notice with whitespace around colons is still re-rendered as systemMessage"
else
  fail "spaced notice must be re-rendered" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=notice-escaped-key)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "none" ] && grep -q "could not safely interpret" "${WORK}/out"; then
  pass "notice with an escaped permissionDecision key is not forwarded, and the drop is diagnosed"
else
  fail "escaped-key notice must not be forwarded" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny-escaped-key)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "none" ] && grep -q "could not safely interpret" "${WORK}/out"; then
  pass "deny verdict with an escaped duplicate key is not forwarded, and the drop is diagnosed"
else
  fail "escaped-key deny must not be forwarded verbatim" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny-duplicate-key)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "none" ] && grep -q "could not safely interpret" "${WORK}/out"; then
  pass "deny verdict with a literal duplicate permissionDecision key is not forwarded, and the drop is diagnosed"
else
  fail "duplicate-key deny must not be forwarded verbatim" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny-escaped-span)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "block" ] && grep -q "R-001" "${WORK}/out" \
   && ! grep -q "could not safely interpret" "${WORK}/out"; then
  pass "deny quoting an escaped backslash before u00e9 still blocks"
else
  fail "escaped-backslash deny must block, not degrade to a notice" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny-escaped-backslash-escape)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "none" ] && grep -q "could not safely interpret" "${WORK}/out"; then
  pass "a real escape after an escaped backslash is still refused"
else
  fail "escape after an escaped backslash must be refused" "status=$st decision=$(stop_decision) stdout=$(cat "${WORK}/out")"
fi

echo
echo "=== impl-gate: envelope + argv passthrough ==="
CAPTURE_STOP="${WORK}/captured-stop.json"
st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=allow ACTUAL_TEST_CAPTURE="$CAPTURE_STOP")
if [ -s "$CAPTURE_STOP" ] \
   && [ "$(jq -r '.hook_event_name' "$CAPTURE_STOP")" = "Stop" ] \
   && [ "$(jq -r '.session_id' "$CAPTURE_STOP")" = "test-session-stop-turn" ]; then
  pass "raw Stop envelope reaches the CLI unparsed, with session_id intact"
else
  fail "envelope passthrough broken" "captured=$(cat "$CAPTURE_STOP" 2>/dev/null)"
fi

if grep -Fxq -- '--claude-hook' "${CAPTURE_STOP}.argv" \
   && [ "$(argv_after --rules-dir "${CAPTURE_STOP}.argv")" = "${REPO_WITH_RULES}/.actual/rules" ]; then
  pass "CLI is invoked as impl-check --claude-hook --rules-dir pointing at the repo rules"
else
  fail "missing --claude-hook / --rules-dir" "argv=$(cat "${CAPTURE_STOP}.argv" 2>/dev/null)"
fi

echo
echo "=== impl-gate: fail open ==="
for mode in crash garbage cannot-run; do
  st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE="$mode")
  if [ "$st" = "0" ] && [ "$(stop_decision)" != "block" ]; then
    pass "$mode: fails open (exit 0, no block)"
  else
    fail "$mode: expected fail-open exit 0" "status=$st decision=$(stop_decision)"
  fi
done

st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny ACTUAL_PLAN_GATE=off)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
  pass "ACTUAL_PLAN_GATE=off: silent no-op even with a deny verdict available"
else
  fail "opt-out did not disable the gate" "status=$st stdout=$(cat "${WORK}/out")"
fi

rm -f "${WORK}/subprocess-capture" "${WORK}/subprocess-capture.argv"
st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny ACTUAL_CLI_SUBPROCESS=1 ACTUAL_TEST_CAPTURE="${WORK}/subprocess-capture")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -e "${WORK}/subprocess-capture.argv" ]; then
  pass "ACTUAL_CLI_SUBPROCESS=1: silent no-op that never invokes the CLI (no recursive impl-check)"
else
  fail "subprocess guard did not disable the impl-gate" "status=$st stdout=$(cat "${WORK}/out") argv=$(cat "${WORK}/subprocess-capture.argv" 2>/dev/null)"
fi

echo
echo "=== impl-gate: fires unconditionally, independent of plan-gate ==="
# AK-754 requirement: the Stop hook must govern a turn even when
# ExitPlanMode/plan-gate.sh never fired in this session at all. impl-gate.sh
# never reads plan-gate.sh's state (there is none -- plan-gate.sh keeps
# nothing on disk of its own), so this simply asserts the observable
# behavior with only the Stop envelope in play: a denied diff still blocks.
st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "${RESOLVED}/stop-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny)
if [ "$st" = "0" ] && [ "$(stop_decision)" = "block" ]; then
  pass "governs a turn with no prior plan-gate.sh invocation in this session"
else
  fail "Stop hook did not fire independently of plan-gate.sh" "status=$st decision=$(stop_decision)"
fi

echo
echo "=== turn-start: UserPromptSubmit ==="
# Silence is the contract on every path: UserPromptSubmit adds a hook's stdout
# to the prompt. Each case therefore asserts empty stdout and stderr as well as
# whether the CLI was reached.
CAPTURE_TURN="${WORK}/captured-turn.json"

rm -f "$CAPTURE_TURN" "${CAPTURE_TURN}.argv"
st=$(run_hook "${HOOKS_DIR}/turn-start.sh" "${RESOLVED}/userpromptsubmit-turn.json" "$REPO_NO_RULES" ACTUAL_TEST_MODE=allow ACTUAL_TEST_CAPTURE="$CAPTURE_TURN")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ] && [ ! -e "${CAPTURE_TURN}.argv" ]; then
  pass "no rules: silent no-op that never invokes the CLI"
else
  fail "no rules: expected a silent exit 0 without the CLI" "status=$st stdout=$(cat "${WORK}/out") argv=$(cat "${CAPTURE_TURN}.argv" 2>/dev/null)"
fi

rm -f "$CAPTURE_TURN" "${CAPTURE_TURN}.argv"
st=$(run_hook "${HOOKS_DIR}/turn-start.sh" "${RESOLVED}/userpromptsubmit-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=allow ACTUAL_TEST_CAPTURE="$CAPTURE_TURN")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ] \
   && [ "$(jq -r '.hook_event_name' "$CAPTURE_TURN" 2>/dev/null)" = "UserPromptSubmit" ] \
   && [ "$(jq -r '.session_id' "$CAPTURE_TURN" 2>/dev/null)" = "test-session-turn-start" ]; then
  pass "rules present, CLI with the UserPromptSubmit dispatch: the raw envelope reaches the CLI, and the hook stays silent"
else
  fail "turn-start did not forward the envelope silently" "status=$st stdout=$(cat "${WORK}/out") captured=$(cat "$CAPTURE_TURN" 2>/dev/null)"
fi

if grep -Fxq -- '--claude-hook' "${CAPTURE_TURN}.argv" \
   && ! grep -Fxq -- '--turn-start' "${CAPTURE_TURN}.argv" \
   && [ "$(argv_after --rules-dir "${CAPTURE_TURN}.argv")" = "${REPO_WITH_RULES}/.actual/rules" ]; then
  pass "CLI is invoked with --claude-hook (no --turn-start) and the rules dir impl-gate.sh uses"
else
  fail "turn-start argv wrong" "argv=$(cat "${CAPTURE_TURN}.argv" 2>/dev/null)"
fi

# The capture holds argv after the subcommand. A CLI with no plan-check refuses
# that subcommand before capturing, so a capture here proves the call went to
# impl-check rather than plan-check.
rm -f "$CAPTURE_TURN" "${CAPTURE_TURN}.argv"
st=$(run_hook "${HOOKS_DIR}/turn-start.sh" "${RESOLVED}/userpromptsubmit-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=no-plan-check ACTUAL_TEST_CAPTURE="$CAPTURE_TURN")
if [ "$st" = "0" ] && grep -Fxq -- '--claude-hook' "${CAPTURE_TURN}.argv" 2>/dev/null; then
  pass "the subcommand is impl-check"
else
  fail "turn-start called a subcommand other than impl-check" "status=$st argv=$(cat "${CAPTURE_TURN}.argv" 2>/dev/null)"
fi

# CLI 0.6.x has impl-check but no UserPromptSubmit dispatch, so handing it the
# envelope runs the full check on every prompt. Its --help never names the
# event, and the hook must not call it at all.
rm -f "$CAPTURE_TURN" "${CAPTURE_TURN}.argv"
st=$(run_hook "${HOOKS_DIR}/turn-start.sh" "${RESOLVED}/userpromptsubmit-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=no-turn-start ACTUAL_TEST_CAPTURE="$CAPTURE_TURN")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ] && [ ! -e "${CAPTURE_TURN}.argv" ]; then
  pass "CLI without the UserPromptSubmit dispatch (0.6.x): silent no-op that never invokes impl-check --claude-hook"
else
  fail "turn-start invoked a CLI that lacks the UserPromptSubmit dispatch" "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err") argv=$(cat "${CAPTURE_TURN}.argv" 2>/dev/null)"
fi

# A verdict, a notice, a usage error, a crash: none of
# them may reach the prompt, and none may fail the hook.
for mode in deny notice usage-error crash garbage no-impl-check; do
  st=$(run_hook "${HOOKS_DIR}/turn-start.sh" "${RESOLVED}/userpromptsubmit-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE="$mode")
  if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
    pass "$mode: exit 0 with nothing on stdout or stderr"
  else
    fail "$mode: expected a silent exit 0" "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err")"
  fi
done

st=$(run_hook_no_cli "${HOOKS_DIR}/turn-start.sh" "${RESOLVED}/userpromptsubmit-turn.json" "$REPO_WITH_RULES")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
  pass "missing binary: silent (impl-gate.sh reports a missing CLI at Stop)"
else
  fail "missing binary: expected a silent exit 0" "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err")"
fi

# The fake CLI reads stdin before every mode, so its usage-error case never
# breaks the pipe. A real CLI can exit on a usage error without reading
# anything; with a prompt larger than the pipe buffer and SIGPIPE
# ignored, the hook's own write then fails. This one passes the dispatch
# probe, so the hook gets as far as that write.
EARLY_EXIT_BIN="${WORK}/early-exit-bin"
mkdir -p "$EARLY_EXIT_BIN"
cat > "${EARLY_EXIT_BIN}/actual" <<'EOF'
#!/bin/sh
if [ "${2:-}" = "--help" ]; then
  echo "An envelope whose hook_event_name is UserPromptSubmit checks nothing and prints nothing."
  exit 0
fi
echo "error: unexpected argument found" >&2
exit 2
EOF
chmod +x "${EARLY_EXIT_BIN}/actual"
{ printf '{"session_id":"test-session-turn-start","hook_event_name":"UserPromptSubmit","prompt":"'
  head -c 262144 /dev/zero | tr '\0' x
  printf '"}'
} > "${WORK}/userpromptsubmit-large.json"
st=$(trap '' PIPE; run_hook "${HOOKS_DIR}/turn-start.sh" "${WORK}/userpromptsubmit-large.json" "$REPO_WITH_RULES" PATH="${EARLY_EXIT_BIN}:${PATH}")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
  pass "a CLI that exits before reading a large prompt: silent, even with SIGPIPE ignored"
else
  fail "a broken pipe reached the hook's output" "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err")"
fi

for switch in ACTUAL_PLAN_GATE=off ACTUAL_CLI_SUBPROCESS=1; do
  rm -f "$CAPTURE_TURN" "${CAPTURE_TURN}.argv"
  st=$(run_hook "${HOOKS_DIR}/turn-start.sh" "${RESOLVED}/userpromptsubmit-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=allow ACTUAL_TEST_CAPTURE="$CAPTURE_TURN" "$switch")
  if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ] && [ ! -e "${CAPTURE_TURN}.argv" ]; then
    pass "${switch}: silent no-op that never invokes the CLI"
  else
    fail "${switch} did not disable turn-start" "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err") argv=$(cat "${CAPTURE_TURN}.argv" 2>/dev/null)"
  fi
done

# Opt-in trace: the log gets the CLI's output and exit status, and the hook
# itself stays silent.
TURN_LOG="${WORK}/turn-start.log"
rm -f "$TURN_LOG"
st=$(run_hook "${HOOKS_DIR}/turn-start.sh" "${RESOLVED}/userpromptsubmit-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=crash ACTUAL_TURN_START_LOG="$TURN_LOG")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ] && grep -q '^turn-start: exit=' "$TURN_LOG" 2>/dev/null; then
  pass "ACTUAL_TURN_START_LOG: trace written to the file, hook still silent"
else
  fail "ACTUAL_TURN_START_LOG trace wrong" "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err") log=$(cat "$TURN_LOG" 2>/dev/null)"
fi

rm -f "$TURN_LOG"
st=$(run_hook "${HOOKS_DIR}/turn-start.sh" "${RESOLVED}/userpromptsubmit-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=no-turn-start ACTUAL_TURN_START_LOG="$TURN_LOG")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ] && grep -q '^turn-start: skipped' "$TURN_LOG" 2>/dev/null; then
  pass "ACTUAL_TURN_START_LOG: a CLI without the dispatch is traced as skipped, hook still silent"
else
  fail "ACTUAL_TURN_START_LOG skip trace wrong" "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err") log=$(cat "$TURN_LOG" 2>/dev/null)"
fi

# A trace file that cannot be opened must not surface bash's redirection error.
for mode in allow no-turn-start; do
  st=$(run_hook "${HOOKS_DIR}/turn-start.sh" "${RESOLVED}/userpromptsubmit-turn.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE="$mode" ACTUAL_TURN_START_LOG="${WORK}/no-such-dir/turn-start.log")
  if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
    pass "ACTUAL_TURN_START_LOG that cannot be opened (${mode}): still silent"
  else
    fail "an unopenable ACTUAL_TURN_START_LOG reached the hook's output (${mode})" "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err")"
  fi
done

# The shipped hooks' two standing rules, kept in this section so the shared
# lists in "dependency hygiene" below stay as they are.
if grep -nE '(^|[^-_[:alnum:]])(jq|python3?|node)([^-_[:alnum:]]|$)' "${HOOKS_DIR}/turn-start.sh" \
     | grep -vE '^[0-9]+:[[:space:]]*#' > "${WORK}/deps" 2>/dev/null; then
  fail "turn-start.sh references a JSON/runtime dependency" "$(cat "${WORK}/deps")"
else
  pass "turn-start.sh references no jq/python/node"
fi
if [ -x "${HOOKS_DIR}/turn-start.sh" ]; then pass "turn-start.sh is executable"; else fail "turn-start.sh is not executable" ""; fi

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

st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=allow ACTUAL_CLI_SUBPROCESS=1)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
  pass "ACTUAL_CLI_SUBPROCESS=1: no session context inside actual-cli's own subprocess"
else
  fail "subprocess guard did not silence preflight" "status=$st stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook_no_cli "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES")
if [ "$st" = "0" ] && grep -q "brew install actual-software/actual/actual" "${WORK}/out" \
   && grep -q "Offer to install it now" "${WORK}/out"; then
  pass "rules + no CLI: install matrix as session context, framed as an offer"
else
  fail "missing-CLI preflight wrong" "status=$st stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=allow)
ctx=$(jq -r '.hookSpecificOutput.additionalContext // ""' < "${WORK}/out" 2>/dev/null)
if [ "$st" = "0" ] \
   && printf '%s' "$ctx" | grep -q "governance is active" \
   && ! printf '%s' "$ctx" | grep -q "surfaced to you" \
   && ! printf '%s' "$ctx" | grep -q "brew upgrade" \
   && [ "${ctx% }" = "$ctx" ]; then
  pass "rules + full CLI: success message makes no briefing promise a compaction would break, and no upgrade note"
else
  fail "healthy preflight promises briefing, carries an upgrade note, or ends in a space" "status=$st ctx=$ctx"
fi

echo
echo "=== preflight: minimum CLI version ==="

session_context() {
  jq -r '.hookSpecificOutput.additionalContext // ""' < "${WORK}/out" 2>/dev/null
}

# The nearest version under $1.
version_below() {
  local major=${1%%.*} rest=${1#*.} minor patch
  minor=${rest%%.*} patch=${rest#*.}
  if [ "$patch" -gt 0 ]; then
    printf '%s' "${major}.${minor}.$((patch - 1))"
  elif [ "$minor" -gt 0 ]; then
    printf '%s' "${major}.$((minor - 1)).99"
  else
    printf '%s' "$((major - 1)).99.99"
  fi
}

# Both floors are read from the library rather than repeated here, so raising
# either needs no test change. BELOW is the nearest version under the minimum
# and BELOW_GATES the nearest under the release every check runs in full on.
# NUMERIC is newer by number but sorts first as a string ("0.18.0" before
# "0.8.0"), which a string comparison would get wrong.
MIN=$(bash -c '. "$1" && printf "%s" "$MIN_CLI_VERSION"' _ "${HOOKS_DIR}/lib/bootstrap.sh")
GATES=$(bash -c '. "$1" && printf "%s" "$GATES_MIN_CLI_VERSION"' _ "${HOOKS_DIR}/lib/bootstrap.sh")
BELOW=$(version_below "$MIN")
BELOW_GATES=$(version_below "$GATES")
min_major=${MIN%%.*} min_rest=${MIN#*.}
min_minor=${min_rest%%.*}
NUMERIC="${min_major}.$((min_minor + 10)).0"
CALLS="${WORK}/calls"
INTERRUPT='worth interrupting|do not continue this task|regardless of what else is in progress'

for v in "$MIN" "$NUMERIC" "${MIN}-rc.1" "unreadable"; do
  st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$v")
  ctx=$(session_context)
  if [ "$st" = "0" ] && printf '%s' "$ctx" | grep -q "governance is active" \
     && ! printf '%s' "$ctx" | grep -q "upgrade"; then
    pass "rules + CLI reporting ${v}: governance active, no upgrade offer"
  else
    fail "rules + CLI reporting ${v}: expected the success message alone" "status=$st ctx=$ctx"
  fi

  st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_NO_RULES" ACTUAL_TEST_VERSION="$v")
  if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
    pass "no rules + CLI reporting ${v}: silent"
  else
    fail "no rules + CLI reporting ${v}: expected silence" "status=$st stdout=$(cat "${WORK}/out")"
  fi
done

rm -f "$CALLS"
st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_CALLS="$CALLS")
if [ "$st" = "0" ] && [ "$(cat "$CALLS" 2>/dev/null)" = "--version" ]; then
  pass "rules + CLI at or above the minimum: one CLI spawn, \`actual --version\`"
else
  fail "healthy preflight spawned more than actual --version" "calls=$(cat "$CALLS" 2>/dev/null)"
fi

rm -f "$CALLS"
st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$BELOW_GATES" ACTUAL_TEST_CALLS="$CALLS")
ctx=$(session_context)
if [ "$st" = "0" ] \
   && printf '%s' "$ctx" | grep -qF "CLI is ${BELOW_GATES} " \
   && printf '%s' "$ctx" | grep -qF "need ${GATES} or" \
   && printf '%s' "$ctx" | grep -qF "needs ${MIN} or" \
   && printf '%s' "$ctx" | grep -q "npm install -g @actualai/actual@latest" \
   && printf '%s' "$ctx" | grep -q "brew upgrade actual-software/actual/actual" \
   && printf '%s' "$ctx" | grep -q "second copy" \
   && ! printf '%s' "$ctx" | grep -q "governance is active"; then
  pass "rules + CLI below ${GATES} and older than \`version\`: all three versions, both commands, how to tell which applies, no claim that governance is active"
else
  fail "below-gates preflight wrong" "status=$st ctx=$ctx"
fi

if printf '%s' "$ctx" | grep -q "Offer to upgrade it now" \
   && printf '%s' "$ctx" | grep -q "regardless of what else is in progress" \
   && printf '%s' "$ctx" | grep -q "ask using an interactive question tool" \
   && printf '%s' "$ctx" | grep -q "does not satisfy this"; then
  pass "rules + CLI below ${GATES}: interrupts the task and waits for an answer, like the install offer"
else
  fail "below-gates offer in a governed repo lost the interrupt-and-wait wording" "$ctx"
fi

if [ "$(cat "$CALLS" 2>/dev/null)" = "$(printf -- '--version\nversion --json')" ]; then
  pass "below the minimum: \`actual --version\`, then \`actual version --json\` without --check, so no registry request"
else
  fail "below-minimum preflight made the wrong CLI calls" "calls=$(cat "$CALLS" 2>/dev/null)"
fi

# From GATES up to the minimum every check runs, so a governed repository keeps
# the message that governance is active, and the offer after it waits for a
# pause, since SessionStart repeats it after every compaction.
for v in "$GATES" "$BELOW"; do
  rm -f "$CALLS"
  st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$v" ACTUAL_TEST_CALLS="$CALLS")
  ctx=$(session_context)
  if [ "$st" = "0" ] \
     && [ "${ctx#Actual plan- and implementation-stage governance is active: 1 rule file}" != "$ctx" ] \
     && printf '%s' "$ctx" | grep -qF "CLI is ${v}," \
     && printf '%s' "$ctx" | grep -qF "needs ${MIN} or" \
     && printf '%s' "$ctx" | grep -q "npm install -g @actualai/actual@latest" \
     && printf '%s' "$ctx" | grep -q "brew upgrade actual-software/actual/actual" \
     && printf '%s' "$ctx" | grep -q "AskUserQuestion" \
     && ! printf '%s' "$ctx" | grep -qE "$INTERRUPT" \
     && [ "$(cat "$CALLS" 2>/dev/null)" = "$(printf -- '--version\nversion --json')" ]; then
    pass "rules + CLI reporting ${v}: governance active, then the upgrade offer at a pause, without interrupting the task"
  else
    fail "rules + CLI reporting ${v}: expected governance active and an offer at a pause" "status=$st ctx=$ctx calls=$(cat "$CALLS" 2>/dev/null)"
  fi
done

for channel in homebrew npm npm-bare; do
  case "$channel" in
    homebrew) want="brew upgrade actual-software/actual/actual" wrong="npm install" ;;
    npm)      want="npm install -g @actualai/actual@latest" wrong="brew upgrade" ;;
    npm-bare) want="npm install -g @actualai/actual" wrong="brew upgrade" ;;
  esac
  st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$BELOW" ACTUAL_TEST_CHANNEL="$channel")
  ctx=$(session_context)
  if [ "$st" = "0" ] && printf '%s' "$ctx" | grep -qxF "  ${want}" \
     && ! printf '%s' "$ctx" | grep -qF "$wrong" \
     && ! printf '%s' "$ctx" | grep -q "second copy"; then
    pass "installed with ${channel}: only that channel's command, from \`actual version --json\`"
  else
    fail "installed with ${channel}: expected only ${want}" "status=$st ctx=$ctx"
  fi
done

st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$BELOW" ACTUAL_TEST_CHANNEL=other)
ctx=$(session_context)
if [ "$st" = "0" ] \
   && printf '%s' "$ctx" | grep -qF "https://github.com/actual-software/actual-releases/releases/latest" \
   && ! printf '%s' "$ctx" | grep -q "npm install" \
   && ! printf '%s' "$ctx" | grep -q "brew upgrade"; then
  pass "installed some other way: the release page, and neither package manager's command"
else
  fail "channel other: expected the release page alone" "status=$st ctx=$ctx"
fi

st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$BELOW" ACTUAL_TEST_CHANNEL=other ACTUAL_TEST_RELEASE_URL="https://example.invalid/injected")
ctx=$(session_context)
if [ "$st" = "0" ] \
   && printf '%s' "$ctx" | grep -qF "https://github.com/actual-software/actual-releases/releases/latest" \
   && ! printf '%s' "$ctx" | grep -q "injected"; then
  pass "installed some other way: always the actual-releases page, whatever release_url names"
else
  fail "a release_url elsewhere reached the session context" "status=$st ctx=$ctx"
fi

# foreign and suffixed are made of plain characters, so only comparing the whole
# command keeps them out; suffixed would pass a prefix match.
for channel in unsafe escaped foreign suffixed; do
  st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$BELOW" ACTUAL_TEST_CHANNEL="$channel")
  ctx=$(session_context)
  if [ "$st" = "0" ] && ! printf '%s' "$ctx" | grep -q "injected" \
     && printf '%s' "$ctx" | grep -q "npm install -g @actualai/actual@latest" \
     && printf '%s' "$ctx" | grep -q "brew upgrade actual-software/actual/actual"; then
    pass "an upgrade_command that is ${channel} is not passed on: both commands instead"
  else
    fail "a ${channel} upgrade_command reached the session context" "status=$st ctx=$ctx"
  fi
done

# Nothing is checked where no rules are committed, so an old CLI there is not
# the plugin's business: no offer, and no `actual` call at all.
for v in "$BELOW" "$BELOW_GATES"; do
  rm -f "$CALLS"
  st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_NO_RULES" ACTUAL_TEST_VERSION="$v" ACTUAL_TEST_CHANNEL=npm ACTUAL_TEST_CALLS="$CALLS")
  if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "$CALLS" ]; then
    pass "no rules + CLI reporting ${v}: silent, and \`actual\` is never run"
  else
    fail "no rules + CLI reporting ${v}: expected silence and no CLI call" "status=$st stdout=$(cat "${WORK}/out") calls=$(cat "$CALLS" 2>/dev/null)"
  fi
done

st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$BELOW_GATES" ACTUAL_PLAN_GATE=off)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
  pass "ACTUAL_PLAN_GATE=off silences the version check too"
else
  fail "ACTUAL_PLAN_GATE=off did not silence the version check" "status=$st stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$BELOW_GATES" ACTUAL_CLI_SUBPROCESS=1)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
  pass "ACTUAL_CLI_SUBPROCESS=1: no upgrade offer inside actual-cli's own subprocess"
else
  fail "subprocess guard did not silence the version check" "status=$st stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook_no_cli "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_NO_RULES")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
  pass "no rules + no CLI: silent, so the plugin asks nobody to install a CLI they never chose"
else
  fail "no rules + no CLI: expected silence" "status=$st stdout=$(cat "${WORK}/out")"
fi

echo
echo "=== preflight: a SessionStart after the one that starts the session ==="

# SessionStart fires again on resume, clear, compact and fork. Only the start of
# a session may interrupt for a CLI below the gates floor; every later one keeps
# the news and offers at a pause, so a user who said no is not stopped again.
for src in resume clear compact fork; do
  sed "s/\"startup\"/\"${src}\"/" "${RESOLVED}/sessionstart-startup.json" > "${WORK}/sessionstart-${src}.json"
done
printf '{"session_id":"s","hook_event_name":"SessionStart"}' > "${WORK}/sessionstart-nosource.json"
printf '{"session_id":"s","hook_event_name":"SessionStart","source":"startup"}' > "${WORK}/sessionstart-unspaced.json"

for src in resume clear compact fork nosource; do
  label="source ${src}"
  [ "$src" = nosource ] && label="with no source"
  rm -f "$CALLS"
  st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${WORK}/sessionstart-${src}.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$BELOW_GATES" ACTUAL_TEST_CALLS="$CALLS")
  ctx=$(session_context)
  if [ "$st" = "0" ] \
     && printf '%s' "$ctx" | grep -qF "CLI is ${BELOW_GATES} " \
     && printf '%s' "$ctx" | grep -qF "need ${GATES} or" \
     && printf '%s' "$ctx" | grep -q "can go unchecked" \
     && printf '%s' "$ctx" | grep -q "npm install -g @actualai/actual@latest" \
     && printf '%s' "$ctx" | grep -q "AskUserQuestion" \
     && printf '%s' "$ctx" | grep -q "already declined it in this session, don't ask again" \
     && ! printf '%s' "$ctx" | grep -qE "$INTERRUPT" \
     && ! printf '%s' "$ctx" | grep -q "governance is active" \
     && [ "$(cat "$CALLS" 2>/dev/null)" = "$(printf -- '--version\nversion --json')" ]; then
    pass "rules + CLI below ${GATES}, SessionStart ${label}: the same news, offered at a pause and not again after a no"
  else
    fail "rules + CLI below ${GATES}, SessionStart ${label}: expected the offer at a pause" "status=$st ctx=$ctx calls=$(cat "$CALLS" 2>/dev/null)"
  fi
done

st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${WORK}/sessionstart-unspaced.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$BELOW_GATES")
ctx=$(session_context)
if [ "$st" = "0" ] && printf '%s' "$ctx" | grep -q "Offer to upgrade it now" \
   && printf '%s' "$ctx" | grep -q "regardless of what else is in progress"; then
  pass "rules + CLI below ${GATES}, startup envelope without whitespace: still interrupts"
else
  fail "rules + CLI below ${GATES}, unspaced startup envelope: expected the interrupt" "status=$st ctx=$ctx"
fi

st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${WORK}/sessionstart-compact.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$BELOW")
ctx=$(session_context)
if [ "$st" = "0" ] \
   && [ "${ctx#Actual plan- and implementation-stage governance is active}" != "$ctx" ] \
   && printf '%s' "$ctx" | grep -q "already declined it in this session, don't ask again" \
   && ! printf '%s' "$ctx" | grep -qE "$INTERRUPT"; then
  pass "rules + CLI reporting ${BELOW} after a compaction: governance active, then the offer at a pause, not again after a no"
else
  fail "rules + CLI reporting ${BELOW} after a compaction: expected governance active and the offer" "status=$st ctx=$ctx"
fi

echo
echo "=== preflight: a CLI that cannot run ==="

# 1 is npm's launcher without its platform package, or on a platform it does
# not support. 127 is that launcher with no node to run it.
for code in 1 127; do
  rm -f "$CALLS"
  st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=cannot-run ACTUAL_TEST_EXIT="$code" ACTUAL_TEST_CALLS="$CALLS")
  ctx=$(session_context)
  if [ "$st" = "0" ] \
     && printf '%s' "$ctx" | grep -q "CLI does not run" \
     && printf '%s' "$ctx" | grep -qxF "  npm install -g @actualai/actual" \
     && printf '%s' "$ctx" | grep -qxF "  brew reinstall actual-software/actual/actual" \
     && printf '%s' "$ctx" | grep -q "second copy" \
     && ! printf '%s' "$ctx" | grep -qF "brew install actual-software" \
     && ! printf '%s' "$ctx" | grep -q "governance is active"; then
    pass "rules + \`actual --version\` exits ${code}: says the CLI does not run, with both reinstall commands and how to tell which applies, and no claim that governance is active"
  else
    fail "rules + \`actual --version\` exits ${code}: expected the reinstall offer" "status=$st ctx=$ctx"
  fi

  if printf '%s' "$ctx" | grep -q "Offer to reinstall it now" \
     && printf '%s' "$ctx" | grep -q "regardless of what else is in progress" \
     && printf '%s' "$ctx" | grep -q "ask using an interactive question tool" \
     && printf '%s' "$ctx" | grep -q "does not satisfy this"; then
    pass "rules + \`actual --version\` exits ${code}: interrupts the task and waits for an answer, like the install offer"
  else
    fail "rules + \`actual --version\` exits ${code}: the reinstall offer lost the interrupt-and-wait wording" "$ctx"
  fi

  if [ "$(cat "$CALLS" 2>/dev/null)" = "--version" ]; then
    pass "\`actual --version\` exits ${code}: no \`actual version --json\` after it, which that CLI cannot answer either"
  else
    fail "\`actual --version\` exits ${code}: wrong CLI calls" "calls=$(cat "$CALLS" 2>/dev/null)"
  fi

  rm -f "$CALLS"
  st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_NO_RULES" ACTUAL_TEST_MODE=cannot-run ACTUAL_TEST_EXIT="$code" ACTUAL_TEST_CALLS="$CALLS")
  if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "$CALLS" ]; then
    pass "no rules + a CLI whose \`--version\` exits ${code}: silent, and \`actual\` is never run"
  else
    fail "no rules + \`actual --version\` exits ${code}: expected silence and no CLI call" "status=$st stdout=$(cat "${WORK}/out") calls=$(cat "$CALLS" 2>/dev/null)"
  fi
done

echo
echo "=== preflight: a CLI that does not answer ==="

# The bound is read from the library, like the floors. The fake prints its
# answer and then a child holds stdout open for HANG seconds, as npm's launcher
# would with the real binary stuck under it, so a hook that waited on the call
# or on a pipe from it would take HANG seconds. The answer printed before the
# hang must not be used either.
TIMEOUT=$(bash -c '. "$1" && printf "%s" "$CLI_CALL_TIMEOUT"' _ "${HOOKS_DIR}/lib/bootstrap.sh")
HANG=$((TIMEOUT + 7))

start=$SECONDS
st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$BELOW_GATES" ACTUAL_TEST_HANG=--version ACTUAL_TEST_HANG_SECONDS="$HANG")
elapsed=$((SECONDS - start))
ctx=$(session_context)
if [ "$st" = "0" ] && [ "$elapsed" -le $((TIMEOUT + 2)) ] \
   && printf '%s' "$ctx" | grep -q "governance is active" \
   && ! printf '%s' "$ctx" | grep -q "upgrade" \
   && ! printf '%s' "$ctx" | grep -q "does not run"; then
  pass "rules + \`actual --version\` that never finishes: given up after ${TIMEOUT}s (took ${elapsed}s) and read as an unreadable version, so no offer and no reinstall"
else
  fail "a --version that never finishes was not bounded, or was read as old or broken" "status=$st elapsed=${elapsed}s ctx=$ctx"
fi

start=$SECONDS
st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$REPO_WITH_RULES" ACTUAL_TEST_VERSION="$BELOW" ACTUAL_TEST_CHANNEL=npm ACTUAL_TEST_HANG=version ACTUAL_TEST_HANG_SECONDS="$HANG")
elapsed=$((SECONDS - start))
ctx=$(session_context)
if [ "$st" = "0" ] && [ "$elapsed" -le $((TIMEOUT + 2)) ] \
   && printf '%s' "$ctx" | grep -qF "CLI is ${BELOW}," \
   && printf '%s' "$ctx" | grep -q "npm install -g @actualai/actual@latest" \
   && printf '%s' "$ctx" | grep -q "brew upgrade actual-software/actual/actual"; then
  pass "rules + \`actual version --json\` that never finishes: given up after ${TIMEOUT}s (took ${elapsed}s), so both commands"
else
  fail "a version --json that never finishes was not bounded, or its partial answer was used" "status=$st elapsed=${elapsed}s ctx=$ctx"
fi

echo
echo "=== fake CLI requires --claude-hook ==="
env PATH="${TESTS_DIR}/bin:${PATH}" ACTUAL_TEST_MODE=allow \
    actual plan-check </dev/null >"${WORK}/out" 2>"${WORK}/err"
st=$?
if [ "$st" != "0" ] && grep -q -- '--claude-hook' "${WORK}/err"; then
  pass "fake CLI rejects plan-check without --claude-hook"
else
  fail "fake CLI must require --claude-hook" "status=$st stderr=$(cat "${WORK}/err")"
fi

echo
echo "=== rules directory override ==="
OVERRIDE_CAPTURE="${WORK}/captured-override.json"
env ACTUAL_RULES_DIR="${REPO_WITH_RULES}/.actual/rules" \
    PATH="${TESTS_DIR}/bin:${PATH}" CLAUDE_PROJECT_DIR="$REPO_NO_RULES" \
    ACTUAL_TEST_MODE=deny ACTUAL_TEST_CAPTURE="$OVERRIDE_CAPTURE" \
    bash "${HOOKS_DIR}/plan-gate.sh" < "${RESOLVED}/pretooluse-plan-file.json" > "${WORK}/out" 2>"${WORK}/err"
st=$?
if [ "$st" = "0" ] && [ "$(decision)" = "deny" ]; then
  pass "ACTUAL_RULES_DIR points the gate at another directory"
else
  fail "ACTUAL_RULES_DIR override ignored" "status=$st decision=$(decision)"
fi

if [ "$(argv_after --rules-dir "${OVERRIDE_CAPTURE}.argv")" = "${REPO_WITH_RULES}/.actual/rules" ]; then
  pass "ACTUAL_RULES_DIR is forwarded to the CLI as --rules-dir (not inferred from cwd)"
else
  fail "--rules-dir did not receive the override" "argv=$(cat "${OVERRIDE_CAPTURE}.argv" 2>/dev/null)"
fi

echo
echo "=== SessionStart matcher ==="
matcher=$(jq -r '.hooks.SessionStart[0].matcher // ""' "${HOOKS_DIR}/hooks.json")
missing=""
for src in startup resume clear compact fork; do
  case "$matcher" in
    *"$src"*) ;;
    *) missing="$missing $src" ;;
  esac
done
if [ -z "$missing" ]; then
  pass "SessionStart matcher includes startup, resume, clear, compact, and fork"
else
  fail "SessionStart matcher missing sources" "matcher=$matcher missing=$missing"
fi

echo
echo "=== repo root fallback (bogus CLAUDE_PROJECT_DIR) ==="

BOGUS="${WORK}/does-not-exist/nested/nope"

# A CLAUDE_PROJECT_DIR that does not name a directory must be ignored, not trusted:
# the hook falls back to the git toplevel of the working directory and still finds
# the rules there. Regression test for a path typo silently disabling the gate.
st=$(run_hook_cwd "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$BOGUS" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny)
if [ "$st" = "0" ] && [ "$(decision)" = "deny" ]; then
  pass "bogus project dir: falls back to the git root and still governs"
else
  fail "bogus project dir: fallback did not reach the rules" "status=$st decision=$(decision)"
fi

# Same bogus value, but the fallback lands somewhere with no rules: degrade quietly.
st=$(run_hook_cwd "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$BOGUS" "$REPO_NO_RULES" ACTUAL_TEST_MODE=deny)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
  pass "bogus project dir, no rules in fallback: silent no-op, no error"
else
  fail "bogus project dir should degrade quietly" "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err")"
fi

st=$(run_hook_cwd "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$BOGUS" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=allow)
if [ "$st" = "0" ] && [ "$(jq -r '.hookSpecificOutput.hookEventName' < "${WORK}/out" 2>/dev/null)" = "SessionStart" ]; then
  pass "preflight: bogus project dir falls back to the git root"
else
  fail "preflight fallback broken" "status=$st stdout=$(cat "${WORK}/out")"
fi

# An empty CLAUDE_PROJECT_DIR takes the same path as an unset one.
st=$(run_hook_cwd "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny)
if [ "$st" = "0" ] && [ "$(decision)" = "deny" ]; then
  pass "empty project dir: falls back to the git root and still governs"
else
  fail "empty project dir: fallback did not reach the rules" "status=$st decision=$(decision)"
fi

echo
echo "=== git worktree: the active checkout governs ==="

# Claude Code keeps CLAUDE_PROJECT_DIR on the ORIGINAL checkout after a session
# enters a git worktree, while running hooks from the worktree itself. The rules
# that apply are the active worktree's, on its own branch -- never the first
# checkout's. Regression test for a gate that scored plans against the wrong
# branch, or skipped governance entirely because the original checkout had none.
WT_MAIN="${WORK}/wt-main"
WT_LINKED="${WORK}/wt-linked"
mkdir -p "$WT_MAIN"
git -C "$WT_MAIN" init -q
git -C "$WT_MAIN" -c user.email=hooks@test.invalid -c user.name=hooks \
    commit -q --allow-empty -m init
git -C "$WT_MAIN" worktree add -q -b hook-test-branch "$WT_LINKED" >/dev/null 2>&1
worktree_ready=$?

if [ "$worktree_ready" -ne 0 ] || [ ! -d "$WT_LINKED" ]; then
  fail "could not create a git worktree fixture" "git worktree add failed"
else
  # Both checkouts governed, by different rule files: the worktree's must win.
  mkdir -p "${WT_MAIN}/.actual/rules" "${WT_LINKED}/.actual/rules"
  printf '# main\n**R-900** MUST: main checkout rule.\n' \
    > "${WT_MAIN}/.actual/rules/main-only.md"
  printf '# worktree\n**R-001** MUST: all persistence goes through the repository layer.\n' \
    > "${WT_LINKED}/.actual/rules/worktree-only.md"

  WT_CAPTURE="${WORK}/captured-worktree.json"
  st=$(run_hook_cwd "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-injected.json" \
       "$WT_MAIN" "$WT_LINKED" ACTUAL_TEST_MODE=deny ACTUAL_TEST_CAPTURE="$WT_CAPTURE")
  if [ "$(argv_after --rules-dir "${WT_CAPTURE}.argv")" = "${WT_LINKED}/.actual/rules" ]; then
    pass "worktree: --rules-dir is the active worktree's, not CLAUDE_PROJECT_DIR's"
  else
    fail "worktree: gate forwarded the wrong rules directory" \
         "status=$st argv=$(cat "${WT_CAPTURE}.argv" 2>/dev/null)"
  fi

  # The reported failure mode: only the worktree is governed. The gate must still
  # fire, rather than no-op because the original checkout has no rules.
  rm -rf "${WT_MAIN}/.actual"
  st=$(run_hook_cwd "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-injected.json" \
       "$WT_MAIN" "$WT_LINKED" ACTUAL_TEST_MODE=deny)
  if [ "$st" = "0" ] && [ "$(decision)" = "deny" ]; then
    pass "worktree governed, original checkout not: the gate still fires"
  else
    fail "worktree governance was skipped" "status=$st decision=$(decision)"
  fi

  # The mirror image: the active worktree is ungoverned, so nothing applies. Another
  # checkout's rules must not be enforced against it.
  rm -rf "${WT_LINKED}/.actual"
  mkdir -p "${WT_MAIN}/.actual/rules"
  printf '# main\n**R-900** MUST: main checkout rule.\n' \
    > "${WT_MAIN}/.actual/rules/main-only.md"
  st=$(run_hook_cwd "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-injected.json" \
       "$WT_MAIN" "$WT_LINKED" ACTUAL_TEST_MODE=deny)
  if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
    pass "ungoverned worktree: silent no-op, not the original checkout's rules"
  else
    fail "ungoverned worktree inherited another checkout's rules" \
         "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err")"
  fi
  # Claude Code's OWN worktrees live at <project>/.claude/worktrees/<name>, i.e.
  # nested INSIDE CLAUDE_PROJECT_DIR. Measured on 2.1.231: the session's cwd moves
  # there while CLAUDE_PROJECT_DIR stays on the original checkout. A containment
  # test alone would keep the original root and govern the wrong branch, so the
  # deeper of the two paths has to win.
  NESTED_WT="${WT_MAIN}/.claude/worktrees/nested"
  git -C "$WT_MAIN" worktree add -q -b hook-test-nested "$NESTED_WT" >/dev/null 2>&1
  if [ ! -d "$NESTED_WT" ]; then
    fail "could not create a nested worktree fixture" "git worktree add failed"
  else
    mkdir -p "${NESTED_WT}/.actual/rules"
    printf '# nested\n**R-001** MUST: all persistence goes through the repository layer.\n' \
      > "${NESTED_WT}/.actual/rules/nested-only.md"

    NESTED_CAPTURE="${WORK}/captured-nested.json"
    st=$(run_hook_cwd "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-injected.json" \
         "$WT_MAIN" "$NESTED_WT" ACTUAL_TEST_MODE=deny ACTUAL_TEST_CAPTURE="$NESTED_CAPTURE")
    if [ "$(argv_after --rules-dir "${NESTED_CAPTURE}.argv")" = "${NESTED_WT}/.actual/rules" ]; then
      pass "worktree nested under CLAUDE_PROJECT_DIR still governs itself"
    else
      fail "nested worktree resolved to the enclosing project root" \
           "status=$st argv=$(cat "${NESTED_CAPTURE}.argv" 2>/dev/null)"
    fi
  fi
fi

echo
echo "=== /cd: CLAUDE_PROJECT_DIR stays at the launch directory ==="

# A /cd moves the hooks' cwd and leaves CLAUDE_PROJECT_DIR where the session
# started (measured on Claude Code 2.1.301, through a /clear after the /cd as
# well). These are the /cd layouts register.test.ts pins for the mod. Every
# candidate root holds rules, so only the root resolve_repo_root picks decides
# the forwarded --rules-dir.
CD_REPO="${WORK}/cd-repo"
CD_OTHER="${WORK}/cd-other"
mkdir -p "${CD_REPO}/pkg/api" "${CD_OTHER}/pkg"
git -C "$CD_REPO" init -q
git -C "$CD_OTHER" init -q
for d in "$CD_REPO" "${CD_REPO}/pkg/api" "$CD_OTHER" "${CD_OTHER}/pkg"; do
  mkdir -p "${d}/.actual/rules"
  printf '# rules\n**R-001** MUST: all persistence goes through the repository layer.\n' \
    > "${d}/.actual/rules/rules.md"
done

cd_case() {
  local name="$1" launch="$2" moved="$3" want="$4" capture="${WORK}/captured-cd.json"
  rm -f "$capture" "${capture}.argv"
  run_hook_cwd "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-injected.json" \
    "$launch" "$moved" ACTUAL_TEST_MODE=deny ACTUAL_TEST_CAPTURE="$capture" >/dev/null
  if [ "$(argv_after --rules-dir "${capture}.argv")" = "${want}/.actual/rules" ]; then
    pass "/cd $name: the gate keeps the root resolve_repo_root picks"
  else
    fail "/cd $name: wrong rules directory" "argv=$(cat "${capture}.argv" 2>/dev/null)"
  fi
}

cd_case "into a subdirectory" "$CD_REPO" "${CD_REPO}/pkg/api" "$CD_REPO"
cd_case "from a subdirectory launch to the checkout root" "${CD_REPO}/pkg/api" "$CD_REPO" "${CD_REPO}/pkg/api"
cd_case "into another repository's subdirectory" "$CD_REPO" "${CD_OTHER}/pkg" "$CD_OTHER"
cd_case "into another repository" "$CD_REPO" "$CD_OTHER" "$CD_OTHER"

echo
echo "=== monorepo subproject (CLAUDE_PROJECT_DIR below the git root) ==="

# The case CLAUDE_PROJECT_DIR must still win: Claude Code launched inside a
# subdirectory of a larger repo. cwd is within the project dir, so the subproject
# stays the root even though the git toplevel is higher up and has no rules.
MONO="${WORK}/mono"
MONO_SUB="${MONO}/packages/service"
mkdir -p "${MONO_SUB}/.actual/rules"
git -C "$MONO" init -q 2>/dev/null || git init -q "$MONO"
printf '# subproject\n**R-001** MUST: all persistence goes through the repository layer.\n' \
  > "${MONO_SUB}/.actual/rules/subproject.md"

st=$(run_hook_cwd "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-injected.json" \
     "$MONO_SUB" "$MONO_SUB" ACTUAL_TEST_MODE=deny)
if [ "$st" = "0" ] && [ "$(decision)" = "deny" ]; then
  pass "monorepo: CLAUDE_PROJECT_DIR below the git root still governs"
else
  fail "monorepo subproject root was discarded" "status=$st decision=$(decision)"
fi

# Same subproject root, but the hook runs from a nested directory inside it.
mkdir -p "${MONO_SUB}/src/handlers"
st=$(run_hook_cwd "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-injected.json" \
     "$MONO_SUB" "${MONO_SUB}/src/handlers" ACTUAL_TEST_MODE=deny)
if [ "$st" = "0" ] && [ "$(decision)" = "deny" ]; then
  pass "monorepo: a nested cwd inside the project dir keeps that root"
else
  fail "nested cwd lost the project root" "status=$st decision=$(decision)"
fi

echo
echo "=== rules-brief: PostToolUse Read ==="
RB="${HOOKS_DIR}/rules-brief.sh"
GOV="${RESOLVED}/posttooluse-read-governed.json"
UNGOV="${RESOLVED}/posttooluse-read-ungoverned.json"

rb_ctx() { jq -r '.hookSpecificOutput.additionalContext // ""' < "${WORK}/out" 2>/dev/null; }

CAPTURE_RB="${WORK}/captured-rb.json"
st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief ACTUAL_TEST_CAPTURE="$CAPTURE_RB")
if [ "$st" = "0" ] \
   && [ "$(jq -r '.hookSpecificOutput.hookEventName' < "${WORK}/out")" = "PostToolUse" ] \
   && [ "$(rb_ctx)" = "R-001 MUST: all persistence goes through the repository layer." ] \
   && [ "$(decision)" = "none" ]; then
  pass "governed file: PostToolUse additionalContext delivered, no permissionDecision"
else
  fail "governed file: expected a PostToolUse brief" "status=$st stdout=$(cat "${WORK}/out")"
fi

if [ "$(jq -r '.tool_name' "$CAPTURE_RB")" = "Read" ] \
   && grep -q "src/persistence/user_store.ts" "$CAPTURE_RB" \
   && grep -Fxq -- '--claude-hook' "${CAPTURE_RB}.argv" \
   && [ "$(argv_after --rules-dir "${CAPTURE_RB}.argv")" = "${REPO_WITH_RULES}/.actual/rules" ] \
   && [ "$(argv_after --repo "${CAPTURE_RB}.argv")" = "${REPO_WITH_RULES}" ] \
   && [ "$(sed -n 1,2p "${CAPTURE_RB}.argv" | tr '\n' ' ')" = "--claude-hook --repo " ]; then
  pass "raw envelope, --claude-hook, --repo and --rules-dir reach 'actual rules brief'"
else
  fail "rules-brief invocation wrong" "argv=$(cat "${CAPTURE_RB}.argv" 2>/dev/null)"
fi

# The root must be stated, not inferred. Without `--repo` the CLI takes it from
# the envelope's `cwd`, which follows the agent's `cd`, and places every file
# against whatever directory the shell happens to be in.
if [ "$(argv_after --repo "${CAPTURE_RB}.argv")" = "${REPO_WITH_RULES}" ]; then
  pass "the root is passed explicitly, so a cd cannot move it"
else
  fail "--repo missing or wrong" "argv=$(cat "${CAPTURE_RB}.argv" 2>/dev/null)"
fi

st=$(run_hook "$RB" "$UNGOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
  pass "ungoverned file: silent (exit 0, no stdout, no stderr)"
else
  fail "ungoverned file: expected silence" "status=$st stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief-pretty)
if [ "$st" = "0" ] && [ "$(rb_ctx)" != "" ]; then
  pass "trailing whitespace on the CLI reply is tolerated"
else
  fail "trailing whitespace case" "status=$st stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief-quoted)
if [ "$st" = "0" ] \
   && [ "$(rb_ctx)" = 'R-001 MUST: no raw "SELECT" in handlers (see docs\\rules).' ]; then
  pass "a brief quoting a rule (escaped quotes and backslashes) is still forwarded"
else
  fail "escaped-quote brief was dropped" "status=$st stdout=$(cat "${WORK}/out")"
fi

# brief-trailing-* and brief-inner-extra-field start and end with the
# allowlisted bytes but decode to extra top-level or inner fields --
# continue:false halts the agent outright. Matching only the opening and
# closing bytes forwards all three.
for mode in brief-permission brief-extra-field brief-trailing-field \
            brief-trailing-decision brief-inner-extra-field brief-wrong-event \
            brief-escaped garbage; do
  st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE="$mode")
  if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
    pass "$mode: not an allowlisted shape, dropped silently"
  else
    fail "$mode: expected the reply to be dropped" "status=$st stdout=$(cat "${WORK}/out")"
  fi
done

for mode in crash no-rules-brief; do
  st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE="$mode")
  if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
    pass "$mode: fails open silently"
  else
    fail "$mode: expected silent exit 0" "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err")"
  fi
done

st=$(run_hook_no_cli "$RB" "$GOV" "$REPO_WITH_RULES")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
  pass "no CLI: silent (preflight owns the install prompt)"
else
  fail "no CLI: expected silence" "status=$st stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "$RB" "$GOV" "$REPO_NO_RULES" ACTUAL_TEST_MODE=brief)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
  pass "no committed rules: silent no-op"
else
  fail "no committed rules: expected silence" "status=$st stdout=$(cat "${WORK}/out")"
fi

# This hook runs on every Read inside a 2-second timeout, so the repo root is
# resolved once and reused. Each resolution spawns `git rev-parse`; calling
# rules_present, rules_dir and resolve_repo_root separately (as the 180-second
# gates do) spawns three. Counted with a shim ahead of the real git on PATH.
GITSHIM="${WORK}/gitshim"
mkdir -p "$GITSHIM"
cat > "${GITSHIM}/git" <<'SHIM'
#!/bin/sh
echo "$@" >> "$GIT_CALL_LOG"
exec /usr/bin/git "$@"
SHIM
chmod +x "${GITSHIM}/git"
GIT_LOG="${WORK}/git-calls.log"
: > "$GIT_LOG"
st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief \
     GIT_CALL_LOG="$GIT_LOG" PATH="${GITSHIM}:${TESTS_DIR}/bin:${PATH}")
GIT_CALLS=$(grep -c . "$GIT_LOG" 2>/dev/null || echo 0)
if [ "$st" = "0" ] && [ "$(rb_ctx)" != "" ] && [ "$GIT_CALLS" -eq 1 ]; then
  pass "repo root resolved once per Read: exactly 1 git spawn, not 3"
else
  fail "rules-brief spawns git more than once" "status=$st git_calls=$GIT_CALLS calls=$(tr '\n' '; ' < "$GIT_LOG")"
fi

# Not briefing the same rules twice in a session is the CLI's job, but it can
# only do it if the hook hands over the session identity -- which it does by
# forwarding the envelope whole. That half of the contract is testable here.
if [ "$(jq -r '.session_id' "$CAPTURE_RB")" = "test-session-read" ]; then
  pass "session_id reaches the CLI, so it can dedupe briefs within a session"
else
  fail "session_id not forwarded" "captured=$(cat "$CAPTURE_RB" 2>/dev/null)"
fi

st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief ACTUAL_PLAN_GATE=off)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
  pass "ACTUAL_PLAN_GATE=off: silent no-op"
else
  fail "opt-out did not disable the brief" "status=$st stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief ACTUAL_CLI_SUBPROCESS=1 ACTUAL_TEST_CAPTURE="${WORK}/rb-subprocess-capture")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -f "${WORK}/rb-subprocess-capture" ]; then
  pass "ACTUAL_CLI_SUBPROCESS=1: silent no-op that never invokes the CLI"
else
  fail "rules-brief ran inside an actual-cli subprocess" "status=$st stdout=$(cat "${WORK}/out")"
fi

# The mod (register.js) briefs Reads itself where it loads, and marks the
# event it passes down rather than skipping the settings hooks beneath it --
# skipping would silence every other PostToolUse:Read hook too. Compact, as
# the engine writes it.
MARKED="${WORK}/posttooluse-read-marked.json"
jq -c '. + {actual_rules_brief_by_mod: true}' "$GOV" > "$MARKED"
st=$(run_hook "$RB" "$MARKED" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief ACTUAL_TEST_CAPTURE="${WORK}/rb-marked-capture")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -f "${WORK}/rb-marked-capture" ]; then
  pass "an event the mod marked: stands down without invoking the CLI"
else
  fail "rules-brief briefed an event the mod owns" "status=$st stdout=$(cat "${WORK}/out")"
fi

# A file whose text spells the marker cannot stand the hook down: inside
# tool_response its quotes arrive escaped.
FORGED="${WORK}/posttooluse-read-forged.json"
jq -c '.tool_response.file.content = "{\"actual_rules_brief_by_mod\":true}"' "$GOV" > "$FORGED"
st=$(run_hook "$RB" "$FORGED" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief)
if [ "$st" = "0" ] && [ "$(rb_ctx)" != "" ]; then
  pass "the marker spelled inside file content does not stand the hook down"
else
  fail "file content forged the stand-down marker" "status=$st stdout=$(cat "${WORK}/out")"
fi

st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief ACTUAL_RULES_BRIEF=off)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
  pass "ACTUAL_RULES_BRIEF=off: briefing alone is disabled"
else
  fail "granular opt-out did not disable the brief" "status=$st stdout=$(cat "${WORK}/out")"
fi

# ...and it must disable ONLY briefing: the gates answer to ACTUAL_PLAN_GATE.
st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "${RESOLVED}/pretooluse-plan-file.json" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=deny ACTUAL_RULES_BRIEF=off)
if [ "$(decision)" = "deny" ]; then
  pass "ACTUAL_RULES_BRIEF=off leaves the plan gate blocking"
else
  fail "granular opt-out leaked into the plan gate" "decision=$(decision) stdout=$(cat "${WORK}/out")"
fi

# Every failure on this path is silent by contract, so ACTUAL_HOOK_DEBUG is the
# only way to tell a working brief from one that is being dropped.
st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief-trailing-field ACTUAL_HOOK_DEBUG=1)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] \
   && grep -q "dropped (content is not a single JSON string)" "${WORK}/err"; then
  pass "ACTUAL_HOOK_DEBUG names the drop reason on stderr, stdout still silent"
else
  fail "debug switch did not explain the drop" "status=$st stdout=$(cat "${WORK}/out") stderr=$(cat "${WORK}/err")"
fi

st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=no-brief-ungoverned ACTUAL_HOOK_DEBUG=1)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] \
   && grep -q "cli-stderr:.*no-brief=ungoverned" "${WORK}/err"; then
  pass "the CLI's reason for staying quiet reaches the debug stream, not stdout"
else
  fail "debug switch did not carry the no-brief reason" "status=$st stderr=$(cat "${WORK}/err")"
fi

st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=crash ACTUAL_HOOK_DEBUG=1)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] \
   && grep -q "cli-stderr:.*panicked" "${WORK}/err"; then
  pass "ACTUAL_HOOK_DEBUG surfaces a CLI crash that is otherwise swallowed"
else
  fail "debug switch did not surface the crash" "status=$st stderr=$(cat "${WORK}/err")"
fi

# Without the switch, a crash leaves no trace at all -- the fail-open contract.
st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=crash)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
  pass "without ACTUAL_HOOK_DEBUG the same crash stays completely silent"
else
  fail "debug output leaked without the switch" "stderr=$(cat "${WORK}/err")"
fi

if [ "$(jq -r '.hooks.PostToolUse[0].matcher' "${HOOKS_DIR}/hooks.json")" = "Read" ] \
   && [ "$(jq -r '.hooks.PostToolUse[0].hooks[0].command' "${HOOKS_DIR}/hooks.json")" = '"${CLAUDE_PLUGIN_ROOT}"/hooks/rules-brief.sh' ] \
   && [ "$(jq -r '.hooks.PostToolUse[0].hooks[0].timeout' "${HOOKS_DIR}/hooks.json")" = "2" ]; then
  pass "hooks.json registers PostToolUse:Read -> rules-brief.sh with the 2s timeout"
else
  fail "hooks.json PostToolUse registration wrong" "$(jq -c '.hooks.PostToolUse' "${HOOKS_DIR}/hooks.json" 2>/dev/null)"
fi

echo
echo "=== rules-brief: PreToolUse Edit|Write (AK-794) ==="
# The reminder path, for files written without a Read first. Same script, so
# the guards above all apply; these cover what differs: the event the reply
# names, the marker's place in the envelope, and the dedupe it shares with Read.
PRE_EDIT="${RESOLVED}/pretooluse-edit-governed.json"
PRE_WRITE="${RESOLVED}/pretooluse-write-governed.json"
PRE_UNGOV="${RESOLVED}/pretooluse-write-ungoverned.json"

for fixture in "$PRE_EDIT" "$PRE_WRITE"; do
  tool=$(jq -r '.tool_name' "$fixture")
  st=$(run_hook "$RB" "$fixture" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief)
  if [ "$st" = "0" ] \
     && [ "$(jq -r '.hookSpecificOutput.hookEventName' < "${WORK}/out")" = "PreToolUse" ] \
     && [ "$(rb_ctx)" = "R-001 MUST: all persistence goes through the repository layer." ] \
     && [ "$(decision)" = "none" ]; then
    pass "$tool of a governed file: PreToolUse brief delivered, no permissionDecision"
  else
    fail "$tool of a governed file: expected a PreToolUse brief" "status=$st stdout=$(cat "${WORK}/out")"
  fi
done

CAPTURE_PRE="${WORK}/captured-pre.json"
st=$(run_hook "$RB" "$PRE_WRITE" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief ACTUAL_TEST_CAPTURE="$CAPTURE_PRE")
if [ "$(jq -r '.hook_event_name + ":" + .tool_name' "$CAPTURE_PRE")" = "PreToolUse:Write" ] \
   && [ "$(argv_after --repo "${CAPTURE_PRE}.argv")" = "${REPO_WITH_RULES}" ] \
   && [ "$(argv_after --rules-dir "${CAPTURE_PRE}.argv")" = "${REPO_WITH_RULES}/.actual/rules" ]; then
  pass "a Write's envelope reaches the CLI whole, with --repo and --rules-dir"
else
  fail "PreToolUse invocation wrong" "argv=$(cat "${CAPTURE_PRE}.argv" 2>/dev/null)"
fi

st=$(run_hook "$RB" "$PRE_UNGOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -s "${WORK}/err" ]; then
  pass "Write of an ungoverned file: silent"
else
  fail "Write of an ungoverned file: expected silence" "status=$st stdout=$(cat "${WORK}/out")"
fi

# A reply must name the event it answers. A PostToolUse reply to a PreToolUse
# call is a CLI out of step with its input; forwarding it would hand Claude
# Code a mismatched hookEventName.
st=$(run_hook "$RB" "$PRE_EDIT" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief-wrong-event)
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
  pass "a PostToolUse reply to a PreToolUse call is dropped"
else
  fail "mismatched event was forwarded" "status=$st stdout=$(cat "${WORK}/out")"
fi

for mode in brief-permission brief-trailing-field brief-escaped; do
  st=$(run_hook "$RB" "$PRE_EDIT" "$REPO_WITH_RULES" ACTUAL_TEST_MODE="$mode")
  if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
    pass "PreToolUse $mode: dropped, so no decision can reach the permission flow"
  else
    fail "PreToolUse $mode: expected the reply to be dropped" "status=$st stdout=$(cat "${WORK}/out")"
  fi
done

NO_EVENT="${WORK}/no-event.json"
jq -c 'del(.hook_event_name)' "$PRE_EDIT" > "$NO_EVENT"
st=$(run_hook "$RB" "$NO_EVENT" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief ACTUAL_TEST_CAPTURE="${WORK}/rb-no-event-capture")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -f "${WORK}/rb-no-event-capture" ]; then
  pass "an envelope naming no event: silent, CLI never invoked"
else
  fail "envelope with no event was briefed" "status=$st stdout=$(cat "${WORK}/out")"
fi

# Shared dedupe, per the acceptance criteria: a file briefed via Read adds
# nothing when edited, and a file never read is briefed when written.
STATE="${WORK}/brief-state"
rm -f "$STATE"
st=$(run_hook "$RB" "$GOV" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief-dedupe ACTUAL_TEST_STATE="$STATE")
read_out=$(rb_ctx)
st2=$(run_hook "$RB" "$PRE_EDIT" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief-dedupe ACTUAL_TEST_STATE="$STATE")
edit_out=$(cat "${WORK}/out")
st3=$(run_hook "$RB" "$PRE_WRITE" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief-dedupe ACTUAL_TEST_STATE="$STATE")
if [ "$st" = "0" ] && [ -n "$read_out" ] && [ "$st2" = "0" ] && [ -z "$edit_out" ] \
   && [ "$st3" = "0" ] && [ "$(rb_ctx)" != "" ]; then
  pass "Edit of a file briefed via Read adds nothing; Write of a file never read is briefed"
else
  fail "shared dedupe across Read and Edit|Write" "read=$read_out edit=$edit_out write=$(cat "${WORK}/out")"
fi

# The mod announces itself by setting ACTUAL_SKILL_MOD_SESSION to its session
# id before this hook runs; a field in the tool's arguments would reach the
# permission check, and auto mode refuses to judge a Write that carries one.
st=$(run_hook "$RB" "$PRE_EDIT" "$REPO_WITH_RULES" ACTUAL_SKILL_MOD_SESSION=test-session-read ACTUAL_TEST_MODE=brief ACTUAL_TEST_CAPTURE="${WORK}/rb-pre-mod-capture")
if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -f "${WORK}/rb-pre-mod-capture" ]; then
  pass "a PreToolUse event in a session the mod announced: stands down without invoking the CLI"
else
  fail "rules-brief briefed a PreToolUse event the mod owns" "status=$st stdout=$(cat "${WORK}/out")"
fi

# A `claude` started from inside a session inherits the variable under a
# session id of its own; with no mod loaded there, this hook is the only brief.
st=$(run_hook "$RB" "$PRE_WRITE" "$REPO_WITH_RULES" ACTUAL_SKILL_MOD_SESSION=another-session ACTUAL_TEST_MODE=brief)
if [ "$st" = "0" ] && [ "$(rb_ctx)" != "" ]; then
  pass "another session's announcement does not stand the hook down"
else
  fail "an announcement for one session silenced another" "status=$st stdout=$(cat "${WORK}/out")"
fi

# Content ahead of the real session_id, so the hook's first match would be the
# spelled one if escaping did not rule it out.
SPELLED_SESSION="${WORK}/pretooluse-spelled-session.json"
jq -c '. as $o | {tool_input: ($o.tool_input + {content: "{\"session_id\":\"test-session-read\"}"})} + ($o | del(.tool_input)) | .session_id = "unannounced"' "$PRE_WRITE" > "$SPELLED_SESSION"
st=$(run_hook "$RB" "$SPELLED_SESSION" "$REPO_WITH_RULES" ACTUAL_SKILL_MOD_SESSION=test-session-read ACTUAL_TEST_MODE=brief)
if [ "$st" = "0" ] && [ "$(rb_ctx)" != "" ]; then
  pass "an announced session id spelled inside a Write's content does not stand the hook down"
else
  fail "Write content forged an announced session" "status=$st stdout=$(cat "${WORK}/out")"
fi

PRE_FORGED="${WORK}/pretooluse-forged.json"
jq -c '.tool_input.content = "{\"actual_rules_brief_by_mod\":true}"' "$PRE_WRITE" > "$PRE_FORGED"
st=$(run_hook "$RB" "$PRE_FORGED" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief)
if [ "$st" = "0" ] && [ "$(rb_ctx)" != "" ]; then
  pass "the marker spelled inside a Write's content does not stand the hook down"
else
  fail "Write content forged the stand-down marker" "status=$st stdout=$(cat "${WORK}/out")"
fi

for switch in ACTUAL_RULES_BRIEF=off ACTUAL_PLAN_GATE=off ACTUAL_CLI_SUBPROCESS=1; do
  st=$(run_hook "$RB" "$PRE_WRITE" "$REPO_WITH_RULES" ACTUAL_TEST_MODE=brief "$switch")
  if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ]; then
    pass "$switch: the PreToolUse reminder is off too"
  else
    fail "$switch did not disable the PreToolUse reminder" "status=$st stdout=$(cat "${WORK}/out")"
  fi
done

if [ "$(jq -r '.hooks.PreToolUse[] | select(.matcher=="Edit|Write") | .hooks[0].command' "${HOOKS_DIR}/hooks.json")" = '"${CLAUDE_PLUGIN_ROOT}"/hooks/rules-brief.sh' ] \
   && [ "$(jq -r '.hooks.PreToolUse[] | select(.matcher=="Edit|Write") | .hooks[0].timeout' "${HOOKS_DIR}/hooks.json")" = "2" ] \
   && [ "$(jq -r '.hooks.PreToolUse[] | select(.matcher=="ExitPlanMode") | .hooks[0].command' "${HOOKS_DIR}/hooks.json")" = '"${CLAUDE_PLUGIN_ROOT}"/hooks/plan-gate.sh' ]; then
  pass "hooks.json registers PreToolUse:Edit|Write -> rules-brief.sh beside the ExitPlanMode gate"
else
  fail "hooks.json PreToolUse registration wrong" "$(jq -c '.hooks.PreToolUse' "${HOOKS_DIR}/hooks.json" 2>/dev/null)"
fi

echo
echo "=== plugin manifest ==="

# hooks/hooks.json is loaded automatically by convention. Declaring it again via the
# manifest's `hooks` key registers it twice, which Claude Code reports as
# "Duplicate hooks file detected" and marks the whole plugin hook-load-failed.
# The manifest may only point at ADDITIONAL hook files.
MANIFEST="${HOOKS_DIR}/../.claude-plugin/plugin.json"
if grep -qE '"hooks"[[:space:]]*:' "$MANIFEST" 2>/dev/null; then
  fail "manifest re-declares hooks/hooks.json" "the conventional path is auto-loaded; declaring it again fails plugin hook loading"
else
  pass "manifest does not re-declare the conventional hooks/hooks.json"
fi

if [ -f "${HOOKS_DIR}/hooks.json" ]; then
  pass "hooks/hooks.json exists at the conventional auto-loaded path"
else
  fail "hooks/hooks.json missing from the conventional path" ""
fi

if [ "$(jq -r '.hooks.Stop[0].hooks[0].command' "${HOOKS_DIR}/hooks.json")" = '"${CLAUDE_PLUGIN_ROOT}"/hooks/impl-gate.sh' ] \
   && [ "$(jq -r '.hooks.Stop[0].matcher // "none"' "${HOOKS_DIR}/hooks.json")" = "none" ]; then
  pass "hooks.json registers Stop -> impl-gate.sh, with no matcher (Stop has no matcher support)"
else
  fail "hooks.json Stop registration wrong" "$(jq -c '.hooks.Stop' "${HOOKS_DIR}/hooks.json" 2>/dev/null)"
fi

if [ "$(jq -r '.hooks.UserPromptSubmit[0].hooks[0].command' "${HOOKS_DIR}/hooks.json")" = '"${CLAUDE_PLUGIN_ROOT}"/hooks/turn-start.sh' ] \
   && [ "$(jq -r '.hooks.UserPromptSubmit[0].matcher // "none"' "${HOOKS_DIR}/hooks.json")" = "none" ]; then
  pass "hooks.json registers UserPromptSubmit -> turn-start.sh, with no matcher"
else
  fail "hooks.json UserPromptSubmit registration wrong" "$(jq -c '.hooks.UserPromptSubmit' "${HOOKS_DIR}/hooks.json" 2>/dev/null)"
fi

echo
echo "=== dependency hygiene ==="
if grep -nE '(^|[^-_[:alnum:]])(jq|python3?|node)([^-_[:alnum:]]|$)' \
     "${HOOKS_DIR}/plan-gate.sh" "${HOOKS_DIR}/impl-gate.sh" "${HOOKS_DIR}/preflight.sh" "${HOOKS_DIR}/rules-brief.sh" "${HOOKS_DIR}/lib/bootstrap.sh" \
     | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' > "${WORK}/deps" 2>/dev/null; then
  fail "shipped hooks reference a JSON/runtime dependency" "$(cat "${WORK}/deps")"
else
  pass "shipped hooks reference no jq/python/node"
fi

# The mod is not shell, so the jq/python/node rule does not apply to it -- it
# runs inside Claude Code and adds no system dependency. The invariant that
# does apply is narrower: the only processes it may spawn are the `actual` CLI
# (the brief itself, the once-a-session `rules brief --help` probe for the
# subcommand, and `session summary` for the count above the prompt) and the one
# read-only `git` query it needs -- `rev-parse` for the repository root.
# `claude plugin validate` reports that it calls $.process.run at all; this
# pins what it runs. Comment lines are stripped first, or the file's own
# prose about $.process.run would count as a call site.
MOD_CODE="${WORK}/register.nocomments.js"
grep -vE '^[[:space:]]*(//|\*|/\*)' "${HOOKS_DIR}/register.js" > "$MOD_CODE"
SPAWNS=$(grep -c '\$\.process\.run(' "$MOD_CODE" || true)
ALLOWED=$(grep -cE "'actual', 'rules', 'brief'|'actual', 'session', 'summary'|'git', 'rev-parse'" "$MOD_CODE" || true)
if [ "$SPAWNS" = "4" ] && [ "$ALLOWED" = "4" ]; then
  pass "the mod spawns nothing but the actual CLI and git rev-parse"
else
  fail "the mod spawns an unexpected process" \
       "process.run sites=$SPAWNS allowed=$ALLOWED"
fi

# Both briefing paths must forward --rules-dir, or they land on different
# brief-memory keys (session_id + agent_id + rules_dir) and one read briefs
# twice -- and in a monorepo the mod governs against the wrong rule set.
for f in "${HOOKS_DIR}/rules-brief.sh" "${HOOKS_DIR}/register.js"; do
  if grep -q -- "--rules-dir" "$f" && grep -q "ACTUAL_RULES_DIR" "$f" \
     || { [ "$(basename "$f")" = "rules-brief.sh" ] && grep -q -- "--rules-dir" "$f"; }; then
    pass "$(basename "$f") forwards --rules-dir"
  else
    fail "$(basename "$f") does not forward --rules-dir" ""
  fi
done

for f in "${HOOKS_DIR}/plan-gate.sh" "${HOOKS_DIR}/impl-gate.sh" "${HOOKS_DIR}/preflight.sh" "${HOOKS_DIR}/rules-brief.sh"; do
  if [ -x "$f" ]; then pass "$(basename "$f") is executable"; else fail "$(basename "$f") is not executable" ""; fi
done

echo "=== ADR header v2: version gate (AK-963) ==="

# {v1 files, v2 files} x {old CLI, current CLI}. Only (v2, old) changes anything.
REPO_V2="${WORK}/with-rules-v2"
mkdir -p "${REPO_V2}/.actual/rules"
git -C "${REPO_V2}" init -q
printf -- '---\nadr_id: persistence\nroot: .\npaths:\n  - "src/persistence/**"\n---\n# Persistence\n\n### Rules\n**R-001** MUST: all persistence goes through the repository layer.\n' \
  > "${REPO_V2}/.actual/rules/persistence.md"
# CRLF line endings must not hide the header.
REPO_V2_CRLF="${WORK}/with-rules-v2-crlf"
mkdir -p "${REPO_V2_CRLF}/.actual/rules"
git -C "${REPO_V2_CRLF}" init -q
printf -- '---\r\nadr_id: persistence\r\n---\r\n# Persistence\r\n' > "${REPO_V2_CRLF}/.actual/rules/persistence.md"

V2_PLAN="${RESOLVED}/pretooluse-plan-file.json"
V2_STOP="${RESOLVED}/stop-turn.json"

for pair in "v1:$REPO_WITH_RULES" "v2:$REPO_V2" "v2-crlf:$REPO_V2_CRLF"; do
  label=${pair%%:*}; repo=${pair#*:}
  for cli in current old; do
    mode=allow; [ "$cli" = old ] && mode=no-adr-v2
    expect_notice=0; [ "$label" != v1 ] && [ "$cli" = old ] && expect_notice=1

    # SessionStart: the upgrade message replaces the success message.
    st=$(run_hook "${HOOKS_DIR}/preflight.sh" "${RESOLVED}/sessionstart-startup.json" "$repo" ACTUAL_TEST_MODE="$mode")
    ctx=$(jq -r '.hookSpecificOutput.additionalContext // ""' < "${WORK}/out" 2>/dev/null)
    if [ "$expect_notice" = 1 ]; then
      if [ "$st" = "0" ] && printf '%s' "$ctx" | grep -q "ADR header v2" && printf '%s' "$ctx" | grep -q "0.9.0" \
         && printf '%s' "$ctx" | grep -q "AskUserQuestion" && ! printf '%s' "$ctx" | grep -q "governance is active"; then
        pass "preflight ($label, $cli CLI): upgrade message, no success message"
      else
        fail "preflight ($label, $cli CLI): expected the v2 upgrade message" "status=$st ctx=$ctx"
      fi
    else
      if [ "$st" = "0" ] && printf '%s' "$ctx" | grep -q "governance is active" && ! printf '%s' "$ctx" | grep -q "ADR header v2"; then
        pass "preflight ($label, $cli CLI): unchanged success message"
      else
        fail "preflight ($label, $cli CLI): expected the ordinary success message" "status=$st ctx=$ctx"
      fi
    fi

    # ExitPlanMode gate: a one-line notice, no deny, no call to plan-check.
    cap="${WORK}/v2-capture"; rm -f "$cap" "${cap}.argv"
    st=$(run_hook "${HOOKS_DIR}/plan-gate.sh" "$V2_PLAN" "$repo" ACTUAL_TEST_MODE="$mode" ACTUAL_TEST_CAPTURE="$cap")
    if [ "$expect_notice" = 1 ]; then
      if [ "$st" = "0" ] && jq -e '.systemMessage | test("ADR header v2")' "${WORK}/out" >/dev/null 2>&1 \
         && ! grep -q "permissionDecision" "${WORK}/out" && [ ! -e "${cap}.argv" ]; then
        pass "plan-gate ($label, $cli CLI): stands down with a notice, plan-check not called"
      else
        fail "plan-gate ($label, $cli CLI): expected a stand-down notice" "status=$st stdout=$(cat "${WORK}/out")"
      fi
    else
      if [ "$st" = "0" ] && ! grep -q "ADR header v2" "${WORK}/out" && [ -e "${cap}.argv" ]; then
        pass "plan-gate ($label, $cli CLI): delegates to plan-check as before"
      else
        fail "plan-gate ($label, $cli CLI): expected plan-check to run" "status=$st stdout=$(cat "${WORK}/out")"
      fi
    fi

    # Stop gate: a user-facing systemMessage, never a block.
    rm -f "$cap" "${cap}.argv"
    st=$(run_hook "${HOOKS_DIR}/impl-gate.sh" "$V2_STOP" "$repo" ACTUAL_TEST_MODE="$mode" ACTUAL_TEST_CAPTURE="$cap")
    if [ "$expect_notice" = 1 ]; then
      if [ "$st" = "0" ] && jq -e '.systemMessage | test("ADR header v2")' "${WORK}/out" >/dev/null 2>&1 \
         && ! jq -e 'has("decision")' "${WORK}/out" >/dev/null 2>&1 && [ ! -e "${cap}.argv" ]; then
        pass "impl-gate ($label, $cli CLI): stands down with a notice, impl-check not called"
      else
        fail "impl-gate ($label, $cli CLI): expected a stand-down notice" "status=$st stdout=$(cat "${WORK}/out")"
      fi
    else
      if [ "$st" = "0" ] && ! grep -q "ADR header v2" "${WORK}/out" && [ -e "${cap}.argv" ]; then
        pass "impl-gate ($label, $cli CLI): delegates to impl-check as before"
      else
        fail "impl-gate ($label, $cli CLI): expected impl-check to run" "status=$st stdout=$(cat "${WORK}/out")"
      fi
    fi

    # Turn start: nothing to record when the Stop gate stands down.
    rm -f "$cap" "${cap}.argv"
    st=$(run_hook "${HOOKS_DIR}/turn-start.sh" "${RESOLVED}/userpromptsubmit-turn.json" "$repo" ACTUAL_TEST_MODE="$mode" ACTUAL_TEST_CAPTURE="$cap")
    if [ "$expect_notice" = 1 ]; then
      if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -e "${cap}.argv" ]; then
        pass "turn-start ($label, $cli CLI): silent, nothing recorded"
      else
        fail "turn-start ($label, $cli CLI): expected silence" "status=$st stdout=$(cat "${WORK}/out")"
      fi
    else
      if [ "$st" = "0" ] && [ -e "${cap}.argv" ]; then
        pass "turn-start ($label, $cli CLI): records the turn as before"
      else
        fail "turn-start ($label, $cli CLI): expected the turn to be recorded" "status=$st"
      fi
    fi

    # Read-time briefing: silent either way on the stand-down path (no brief
    # reaches the model), and the CLI is not asked to build one.
    rm -f "$cap" "${cap}.argv"
    st=$(run_hook "$RB" "$GOV" "$repo" ACTUAL_TEST_MODE=brief ACTUAL_TEST_CAPTURE="$cap" ACTUAL_TEST_ADR_V2="$cli")
    if [ "$expect_notice" = 1 ]; then
      if [ "$st" = "0" ] && [ ! -s "${WORK}/out" ] && [ ! -e "${cap}.argv" ]; then
        pass "rules-brief ($label, $cli CLI): stands down, no brief requested"
      else
        fail "rules-brief ($label, $cli CLI): expected a silent stand-down" "status=$st stdout=$(cat "${WORK}/out")"
      fi
    elif [ "$label" = v2 ] || [ "$label" = v1 ]; then
      # The governed path in the fake CLI is /src/persistence/ under REPO_WITH_RULES.
      if [ "$st" = "0" ] && { [ "$label" = v2 ] || jq -e '.hookSpecificOutput.additionalContext' "${WORK}/out" >/dev/null 2>&1; } && [ -e "${cap}.argv" ]; then
        pass "rules-brief ($label, $cli CLI): the CLI is asked for a brief as before"
      else
        fail "rules-brief ($label, $cli CLI): expected the CLI to be called" "status=$st stdout=$(cat "${WORK}/out")"
      fi
    fi
  done
done

echo
echo "=== Summary ==="
printf '  %s passed, %s failed\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ]
