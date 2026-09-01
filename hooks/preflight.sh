#!/usr/bin/env bash
# preflight.sh - SessionStart hook: CLI bootstrap preflight.
#
# Surfaces install/upgrade guidance once, early in the session, instead of at the
# plan boundary where it would add latency and noise. Read-only and advisory: it
# adds session context and nothing else. The --help capability probe lives here
# only; the ExitPlanMode gate classifies an old CLI from the real plan-check exit
# so it does not spawn actual twice.
#
# Silent unless this repository actually has committed rules, so installing the
# plugin is invisible in unrelated repositories.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

# Drain stdin before any early exit, so the caller never sees SIGPIPE.
cat >/dev/null

if [ "${ACTUAL_PLAN_GATE:-on}" = "off" ]; then
  exit 0
fi

dir=$(rules_dir)
count=$(rules_count "$dir")

if [ "$count" -eq 0 ]; then
  exit 0
fi

if ! have_actual; then
  emit_sessionstart_context "$(install_message)"
  exit 0
fi

if ! have_plan_check; then
  emit_sessionstart_context "$(upgrade_message)"
  exit 0
fi

emit_sessionstart_context "Actual plan-stage governance is active: ${count} rule file(s) in ${dir} will be checked against your implementation plan when you exit plan mode. Set ACTUAL_PLAN_GATE=off to disable."
