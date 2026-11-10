# codex.sh - the Codex half of the hook harness. Sourced by run.sh after its own
# sections, so it shares run.sh's helpers (pass, fail, argv_after), its WORK
# directory, its repositories and its resolved fixtures.
#
# Every script runs here as hooks/codex-hooks.json runs it: ACTUAL_HOOK_HOST=codex,
# no CLAUDE_PROJECT_DIR, from the session's working directory. The envelopes are
# the ones Phase 0 captured from Codex CLI 0.167.0 (fixtures/codex-*.json); the
# briefing tests point their command at the fake CLI's governed directory.
#
# Codex parses hook output strictly: a key it does not know fails the hook run.
# So besides what each reply says, every test below pins its exact key set.

echo
echo "=== Codex ==="

# Run a hook the way Codex does. Extra arguments are env assignments.
run_codex() {
  local script="$1" payload="$2" workdir="$3"
  shift 3
  local status
  [ -n "${KEEP_CACHE:-}" ] || rm -rf "${WORK}/cache"
  ( cd "$workdir" || exit 1
    env -u ACTUAL_RULES_DIR -u ACTUAL_PLAN_GATE -u ACTUAL_CLI_SUBPROCESS -u ACTUAL_SKILL_MOD_SESSION \
        -u CLAUDE_PROJECT_DIR -u ACTUAL_RULES_BRIEF -u ACTUAL_RULES_BRIEF_MAX_SESSION_CHARS \
        PATH="${TESTS_DIR}/bin:${PATH}" \
        ACTUAL_HOOK_CACHE_DIR="${WORK}/cache" \
        ACTUAL_HOOK_HOST=codex \
        "$@" \
        bash "$script" < "$payload" > "${WORK}/out" 2> "${WORK}/err" )
  status=$?
  printf '%s' "$status"
}

# Same with no `actual` on PATH.
run_codex_no_cli() {
  local script="$1" payload="$2" workdir="$3"
  local status
  ( cd "$workdir" || exit 1
    env -u ACTUAL_RULES_DIR -u ACTUAL_PLAN_GATE -u ACTUAL_CLI_SUBPROCESS -u CLAUDE_PROJECT_DIR \
        PATH="${WORK}/empty-bin:/usr/bin:/bin" \
        ACTUAL_HOOK_HOST=codex \
        bash "$script" < "$payload" > "${WORK}/out" 2> "${WORK}/err" )
  status=$?
  printf '%s' "$status"
}

# The sorted top-level keys of the reply, comma-separated; "none" for empty
# stdout and "unparseable" for anything jq cannot read as one object.
out_keys() {
  [ -s "${WORK}/out" ] || { printf 'none'; return; }
  jq -rs 'if length == 1 and (.[0] | type) == "object" then .[0] | keys | join(",") else "unparseable" end' \
    < "${WORK}/out" 2>/dev/null || printf 'unparseable'
}

# The keys under hookSpecificOutput, for the replies that carry one.
hso_keys() {
  jq -r '.hookSpecificOutput | keys | join(",")' < "${WORK}/out" 2>/dev/null
}

CX_REPO="$REPO_WITH_RULES"
CX_CAPTURE="${WORK}/codex-capture"
CX_CALLS="${WORK}/codex-calls"
CX_START="${RESOLVED}/codex-sessionstart-startup.json"
CX_PROMPT="${RESOLVED}/codex-userpromptsubmit-turn.json"
CX_STOP="${RESOLVED}/codex-stop-default.json"
CX_STOP_PLAN="${RESOLVED}/codex-stop-plan.json"
PG="${HOOKS_DIR}/plan-gate.sh"
IG="${HOOKS_DIR}/impl-gate.sh"
PF="${HOOKS_DIR}/preflight.sh"
TS="${HOOKS_DIR}/turn-start.sh"
SS="${HOOKS_DIR}/session-summary.sh"

# Envelopes Phase 0 did not capture verbatim, derived from ones it did.
CX_READ="${WORK}/codex-read-governed.json"
jq '.tool_input.command = "cat src/persistence/user_store.ts"' \
  "${RESOLVED}/codex-posttooluse-bash-cat.json" > "$CX_READ"
CX_READ_UNGOV="${RESOLVED}/codex-posttooluse-bash-cat.json"
CX_PATCH="${WORK}/codex-patch-governed.json"
jq --arg root "$CX_REPO" '.tool_input.command |= sub("/src/app.ts"; "/src/persistence/user_store.ts")' \
  "${RESOLVED}/codex-pretooluse-apply-patch.json" > "$CX_PATCH"
for source in resume compact clear; do
  jq --arg s "$source" '.source = $s' "$CX_START" > "${WORK}/codex-sessionstart-${source}.json"
done

# --- hooks/codex-hooks.json ---

