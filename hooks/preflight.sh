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
# Silent unless this repository actually has committed rules, so installing the
# plugin is invisible in unrelated repositories: no output and no CLI call. With
# rules, the version check is one `actual --version` compared with
# MIN_CLI_VERSION (lib/bootstrap.sh), which catches skew whether or not a release
# added a subcommand, and each CLI call is bounded by CLI_CALL_TIMEOUT. Below
# GATES_MIN_CLI_VERSION some check is not running in full, so the upgrade offer
# interrupts the task when the session starts and comes back at a pause after
# that. A CLI whose `--version` fails runs no check at all, so it gets an
# interrupt of its own, offering a reinstall.
#
# Registered for startup, resume, clear, compact, and fork so the reminder is
# restored after compaction.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

# Read the envelope before any early exit, so the caller never sees SIGPIPE.
envelope=$(cat)

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

installed=$(cli_version)
if [ $? -eq 2 ]; then
  emit_sessionstart_context "$(reinstall_interrupt)"
  exit 0
fi

# A version cli_version cannot read is not an old CLI, so it prompts nothing.
offer=""
if [ -n "$installed" ] && version_older_than "$installed" "$MIN_CLI_VERSION"; then
  if version_older_than "$installed" "$GATES_MIN_CLI_VERSION"; then
    if is_session_startup "$envelope"; then
      emit_sessionstart_context "$(min_version_interrupt "$installed")"
    else
      emit_sessionstart_context "$(min_version_reminder "$installed")"
    fi
    exit 0
  fi
  offer=$(min_version_offer "$installed")
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
