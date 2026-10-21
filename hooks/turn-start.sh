#!/usr/bin/env bash
# turn-start.sh - UserPromptSubmit hook: mark the commit each turn starts from.
#
# impl-gate.sh checks the turn's diff at Stop. Diffed against HEAD, work the
# agent committed during the turn, or committed and pushed, is already in
# HEAD by then, so the tree is clean and the check reports nothing to check.
# This hook runs as each turn starts and hands the UserPromptSubmit envelope to
# `actual impl-check --claude-hook`. The CLI dispatches on the envelope's
# hook_event_name: on UserPromptSubmit it records HEAD for the session and
# prints nothing, and the Stop check then diffs against the commit the turn
# started from instead.
#
# Silent on every path, because a UserPromptSubmit hook's stdout is added to
# the prompt, so the CLI's output is discarded. Nothing here can block the
# prompt either. A missing CLI or any other failure only leaves the Stop check
# diffing against HEAD as it did before this hook existed, and impl-gate.sh
# already tells the user about a missing or outdated CLI.
#
# A CLI without the UserPromptSubmit dispatch (anything before 0.7.0) treats
# this call as a full impl-check on every prompt: model calls, a delayed
# prompt, and denials nobody sees that spend the Stop check's per-rule budget.
# So the hook probes for the dispatch first (have_turn_start) and does nothing
# without it.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

# Drain stdin before any early exit, so the caller never sees SIGPIPE.
payload=$(cat)

# The same switches as the gates: off for all hooks, and never inside one of
# actual-cli's own subprocesses.
if [ "${ACTUAL_PLAN_GATE:-on}" = "off" ] || inside_actual_subprocess; then
  exit 0
fi

if ! rules_present || ! have_actual; then
  exit 0
fi

# ADR header v2 rule files this CLI cannot read: impl-gate.sh stands down, so
# there is no turn to mark.
if adr_v2_unsupported "$(rules_dir)"; then
  exit 0
fi

# The ACTUAL_TURN_START_LOG trace described below records this skip too.
if ! have_turn_start; then
  if [ -n "${ACTUAL_TURN_START_LOG:-}" ]; then
    printf 'turn-start: skipped, actual impl-check --help does not name UserPromptSubmit\n' \
      2>/dev/null >>"$ACTUAL_TURN_START_LOG"
  fi
  exit 0
fi

# Resolve --rules-dir and the root exactly as impl-gate.sh does. The CLI keys
# the record on (session_id, rules dir), so the Stop check only finds it under
# the same directory.
dir=$(rules_dir)
repo_root=$(resolve_repo_root)
cd "$repo_root" 2>/dev/null || true

# printf is silenced too: a CLI that exits before reading the payload breaks the
# pipe, and bash reports the failed write on stderr when SIGPIPE is ignored.
#
# ACTUAL_TURN_START_LOG=<file> opts in to a trace: the CLI's output and exit
# status are appended to that file, so a record that never gets written can be
# diagnosed. Nothing reaches stdout or stderr either way.
if [ -n "${ACTUAL_TURN_START_LOG:-}" ]; then
  {
    printf '%s' "$payload" 2>/dev/null | actual impl-check --claude-hook --rules-dir "$dir" 2>&1
    printf 'turn-start: exit=%s rules-dir=%s\n' "${PIPESTATUS[1]}" "$dir"
  } 2>/dev/null >>"$ACTUAL_TURN_START_LOG"
else
  printf '%s' "$payload" 2>/dev/null | actual impl-check --claude-hook --rules-dir "$dir" >/dev/null 2>&1
fi
exit 0