CODEX_HOOKS_FILE="${HOOKS_DIR}/codex-hooks.json"
cx_cmd() { jq -r "$1" "$CODEX_HOOKS_FILE" 2>/dev/null; }
prefix='ACTUAL_HOOK_HOST=codex "${PLUGIN_ROOT}"/hooks/'
expect_reg() {
  local label="$1" query="$2" script="$3" timeout="$4"
  if [ "$(cx_cmd "${query}.command")" = "${prefix}${script}" ] \
     && [ "$(cx_cmd "${query}.timeout")" = "$timeout" ]; then
    pass "codex-hooks.json registers ${label} -> ${script} (${timeout}s)"
  else
    fail "codex-hooks.json ${label} registration wrong" "$(cx_cmd "${query}" | tr -d '\n')"
  fi
}
expect_reg "SessionStart" '.hooks.SessionStart[0].hooks[0]' preflight.sh 30
expect_reg "UserPromptSubmit" '.hooks.UserPromptSubmit[0].hooks[0]' turn-start.sh 10
expect_reg "PreToolUse:Edit|Write" '.hooks.PreToolUse[] | select(.matcher=="Edit|Write") | .hooks[0]' rules-brief.sh 3
expect_reg "PostToolUse:Bash" '.hooks.PostToolUse[] | select(.matcher=="Bash") | .hooks[0]' rules-brief.sh 3
expect_reg "Stop[0]" '.hooks.Stop[0].hooks[0]' plan-gate.sh 180
expect_reg "Stop[1]" '.hooks.Stop[0].hooks[1]' impl-gate.sh 180
expect_reg "Stop[2]" '.hooks.Stop[0].hooks[2]' session-summary.sh 5

if [ "$(cx_cmd '.hooks.SessionStart[0].matcher')" = "startup|resume|clear|compact|fork" ]; then
  pass "codex-hooks.json SessionStart covers every source, as hooks.json does"
else
  fail "codex-hooks.json SessionStart matcher wrong" "$(cx_cmd '.hooks.SessionStart[0].matcher')"
fi

