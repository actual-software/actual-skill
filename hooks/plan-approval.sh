#!/usr/bin/env bash
# plan-approval.sh - PermissionRequest hook on ExitPlanMode: approves a plan for an
# unattended agent, and does nothing at all unless unattended mode is on
# (ACTUAL_UNATTENDED=on, or the plugin's `unattended` row under /plugin).
#
# Claude Code runs PermissionRequest hooks only when it is about to show a
# permission dialog, which for ExitPlanMode is the plan dialog. That comes after
# PreToolUse, so plan-gate.sh has already judged the plan: a conflicting plan was
# denied there and never reaches this hook. A plan the gate passed, or could not
# check (no rules, no CLI, a failed judge call), arrives here, and with the switch
# on it is approved instead of waiting on a keystroke nobody will press.
#
# Claude Code's hooks guide documents the answer ("Auto-approve specific
# permission prompts"): allow, with updatedInput set to the request's own
# tool_input. A bare allow is ignored for ExitPlanMode and the dialog shows anyway.
# On approval Claude Code leaves plan mode and restores the session's previous
# permission mode. Measured on Claude Code 2.1.287 and 2.1.322 in an interactive
# session launched with --dangerously-skip-permissions: the plan was approved with
# no dialog and the session went back to bypass mode.
#
# This hook stays silent, which leaves the dialog in place, whenever the switch is
# off, governance is off, the tool is not ExitPlanMode, or the request has no
# tool_input it can copy back.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

# 1. Drain stdin before any early exit, so the caller never sees SIGPIPE.
payload=$(cat)

# 2. Off unless asked for; ACTUAL_PLAN_GATE=off turns this hook off with the rest,
#    and actual-cli's own subprocesses never plan.
if ! unattended_on || [ "${ACTUAL_PLAN_GATE:-on}" = "off" ] || inside_actual_subprocess; then
  exit 0
fi

# 3. Answer only the plan dialog. The matcher in hooks.json already scopes this
#    hook to ExitPlanMode; an approval is a grant, so the envelope says so too.
tool=$(json_member_value "$payload" tool_name) || exit 0
[ "$tool" = '"ExitPlanMode"' ] || exit 0

# 4. Approve with the plan echoed back unchanged.
input=$(json_member_value "$payload" tool_input) || exit 0
[ "${input#\{}" != "$input" ] || exit 0
emit_plan_approval "$input"
exit 0
