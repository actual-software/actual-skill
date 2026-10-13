#!/usr/bin/env bash
# turn-start.sh - UserPromptSubmit hook: mark the commit each turn starts from.
#
# impl-gate.sh checks the turn's diff at Stop. Diffed against HEAD, work the
# agent committed during the turn, or committed and pushed, is already in
# HEAD by then, so the tree is clean and the check reports nothing to check.
# This hook runs as each turn starts and has the CLI record HEAD for the
# session (`actual impl-check --claude-hook --turn-start`), and the Stop check
# then diffs against the commit the turn started from instead.
#
# Silent on every path, because a UserPromptSubmit hook's stdout is added to
# the prompt. Nothing here can block the prompt either. A missing CLI, one
# too old for --turn-start, or any other failure only leaves the Stop check
# diffing against HEAD as it did before this hook existed, and impl-gate.sh
# already tells the user about a missing or outdated CLI.

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

# Resolve --rules-dir and the root exactly as impl-gate.sh does. The CLI keys
# the record on (session_id, rules dir), so the Stop check only finds it under
# the same directory.
dir=$(rules_dir)
repo_root=$(resolve_repo_root)
cd "$repo_root" 2>/dev/null || true

# printf is silenced too: a CLI that exits before reading the payload breaks the
# pipe, and bash reports the failed write on stderr when SIGPIPE is ignored.
printf '%s' "$payload" 2>/dev/null | actual impl-check --claude-hook --turn-start --rules-dir "$dir" >/dev/null 2>&1
exit 0
