#!/usr/bin/env bash
# preflight.sh - SessionStart hook: CLI bootstrap preflight.
#
# Surfaces install/upgrade guidance once, early in the session, instead of at the
# plan or Stop boundary where it would add latency and noise. Read-only and
# advisory: it adds session context and nothing else. The --help capability
# probes live here only; the ExitPlanMode and Stop gates classify an old CLI
# from their own real plan-check/impl-check exit, so neither spawns actual a
# second time just to re-probe.
#
# Checks plan-check and impl-check independently (see AK-754): the two
# subcommands shipped in different CLI releases (plan-check at AK-672,
# impl-check later at AK-755), so a CLI can have one without the other.
#
# Silent unless this repository actually has committed rules, so installing the
# plugin is invisible in unrelated repositories. Registered for startup, resume,
# clear, compact, and fork so the reminder is restored after compaction.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

# Drain stdin before any early exit, so the caller never sees SIGPIPE.
cat >/dev/null

# A subprocess actual-cli spawned is not a session to brief (see
# inside_actual_subprocess).
if [ "${ACTUAL_PLAN_GATE:-on}" = "off" ] || inside_actual_subprocess; then
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

# Checked independently -- and in this order -- because plan-check is the
# older subcommand: a CLI missing it entirely is more out of date than one
# that merely predates impl-check, so its guidance takes priority when both
# are missing.
if ! have_plan_check; then
  emit_sessionstart_context "$(upgrade_message)"
  exit 0
fi

if ! have_impl_check; then
  emit_sessionstart_context "$(impl_upgrade_message)"
  exit 0
fi

emit_sessionstart_context "Actual plan- and implementation-stage governance is active: ${count} rule file(s) in ${dir} will be checked against your implementation plan when you exit plan mode, and against your accumulated diff at the end of each turn. Set ACTUAL_PLAN_GATE=off to disable."
