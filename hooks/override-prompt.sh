#!/usr/bin/env bash
# override-prompt.sh - UserPromptSubmit hook: let the user override a denied
# rule from inside the session by typing `/override <rule-id|all> [reason]`.
#
# The plan and implementation gates deny a rule until a human clears it. That
# used to mean leaving the session for a terminal, because the agent has a shell
# and must never be able to clear its own denial. A UserPromptSubmit event is the
# one input the agent cannot produce: it carries the text the user typed. So
# this hook hands that envelope to `actual check-override --claude-hook`, which
# records the override only for a UserPromptSubmit envelope whose prompt is an
# /override command, and ignores everything else. The CLI's stdout (an
# additionalContext line telling the agent the rule was overridden, or why
# nothing was) is forwarded as this hook's output; a UserPromptSubmit hook's
# stdout is added to the prompt.
#
# Nothing here can block the prompt. Any other prompt, a missing or older CLI, or
# any failure exits 0 silently (an older CLI with a /override prompt gets a
# context line pointing at the terminal command instead).

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

# Drain stdin before any early exit, so the caller never sees SIGPIPE.
payload=$(cat)

# Cheap pre-filter: nearly every prompt is not an override, and the CLI does the
# strict parsing. The literal must appear for the CLI to be worth spawning.
case "$payload" in
  *override*) ;;
  *) exit 0 ;;
esac

if [ "${ACTUAL_PLAN_GATE:-on}" = "off" ] || inside_actual_subprocess; then
  exit 0
fi

dir=$(rules_dir)
if ! rules_present "$dir" || ! have_actual; then
  exit 0
fi

repo_root=$(resolve_repo_root)
cd "$repo_root" 2>/dev/null || true

# Without --claude-hook support the CLI would reject the flag. Say so only when
# the prompt really is an /override command, so ordinary prompts that mention the
# word stay silent.
if ! have_override_hook; then
  if printf '%s' "$payload" | grep -Eq '"prompt"[[:space:]]*:[[:space:]]*"[[:space:]]*/([A-Za-z0-9_-]+:)?override([[:space:]\\"]|$)'; then
    printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"%s"}}\n' \
      "$(json_escape "The user typed /override, but the installed actual CLI is too old to record it from the session. Nothing was overridden. Tell them to update the CLI, or to run 'actual check-override' from an ordinary terminal (see 'actual check-override --help'). Do not run it yourself.")"
  fi
  exit 0
fi

printf '%s' "$payload" 2>/dev/null | actual check-override --claude-hook --rules-dir "$dir" 2>/dev/null
exit 0
