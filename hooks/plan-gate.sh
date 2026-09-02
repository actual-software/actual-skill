#!/usr/bin/env bash
# plan-gate.sh - PreToolUse hook on ExitPlanMode: the plan/implementation boundary.
#
# Fires when the agent calls ExitPlanMode -- after the plan has been written, and
# before the user's plan-approval dialog. A denied plan therefore never reaches the
# human as an approvable artifact; the agent revises first. That ordering is observed
# behavior, not a documented contract: verified on Claude Code 2.1.231, where a hook
# deny logs "ExitPlanMode tool permission denied" and no approval dialog is shown.
#
# This wrapper does only cheap shell checks and then hands the raw hook envelope to
# `actual plan-check --claude-hook`, which resolves the plan text and returns the
# verdict. It never parses JSON (see hooks/lib/bootstrap.sh for why). Plan
# resolution lives in the CLI: prefer tool_input.plan / tool_input.planFilePath
# (current Claude Code injects both), then the transcript plan_mode attachment.
#
# Fail-open contract: every unexpected condition exits 0 and leaves the normal
# permission flow untouched. Only an explicit deny (JSON or exit 2) can block.
# A conforming plan must not emit permissionDecision:allow -- a gate does not grant
# approval on the user's behalf. Pass = empty stdout, or JSON with no decision.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

# 1. Drain stdin before any early exit, so the caller never sees SIGPIPE.
payload=$(cat)

# 2. Explicit opt-out.
if [ "${ACTUAL_PLAN_GATE:-on}" = "off" ]; then
  exit 0
fi

# 3. No committed rules means nothing to govern. Silent no-op -- no output at all --
#    so installing the plugin is invisible in unrelated repositories.
if ! rules_present; then
  exit 0
fi

# 4. Rules exist but the CLI is missing: say so, decide nothing.
if ! have_actual; then
  emit_pretooluse_notice "$(install_message)"
  exit 0
fi

# 5. Delegate. Do not probe `plan-check --help` here: SessionStart already did,
#    and a second spawn is a cold Node boot on the plan boundary. An old CLI's
#    unknown-subcommand exit 2 is classified below as upgrade + fail-open, not deny.
#    Pass --rules-dir so the CLI scores the same directory this hook just checked,
#    including ACTUAL_RULES_DIR. Resolve that directory BEFORE the cd: root
#    resolution reads cwd (see resolve_repo_root), so moving first would ask the
#    question from a different place than rules_present answered it.
stderr_file=$(mktemp "${TMPDIR:-/tmp}/actual-plan-gate.XXXXXX") || exit 0
trap 'rm -f "$stderr_file"' EXIT

dir=$(rules_dir)

# cd to the repo root for any other cwd-relative CLI discovery.
repo_root=$(resolve_repo_root)
cd "$repo_root" 2>/dev/null || true

verdict=$(printf '%s' "$payload" | actual plan-check --claude-hook --rules-dir "$dir" 2>"$stderr_file")
status=$?

case "$status" in
  0)
    # Forward a well-formed verdict, except permissionDecision:allow. That field
    # is never valid here: a conforming plan must leave the approval dialog intact.
    # The CLI contract is deny-or-silent; this guard is defense in depth.
    trimmed=${verdict#"${verdict%%[![:space:]]*}"}
    trimmed=${trimmed%"${trimmed##*[![:space:]]}"}
    if [ "${trimmed#\{}" != "$trimmed" ] && [ "${trimmed%\}}" != "$trimmed" ] \
       && ! is_allow_decision "$trimmed"; then
      printf '%s\n' "$verdict"
    fi
    exit 0
    ;;
  2)
    # Unknown subcommand: old CLI, fail open with upgrade guidance.
    # Any other exit 2 is the CLI's fallback block path.
    if is_unrecognized_plan_check "$stderr_file"; then
      emit_pretooluse_notice "$(upgrade_message)"
      exit 0
    fi
    cat "$stderr_file" >&2
    exit 2
    ;;
  *)
    # Crash, timeout, panic, anything unforeseen: never penalize the agent for it.
    emit_pretooluse_notice \
      "Actual plan governance did not run (actual plan-check exited ${status}); this plan was not checked against .actual/rules/."
    exit 0
    ;;
esac
