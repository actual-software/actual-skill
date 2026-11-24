#!/usr/bin/env bash
# gate-answer.sh - Codex PostToolUse hook on request_user_input: hand the
# user's answer to a gate's picker to the CLI.
#
# Codex has no mod to raise Claude Code's denial dialog. When a check blocks
# and the agent can show a picker (Plan mode, or Default mode with Codex's
# default_mode_request_user_input feature on), the gates pass --codex-picker
# and the CLI sends the agent back with the exact request_user_input call to
# make: "Revise ... (Recommended)" or "Override ...", and after Override a
# second picker asking why. This hook runs after each such call and pipes the
# envelope, which holds the questions asked and the user's answers, to
# `actual impl-check --codex-hook`. The CLI accepts only answers to question
# ids it issued (actual_choice_<nonce>, actual_reason_<nonce>), records an
# override with its reason code, and replies with the agent's next step as
# PostToolUse additionalContext, which this hook forwards
# (forward_codex_reply "post-context") and nothing else.
#
# Codex only, and silent on every failure: an unanswered picker is caught at
# the next Stop, which ends the turn with the text choices instead.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

# Drain stdin before any early exit, so the caller never sees SIGPIPE.
payload=$(cat)

is_codex_host || exit 0
if [ "${ACTUAL_PLAN_GATE:-on}" = "off" ] || inside_actual_subprocess; then
  exit 0
fi

# The CLI's ADR refresh runs first, on a tool call's time box, as in every Codex
# hook (lib/bootstrap.sh). Its news waits for the next prompt.
adr_refresh_first tool

# A picker the agent showed for some other reason is not ours, and costs no
# CLI spawn: only the gates' question ids are answered.
case "$payload" in
  *actual_choice_*|*actual_reason_*) ;;
  *) exit 0 ;;
esac

dir=$(rules_dir)
rules_present "$dir" && have_actual || exit 0
have_codex_hook || exit 0

repo_root=$(resolve_repo_root)
cd "$repo_root" 2>/dev/null || true

reply=$(printf '%s' "$payload" 2>/dev/null | actual impl-check --codex-hook --rules-dir "$dir" 2>/dev/null)
status=$?
[ "$status" -eq 0 ] && forward_codex_reply "$reply" "post-context"
exit 0
