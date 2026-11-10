#!/usr/bin/env bash
# session-summary.sh - Codex Stop hook: the session-summary line.
#
# Claude Code shows "Actual AI: 2 of 3 ADRs added to context ..." in a band
# above the prompt, which the mod (register.js) draws. Codex has no such band,
# so this shows the same line as a Stop hook's systemMessage: a line Codex shows
# the user at the end of the turn and never adds to the model's context. `actual
# session summary --codex-hook` prints it only when it changed since it was last
# shown, and records it as shown, so a turn that briefed nothing new says
# nothing.
#
# Registered in hooks/codex-hooks.json only. Under Claude Code the mod owns the
# line, so this exits at once there.
#
# Silent on every failure: no rules, no CLI, an old CLI, a crash, or any reply
# that is not exactly {"systemMessage":"..."}. A Stop hook's systemMessage
# cannot block or continue the turn, and this one must not be able to either,
# so nothing else is ever forwarded.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

# Drain stdin before any early exit, so the caller never sees SIGPIPE.
payload=$(cat)

# The line reports briefing, so briefing's own switch silences it as well as
# the master one.
if ! is_codex_host || [ "${ACTUAL_PLAN_GATE:-on}" = "off" ] \
   || [ "${ACTUAL_RULES_BRIEF:-on}" = "off" ] || inside_actual_subprocess; then
  exit 0
fi

repo_root=$(resolve_repo_root)
dir=$(rules_dir "$repo_root")
if ! rules_present "$dir" || ! have_actual; then
  exit 0
fi
if adr_v2_unsupported "$dir" || ! have_codex_hook; then
  exit 0
fi

cd "$repo_root" 2>/dev/null || true

# The line counts what `rules brief` recorded for this session under the same
# --rules-dir, so both name the directory the same way.
reply=$(printf '%s' "$payload" 2>/dev/null \
  | actual session summary --codex-hook --repo "$repo_root" --rules-dir "$dir" 2>/dev/null) || exit 0
forward_codex_reply "$reply" notice
exit 0