# Every command: the host marker, PLUGIN_ROOT, an executable script that exists,
# and no handler key beyond the four Codex accepts.
bad=""
while IFS= read -r cmd; do
  script=${cmd#"$prefix"}
  [ "$script" != "$cmd" ] && [ -x "${HOOKS_DIR}/${script}" ] || bad="${bad} ${cmd}"
done < <(cx_cmd '.hooks[][].hooks[].command')
extra=$(cx_cmd '[.hooks[][].hooks[] | keys[] | select(. != "type" and . != "command" and . != "timeout" and . != "statusMessage")] | unique | join(",")')
groups=$(cx_cmd '[.hooks[][] | keys[] | select(. != "matcher" and . != "hooks")] | unique | join(",")')
events=$(cx_cmd '.hooks | keys | join(",")')
if [ -z "$bad" ] && [ -z "$extra" ] && [ -z "$groups" ] \
   && [ "$events" = "PostToolUse,PreToolUse,SessionStart,Stop,UserPromptSubmit" ]; then
  pass "every Codex command runs an executable hook script with ACTUAL_HOOK_HOST=codex, in Codex's shape"
else
  fail "codex-hooks.json has a bad command, key or event" "bad=${bad} extra=${extra} groups=${groups} events=${events}"
fi

# Shared scripts ship to both hosts, so both manifests carry one version.
CLAUDE_VERSION=$(jq -r '.version' "${HOOKS_DIR}/../.claude-plugin/plugin.json")
CODEX_VERSION=$(jq -r '.version' "${HOOKS_DIR}/../.codex-plugin/plugin.json")
if [ -n "$CLAUDE_VERSION" ] && [ "$CLAUDE_VERSION" = "$CODEX_VERSION" ]; then
  pass "the Claude Code and Codex manifests carry the same version ($CLAUDE_VERSION)"
else
  fail "the two manifests' versions differ" "claude=$CLAUDE_VERSION codex=$CODEX_VERSION"
fi

# --- Text written for Claude Code, rewritten for Codex ---

phrasing_out=$(
  ACTUAL_HOOK_HOST=codex PATH="${TESTS_DIR}/bin:${PATH}" ACTUAL_HOOK_CACHE_DIR="${WORK}/cache" bash -c '
    . "$1"
    for m in install_message upgrade_message reinstall_interrupt adr_v2_upgrade_message \
             "min_version_interrupt 0.6.0" "min_version_reminder 0.6.0" "min_version_offer 0.7.5" \
             "codex_min_version_interrupt 0.12.0" "codex_min_version_reminder 0.12.0"; do
      emit_sessionstart_context "$($m)"
    done' _ "${HOOKS_DIR}/lib/bootstrap.sh")
lines=$(printf '%s\n' "$phrasing_out" | grep -c '^{"hookSpecificOutput"')
if [ "$lines" = 9 ] && ! printf '%s' "$phrasing_out" | grep -qE 'AskUserQuestion|interactive question tool|Bash tool'; then
  pass "under Codex no offer names AskUserQuestion, a question tool or the Bash tool"
else
  fail "a Codex offer names a Claude Code tool" "$(printf '%s' "$phrasing_out" | grep -oE '.{40}(AskUserQuestion|question tool|Bash tool).{20}' | head -3)"
fi
if printf '%s' "$phrasing_out" | grep -q 'end your\\nturn on that question' \
   && printf '%s' "$phrasing_out" | grep -q 'asking the user in your\\nreply.'; then
  pass "under Codex the offers ask in the reply and end the turn on the question"
else
  fail "the Codex offers lost their ask-and-wait wording" ""
fi
claude_out=$(PATH="${TESTS_DIR}/bin:${PATH}" bash -c '. "$1"; emit_sessionstart_context "$(install_message)"' _ "${HOOKS_DIR}/lib/bootstrap.sh")
if printf '%s' "$claude_out" | grep -q 'AskUserQuestion' && printf '%s' "$claude_out" | grep -q 'with the Bash tool'; then
  pass "under Claude Code the offers keep their wording"
else
  fail "the Claude Code offer changed" "$claude_out"
fi

# --- preflight.sh ---

rm -f "${CX_CAPTURE}"*
st=$(run_codex "$PF" "$CX_START" "$CX_REPO" ACTUAL_TEST_CAPTURE="$CX_CAPTURE")
ctx=$(jq -r '.hookSpecificOutput.additionalContext // ""' < "${WORK}/out" 2>/dev/null)
if [ "$st" = 0 ] && [ "$(out_keys)" = hookSpecificOutput ] && [ "$(hso_keys)" = "additionalContext,hookEventName" ] \
   && [[ $ctx == *"governance is active"* ]] && [[ $ctx == *"Plan-mode turn"* ]] && [[ $ctx != *"exit plan mode"* ]]; then
  pass "Codex SessionStart: governance is active, described for Codex's Plan mode, in Codex's shape"
else
  fail "Codex SessionStart context wrong" "st=$st keys=$(out_keys) ctx=$ctx"
fi

for source in compact clear; do
  rm -f "${CX_CAPTURE}"*
  run_codex "$PF" "${WORK}/codex-sessionstart-${source}.json" "$CX_REPO" ACTUAL_TEST_CAPTURE="$CX_CAPTURE" >/dev/null
  if [ -f "${CX_CAPTURE}.session-start.argv" ] \
     && [ "$(argv_after --rules-dir "${CX_CAPTURE}.session-start.argv")" = "${CX_REPO}/.actual/rules" ] \
     && [ "$(argv_after --repo "${CX_CAPTURE}.session-start.argv")" = "$CX_REPO" ] \
     && grep -q "\"source\": \"${source}\"" "${CX_CAPTURE}.session-start"; then
    pass "Codex SessionStart ${source}: resets brief memory with the envelope and --rules-dir"
  else
    fail "Codex SessionStart ${source}: --codex-session-start not called right" "$(cat "${CX_CAPTURE}.session-start.argv" 2>/dev/null)"
  fi
done

rm -f "${CX_CAPTURE}"*
run_hook "$PF" "${RESOLVED}/sessionstart-startup.json" "$CX_REPO" ACTUAL_TEST_CAPTURE="$CX_CAPTURE" >/dev/null
if [ ! -f "${CX_CAPTURE}.session-start.argv" ] && ! grep -q 'Plan-mode turn' "${WORK}/out"; then
  pass "Claude Code SessionStart is unchanged: no session-start call, the ExitPlanMode wording"
else
  fail "Claude Code SessionStart picked up Codex behaviour" "$(cat "${WORK}/out")"
fi

st=$(run_codex_no_cli "$PF" "$CX_START" "$CX_REPO")
ctx=$(jq -r '.hookSpecificOutput.additionalContext // ""' < "${WORK}/out" 2>/dev/null)
if [ "$st" = 0 ] && [[ $ctx == *"is not on PATH"* ]] && [[ $ctx == *"npm install -g @actualai/actual"* ]] \
   && [[ $ctx != *AskUserQuestion* ]] && [[ $ctx != *"Bash tool"* ]]; then
  pass "Codex SessionStart without a CLI: the install offer, in Codex's words"
else
  fail "Codex install offer wrong" "st=$st ctx=$ctx"
fi

rm -f "$CX_CALLS"
st=$(run_codex "$PF" "$CX_START" "$CX_REPO" ACTUAL_TEST_MODE=no-codex-hook ACTUAL_TEST_VERSION=0.12.0 ACTUAL_TEST_CALLS="$CX_CALLS")
ctx=$(jq -r '.hookSpecificOutput.additionalContext // ""' < "${WORK}/out" 2>/dev/null)
if [ "$st" = 0 ] && [[ $ctx == *"(0.12.0) predates its Codex support"* ]] && [[ $ctx == *"0.13.0 or later"* ]] \
   && [[ $ctx == *"worth interrupting"* ]] && [[ $ctx != *"governance is active"* ]] \
   && ! grep -q -- '--codex-session-start' "$CX_CALLS"; then
  pass "Codex SessionStart, CLI without codex-hook, startup: the upgrade interrupt, nothing else called"
else
  fail "Codex old-CLI startup wrong" "st=$st ctx=$ctx calls=$(tr '\n' ';' < "$CX_CALLS")"
fi
st=$(run_codex "$PF" "${WORK}/codex-sessionstart-resume.json" "$CX_REPO" ACTUAL_TEST_MODE=no-codex-hook ACTUAL_TEST_VERSION=0.12.0)
ctx=$(jq -r '.hookSpecificOutput.additionalContext // ""' < "${WORK}/out" 2>/dev/null)
if [ "$st" = 0 ] && [[ $ctx == *"predates its Codex support"* ]] && [[ $ctx == *"natural pause"* ]] \
   && [[ $ctx == *"already declined"* ]]; then
  pass "Codex SessionStart, CLI without codex-hook, resume: the upgrade reminder"
else
  fail "Codex old-CLI resume wrong" "st=$st ctx=$ctx"
fi
# Every Claude Code minimum is below 0.13.0, so a Codex CLI that has the marker
# is never sent the Claude Code ladder, whatever its version reads.
st=$(run_codex "$PF" "$CX_START" "$CX_REPO" ACTUAL_TEST_VERSION=0.6.0)
ctx=$(jq -r '.hookSpecificOutput.additionalContext // ""' < "${WORK}/out" 2>/dev/null)
if [ "$st" = 0 ] && [[ $ctx == *"governance is active"* ]] && [[ $ctx != *"upgrade"* ]]; then
  pass "Codex SessionStart: a CLI with codex-hook skips the Claude Code version ladder"
else
  fail "Codex preflight applied the Claude Code ladder" "ctx=$ctx"
fi
st=$(run_codex "$PF" "$CX_START" "$CX_REPO" ACTUAL_TEST_MODE=cannot-run)
if [ "$st" = 0 ] && grep -q 'does not run' "${WORK}/out"; then
  pass "Codex SessionStart, CLI that cannot run: the reinstall offer"
else
  fail "Codex reinstall offer missing" "$(cat "${WORK}/out")"
fi

# A subproject Codex was started in: the session's cwd is the project signal,
# and a CLAUDE_PROJECT_DIR inherited from an enclosing Claude Code session is
# not.
MONO="${WORK}/codex-mono"
mkdir -p "${MONO}/packages/api/.actual/rules"
git -C "$MONO" init -q
cp "${REPO_WITH_RULES}/.actual/rules/"*.md "${MONO}/packages/api/.actual/rules/"
st=$(run_codex "$PF" "$CX_START" "${MONO}/packages/api" CLAUDE_PROJECT_DIR="$REPO_NO_RULES")
ctx=$(jq -r '.hookSpecificOutput.additionalContext // ""' < "${WORK}/out" 2>/dev/null)
if [ "$st" = 0 ] && [[ $ctx == *"${MONO}/packages/api/.actual/rules"* ]]; then
  pass "Codex root resolution: the session's cwd wins over the git toplevel and an inherited CLAUDE_PROJECT_DIR"
else
  fail "Codex root resolution wrong" "ctx=$ctx"
fi

# --- turn-start.sh ---

rm -f "${CX_CAPTURE}"*
st=$(run_codex "$TS" "$CX_PROMPT" "$CX_REPO" ACTUAL_TEST_CAPTURE="$CX_CAPTURE")
if [ "$st" = 0 ] && [ ! -s "${WORK}/out" ] && grep -qx -- '--codex-hook' "${CX_CAPTURE}.argv" \
   && ! grep -qx -- '--claude-hook' "${CX_CAPTURE}.argv" \
   && [ "$(argv_after --rules-dir "${CX_CAPTURE}.argv")" = "${CX_REPO}/.actual/rules" ] \
   && grep -q '"hook_event_name": "UserPromptSubmit"' "$CX_CAPTURE"; then
  pass "Codex UserPromptSubmit: the envelope goes to impl-check --codex-hook, silently"
else
  fail "Codex turn-start wrong" "st=$st out=$(cat "${WORK}/out") argv=$(tr '\n' ' ' < "${CX_CAPTURE}.argv" 2>/dev/null)"
fi
rm -f "$CX_CALLS"
st=$(run_codex "$TS" "$CX_PROMPT" "$CX_REPO" ACTUAL_TEST_MODE=no-codex-hook ACTUAL_TEST_CALLS="$CX_CALLS")
if [ "$st" = 0 ] && [ ! -s "${WORK}/out" ] && ! grep -qE '^impl-check (--codex|--claude)' "$CX_CALLS"; then
  pass "Codex UserPromptSubmit, CLI without codex-hook: nothing recorded, nothing said"
else
  fail "Codex turn-start ran on an old CLI" "calls=$(tr '\n' ';' < "$CX_CALLS")"
fi

# --- plan-gate.sh (Stop) ---

rm -f "${CX_CAPTURE}"*
st=$(run_codex "$PG" "$CX_STOP_PLAN" "$CX_REPO" ACTUAL_TEST_MODE=deny ACTUAL_TEST_CAPTURE="$CX_CAPTURE")
if [ "$st" = 0 ] && [ "$(out_keys)" = "decision,reason" ] && [ "$(stop_decision)" = block ] \
   && [[ $(jq -r .reason < "${WORK}/out") == "R-001 MUST:"* ]]; then
  pass "Codex plan gate: a conflicting plan gets exactly {decision: block, reason}"
else
  fail "Codex plan gate deny wrong" "st=$st keys=$(out_keys) out=$(cat "${WORK}/out")"
fi
if grep -qx -- '--codex-hook' "${CX_CAPTURE}.argv" && ! grep -qx -- '--claude-hook' "${CX_CAPTURE}.argv" \
   && [ "$(argv_after --rules-dir "${CX_CAPTURE}.argv")" = "${CX_REPO}/.actual/rules" ] \
   && grep -q '"turn_id"' "$CX_CAPTURE" && grep -q '"transcript_path"' "$CX_CAPTURE"; then
  pass "Codex plan gate: the Stop envelope goes to plan-check --codex-hook with --rules-dir"
else
  fail "Codex plan gate forwarding wrong" "$(tr '\n' ' ' < "${CX_CAPTURE}.argv" 2>/dev/null)"
fi

st=$(run_codex "$PG" "$CX_STOP" "$CX_REPO" ACTUAL_TEST_MODE=allow)
if [ "$st" = 0 ] && [ "$(out_keys)" = none ]; then
  pass "Codex plan gate: silence from the CLI (not a Plan-mode turn, or a conforming plan) stays silent"
else
  fail "Codex plan gate allow wrong" "$(cat "${WORK}/out")"
fi
st=$(run_codex "$PG" "$CX_STOP_PLAN" "$CX_REPO" ACTUAL_TEST_MODE=notice)
if [ "$st" = 0 ] && [ "$(out_keys)" = systemMessage ]; then
  pass "Codex plan gate: a notice is forwarded as a bare systemMessage"
else
  fail "Codex plan gate notice wrong" "keys=$(out_keys) out=$(cat "${WORK}/out")"
fi
for mode in codex-extra-key codex-claude-shape garbage emit-allow; do
  st=$(run_codex "$PG" "$CX_STOP_PLAN" "$CX_REPO" ACTUAL_TEST_MODE="$mode")
  if [ "$st" = 0 ] && [ "$(out_keys)" = none ]; then
    pass "Codex plan gate: a ${mode} reply is not forwarded"
  else
    fail "Codex plan gate forwarded a ${mode} reply" "$(cat "${WORK}/out")"
  fi
done
st=$(run_codex "$PG" "$CX_STOP_PLAN" "$CX_REPO" ACTUAL_TEST_MODE=codex-escaped)
if [ "$st" = 0 ] && [ "$(out_keys)" = systemMessage ] && grep -q 'could not safely interpret' "${WORK}/out"; then
  pass "Codex plan gate: an escaped reply is refused, and the user told"
else
  fail "Codex plan gate escaped reply wrong" "$(cat "${WORK}/out")"
fi
st=$(run_codex "$PG" "$CX_STOP_PLAN" "$CX_REPO" ACTUAL_TEST_MODE=codex-empty-reason)
if [ "$st" = 0 ] && [ "$(stop_decision)" = block ] && [ -n "$(jq -r .reason < "${WORK}/out")" ]; then
  pass "Codex plan gate: a block with an empty reason still blocks, with a fixed reason"
else
  fail "Codex plan gate empty reason wrong" "$(cat "${WORK}/out")"
fi
st=$(run_codex "$PG" "$CX_STOP_PLAN" "$CX_REPO" ACTUAL_TEST_MODE=deny-exit2)
if [ "$st" = 2 ] && grep -q 'R-001' "${WORK}/err" && [ ! -s "${WORK}/out" ]; then
  pass "Codex plan gate: the exit-2 fallback blocks with stderr as the reason"
else
  fail "Codex plan gate exit-2 wrong" "st=$st err=$(cat "${WORK}/err")"
fi
for mode in crash usage-error; do
  st=$(run_codex "$PG" "$CX_STOP_PLAN" "$CX_REPO" ACTUAL_TEST_MODE="$mode")
  if [ "$st" = 0 ] && [ "$(out_keys)" = systemMessage ] && grep -q 'did not run' "${WORK}/out"; then
    pass "Codex plan gate: ${mode} fails open with a notice"
  else
    fail "Codex plan gate ${mode} wrong" "st=$st out=$(cat "${WORK}/out")"
  fi
done
# impl-gate.sh runs on the same Stop and reports these, so the plan gate does not.
rm -f "$CX_CALLS"
st=$(run_codex "$PG" "$CX_STOP_PLAN" "$CX_REPO" ACTUAL_TEST_MODE=no-codex-hook ACTUAL_TEST_CALLS="$CX_CALLS")
st2=$(run_codex_no_cli "$PG" "$CX_STOP_PLAN" "$CX_REPO")
if [ "$st" = 0 ] && [ "$st2" = 0 ] && [ ! -s "${WORK}/out" ] && ! grep -q '^plan-check --codex' "$CX_CALLS"; then
  pass "Codex plan gate: silent on a missing or old CLI (impl-gate.sh says it once)"
else
  fail "Codex plan gate spoke for a missing or old CLI" "calls=$(tr '\n' ';' < "$CX_CALLS") out=$(cat "${WORK}/out")"
fi
st=$(run_codex "$PG" "$CX_STOP_PLAN" "$CX_REPO" ACTUAL_TEST_MODE=deny ACTUAL_PLAN_GATE=off)
st2=$(run_codex "$PG" "$CX_STOP_PLAN" "$REPO_NO_RULES" ACTUAL_TEST_MODE=deny)
if [ "$st" = 0 ] && [ "$st2" = 0 ] && [ ! -s "${WORK}/out" ]; then
  pass "Codex plan gate: ACTUAL_PLAN_GATE=off and a repo without rules are silent"
else
  fail "Codex plan gate ignored an off switch" "$(cat "${WORK}/out")"
fi

# --- impl-gate.sh (Stop) ---

rm -f "${CX_CAPTURE}"*
st=$(run_codex "$IG" "$CX_STOP" "$CX_REPO" ACTUAL_TEST_MODE=deny ACTUAL_TEST_CAPTURE="$CX_CAPTURE")
if [ "$st" = 0 ] && [ "$(out_keys)" = "decision,reason" ] && [ "$(stop_decision)" = block ] \
   && grep -qx -- '--codex-hook' "${CX_CAPTURE}.argv" && ! grep -qx -- '--claude-hook' "${CX_CAPTURE}.argv"; then
  pass "Codex impl gate: a conflicting diff gets exactly {decision: block, reason} via impl-check --codex-hook"
else
  fail "Codex impl gate deny wrong" "keys=$(out_keys) argv=$(tr '\n' ' ' < "${CX_CAPTURE}.argv" 2>/dev/null)"
fi
st=$(run_codex "$IG" "$CX_STOP" "$CX_REPO" ACTUAL_TEST_MODE=allow)
if [ "$st" = 0 ] && [ "$(out_keys)" = none ]; then
  pass "Codex impl gate: a conforming diff is silent"
else
  fail "Codex impl gate allow wrong" "$(cat "${WORK}/out")"
fi
for mode in codex-extra-key codex-claude-shape; do
  run_codex "$IG" "$CX_STOP" "$CX_REPO" ACTUAL_TEST_MODE="$mode" >/dev/null
  if [ "$(out_keys)" = none ]; then
    pass "Codex impl gate: a ${mode} reply is not forwarded"
  else
    fail "Codex impl gate forwarded a ${mode} reply" "$(cat "${WORK}/out")"
  fi
done
st=$(run_codex_no_cli "$IG" "$CX_STOP" "$CX_REPO")
if [ "$st" = 0 ] && [ "$(out_keys)" = systemMessage ] && grep -q 'not installed' "${WORK}/out"; then
  pass "Codex impl gate without a CLI: one systemMessage saying so"
else
  fail "Codex impl gate missing-CLI notice wrong" "$(cat "${WORK}/out")"
fi
rm -f "$CX_CALLS"
st=$(run_codex "$IG" "$CX_STOP" "$CX_REPO" ACTUAL_TEST_MODE=no-codex-hook ACTUAL_TEST_CALLS="$CX_CALLS")
if [ "$st" = 0 ] && [ "$(out_keys)" = systemMessage ] && grep -q 'predates its Codex support (needs 0.13.0+)' "${WORK}/out" \
   && ! grep -q '^impl-check --codex' "$CX_CALLS"; then
  pass "Codex impl gate, CLI without codex-hook: stands down with a one-line notice"
else
  fail "Codex impl gate old-CLI wrong" "out=$(cat "${WORK}/out") calls=$(tr '\n' ';' < "$CX_CALLS")"
fi
# The capability probe is cached: three Stops with a warm cache probe once.
rm -rf "${WORK}/cache"; rm -f "$CX_CALLS"
for i in 1 2 3; do
  KEEP_CACHE=1 run_codex "$IG" "$CX_STOP" "$CX_REPO" ACTUAL_TEST_CALLS="$CX_CALLS" >/dev/null
done
probes=$(grep -c '^plan-check --help' "$CX_CALLS")
if [ "$probes" = 1 ] && [ "$(cat "${WORK}/cache"/codex-hook-* 2>/dev/null)" = supported ]; then
  pass "Codex: the codex-hook probe runs once and its answer is cached"
else
  fail "Codex capability probe not cached" "probes=$probes cache=$(cat "${WORK}/cache"/codex-hook-* 2>/dev/null)"
fi
rm -rf "${WORK}/cache"

# --- rules-brief.sh ---

RB_ARGV="${CX_CAPTURE}.argv"
rm -f "${CX_CAPTURE}"*
st=$(run_codex "$RB" "$CX_READ" "$CX_REPO" ACTUAL_TEST_MODE=brief ACTUAL_TEST_CAPTURE="$CX_CAPTURE")
if [ "$st" = 0 ] && [ "$(out_keys)" = hookSpecificOutput ] && [ "$(hso_keys)" = "additionalContext,hookEventName" ] \
   && [ "$(jq -r .hookSpecificOutput.hookEventName < "${WORK}/out")" = PostToolUse ] \
   && grep -q 'R-001' "${WORK}/out"; then
  pass "Codex PostToolUse:Bash read of a governed file: one PostToolUse brief, in Codex's shape"
else
  fail "Codex shell-read brief wrong" "st=$st out=$(cat "${WORK}/out")"
fi
if grep -qx -- '--codex-hook' "$RB_ARGV" && ! grep -qx -- '--claude-hook' "$RB_ARGV" \
   && [ "$(argv_after --max-session-chars "$RB_ARGV")" = 48000 ] \
   && [ "$(argv_after --repo "$RB_ARGV")" = "$CX_REPO" ] \
   && [ "$(argv_after --rules-dir "$RB_ARGV")" = "${CX_REPO}/.actual/rules" ] \
   && ! grep -qxE -- '--limit|--rules-per-decision|--max-chars|--min-score' "$RB_ARGV"; then
  pass "Codex brief: --codex-hook, the 48000-character session cap, --repo and --rules-dir; no unset tuning flags"
else
  fail "Codex brief flags wrong" "$(tr '\n' ' ' < "$RB_ARGV")"
fi

rm -f "${CX_CAPTURE}"*
run_codex "$RB" "$CX_READ" "$CX_REPO" ACTUAL_TEST_MODE=brief ACTUAL_TEST_CAPTURE="$CX_CAPTURE" \
  ACTUAL_RULES_BRIEF_MAX_SESSION_CHARS=0 ACTUAL_RULES_BRIEF_LIMIT=3 ACTUAL_RULES_BRIEF_RULES_PER_DECISION=5 \
  ACTUAL_RULES_BRIEF_MAX_CHARS=2000 ACTUAL_RULES_BRIEF_MIN_SCORE=-0.5 >/dev/null
if [ "$(argv_after --max-session-chars "$RB_ARGV")" = 0 ] && [ "$(argv_after --limit "$RB_ARGV")" = 3 ] \
   && [ "$(argv_after --rules-per-decision "$RB_ARGV")" = 5 ] && [ "$(argv_after --max-chars "$RB_ARGV")" = 2000 ] \
   && [ "$(argv_after --min-score "$RB_ARGV")" = -0.5 ]; then
  pass "Codex brief: the ACTUAL_RULES_BRIEF_* settings become flags"
else
  fail "Codex brief settings not forwarded" "$(tr '\n' ' ' < "$RB_ARGV")"
fi
rm -f "${CX_CAPTURE}"*
run_codex "$RB" "$CX_READ" "$CX_REPO" ACTUAL_TEST_MODE=brief ACTUAL_TEST_CAPTURE="$CX_CAPTURE" \
  ACTUAL_RULES_BRIEF_MAX_SESSION_CHARS=lots ACTUAL_RULES_BRIEF_LIMIT=-1 ACTUAL_RULES_BRIEF_MIN_SCORE='1;x' >/dev/null
if [ "$(argv_after --max-session-chars "$RB_ARGV")" = 48000 ] && ! grep -qxE -- '--limit|--min-score' "$RB_ARGV" \
   && [ -s "${WORK}/out" ]; then
  pass "Codex brief: a setting that is not a number is dropped, so the brief still arrives"
else
  fail "Codex brief passed a malformed setting" "$(tr '\n' ' ' < "$RB_ARGV")"
fi

st=$(run_codex "$RB" "$CX_PATCH" "$CX_REPO" ACTUAL_TEST_MODE=brief)
if [ "$st" = 0 ] && [ "$(jq -r .hookSpecificOutput.hookEventName < "${WORK}/out" 2>/dev/null)" = PreToolUse ] \
   && [ "$(hso_keys)" = "additionalContext,hookEventName" ]; then
  pass "Codex PreToolUse:apply_patch of a governed file: a PreToolUse brief"
else
  fail "Codex patch brief wrong" "$(cat "${WORK}/out")"
fi
st=$(run_codex "$RB" "$CX_READ_UNGOV" "$CX_REPO" ACTUAL_TEST_MODE=brief)
if [ "$st" = 0 ] && [ ! -s "${WORK}/out" ]; then
  pass "Codex shell read of an ungoverned file is silent"
else
  fail "Codex ungoverned read produced output" "$(cat "${WORK}/out")"
fi
# The mod's stand-down signal belongs to Claude Code: inherited into Codex it
# must not silence the brief.
sid=$(jq -r .session_id < "$CX_PATCH")
run_codex "$RB" "$CX_PATCH" "$CX_REPO" ACTUAL_TEST_MODE=brief ACTUAL_SKILL_MOD_SESSION="$sid" >/dev/null
if [ -s "${WORK}/out" ]; then
  pass "Codex brief ignores an inherited ACTUAL_SKILL_MOD_SESSION"
else
  fail "Codex brief stood down for a mod that is not there" ""
fi
for mode in brief-permission brief-trailing-field brief-escaped; do
  run_codex "$RB" "$CX_READ" "$CX_REPO" ACTUAL_TEST_MODE="$mode" >/dev/null
  if [ ! -s "${WORK}/out" ]; then
    pass "Codex brief: a ${mode} reply is dropped"
  else
    fail "Codex brief forwarded ${mode}" "$(cat "${WORK}/out")"
  fi
done
rm -f "$CX_CALLS"
run_codex "$RB" "$CX_READ" "$CX_REPO" ACTUAL_TEST_MODE=brief ACTUAL_TEST_CODEX=old ACTUAL_TEST_CALLS="$CX_CALLS" >/dev/null
if [ ! -s "${WORK}/out" ] && ! grep -q '^rules brief --codex-hook' "$CX_CALLS"; then
  pass "Codex brief, CLI without codex-hook: no brief call, silent"
else
  fail "Codex brief called an old CLI" "calls=$(tr '\n' ';' < "$CX_CALLS")"
fi
run_codex "$RB" "$CX_READ" "$CX_REPO" ACTUAL_TEST_MODE=brief ACTUAL_RULES_BRIEF=off >/dev/null
if [ ! -s "${WORK}/out" ]; then
  pass "Codex brief honours ACTUAL_RULES_BRIEF=off"
else
  fail "Codex brief ignored ACTUAL_RULES_BRIEF=off" ""
fi

# --- session-summary.sh (Stop) ---

rm -f "${CX_CAPTURE}"*
st=$(run_codex "$SS" "$CX_STOP" "$CX_REPO" ACTUAL_TEST_CAPTURE="$CX_CAPTURE")
if [ "$st" = 0 ] && [ "$(out_keys)" = systemMessage ] \
   && [ "$(jq -r .systemMessage < "${WORK}/out")" = "Actual AI: 1 of 1 ADRs added to context" ] \
   && grep -qx -- '--codex-hook' "${CX_CAPTURE}.summary.argv" \
   && [ "$(argv_after --rules-dir "${CX_CAPTURE}.summary.argv")" = "${CX_REPO}/.actual/rules" ] \
   && [ "$(argv_after --repo "${CX_CAPTURE}.summary.argv")" = "$CX_REPO" ]; then
  pass "Codex session summary: the line as a bare systemMessage, from session summary --codex-hook"
else
  fail "Codex session summary wrong" "st=$st out=$(cat "${WORK}/out") argv=$(tr '\n' ' ' < "${CX_CAPTURE}.summary.argv" 2>/dev/null)"
fi
for summary in none extra plain crash; do
  st=$(run_codex "$SS" "$CX_STOP" "$CX_REPO" ACTUAL_TEST_SUMMARY="$summary")
  if [ "$st" = 0 ] && [ ! -s "${WORK}/out" ]; then
    pass "Codex session summary: a ${summary} reply is silent"
  else
    fail "Codex session summary forwarded a ${summary} reply" "st=$st out=$(cat "${WORK}/out")"
  fi
done
rm -f "$CX_CALLS"
run_hook "$SS" "${RESOLVED}/stop-turn.json" "$CX_REPO" ACTUAL_TEST_CALLS="$CX_CALLS" >/dev/null
if [ ! -s "${WORK}/out" ] && [ ! -s "$CX_CALLS" ]; then
  pass "session-summary.sh does nothing under Claude Code, where the mod draws the line"
else
  fail "session-summary.sh ran under Claude Code" "calls=$(cat "$CX_CALLS" 2>/dev/null)"
fi
for off in ACTUAL_RULES_BRIEF=off ACTUAL_PLAN_GATE=off ACTUAL_CLI_SUBPROCESS=1 ACTUAL_TEST_CODEX=old; do
  run_codex "$SS" "$CX_STOP" "$CX_REPO" "$off" >/dev/null
  if [ ! -s "${WORK}/out" ]; then
    pass "Codex session summary is silent with ${off}"
  else
    fail "Codex session summary ignored ${off}" "$(cat "${WORK}/out")"
  fi
done
run_codex_no_cli "$SS" "$CX_STOP" "$CX_REPO" >/dev/null
st2=$(run_codex "$SS" "$CX_STOP" "$REPO_NO_RULES")
if [ ! -s "${WORK}/out" ] && [ "$st2" = 0 ]; then
  pass "Codex session summary is silent without a CLI or without rules"
else
  fail "Codex session summary spoke without a CLI or rules" "$(cat "${WORK}/out")"
fi

# Every subprocess guard holds under Codex too: a codex-cli judge runs with
# ACTUAL_CLI_SUBPROCESS=1, and nothing may run inside it.
quiet=1
for pair in "$PF:$CX_START" "$TS:$CX_PROMPT" "$PG:$CX_STOP_PLAN" "$IG:$CX_STOP" "$RB:$CX_READ"; do
  run_codex "${pair%%:*}" "${pair#*:}" "$CX_REPO" ACTUAL_TEST_MODE=deny ACTUAL_CLI_SUBPROCESS=1 >/dev/null
  [ -s "${WORK}/out" ] && quiet=0
done
if [ "$quiet" = 1 ]; then
  pass "every Codex hook is silent inside an actual-cli subprocess"
else
  fail "a Codex hook ran inside an actual-cli subprocess" ""
fi
