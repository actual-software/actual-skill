#!/usr/bin/env bash
# preflight.sh - SessionStart hook: CLI bootstrap preflight.
#
# Surfaces install/upgrade guidance once, early in the session, instead of at the
# plan or Stop boundary where it would add latency and noise. Read-only and
# advisory: it adds session context and nothing else, and never installs or
# upgrades anything itself. The ExitPlanMode and Stop gates classify an old CLI
# from their own real plan-check/impl-check exit, so neither spawns actual a
# second time just to re-probe.
#
# Two checks, scoped differently. The install offer appears only in a repository
# with committed rules, so the plugin stays invisible to someone who never
# installed the CLI. The version check runs wherever the hook runs: one
# `actual --version` compared with MIN_CLI_VERSION (lib/bootstrap.sh), which
# catches skew whether or not a release added a subcommand. Its offer
# interrupts the task only where rules are committed and the CLI is older than
# GATES_MIN_CLI_VERSION, where some check is not running in full.
#
# Registered for startup, resume, clear, compact, and fork so the reminder is
# restored after compaction.

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

if ! have_actual; then
  if [ "$count" -gt 0 ]; then
    emit_sessionstart_context "$(install_message)"
  fi
  exit 0
fi

# A version cli_version cannot read is not an old CLI, so it prompts nothing.
installed=$(cli_version)
offer=""
if [ -n "$installed" ] && version_older_than "$installed" "$MIN_CLI_VERSION"; then
  if [ "$count" -gt 0 ] && version_older_than "$installed" "$GATES_MIN_CLI_VERSION"; then
    emit_sessionstart_context "$(min_version_interrupt "$installed")"
    exit 0
  fi
  offer=$(min_version_offer "$installed" "$count")
fi

if [ "$count" -eq 0 ]; then
  [ -n "$offer" ] && emit_sessionstart_context "$offer"
  exit 0
fi

# No sentence about rule briefing. One used to promise that rules are surfaced
# on a read, which a compaction makes untrue: brief memory and the mod's budget
# survive it, so every decision briefed before the compaction stays quiet
# afterwards while the model has lost the text. Say it again when
# `--claude-session-start` resets that memory.
msg="Actual plan- and implementation-stage governance is active: ${count} rule file(s) in ${dir} will be checked against your implementation plan when you exit plan mode, and against your accumulated diff at the end of each turn. Set ACTUAL_PLAN_GATE=off to disable."
if [ -n "$offer" ]; then
  msg="${msg}

${offer}"
fi
emit_sessionstart_context "$msg"
