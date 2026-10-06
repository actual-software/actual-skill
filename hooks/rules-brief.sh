#!/usr/bin/env bash
# rules-brief.sh - PostToolUse hook on Read: brief the agent on the rules that
# govern the file it just read.
#
# Claude Code requires a Read before an Edit or an overwrite, and PostToolUse
# context lands before the model's next step, so this is the delivery point that
# reaches the agent ahead of its first edit (PreToolUse Edit|Write context only
# arrives with the tool result, after the edit ran). Observed on Claude Code
# 2.1.231; the model applied the context in every test run.
#
# This wrapper does only cheap shell checks and then hands the raw hook envelope
# to `actual rules brief --claude-hook`, which resolves the file, ranks the
# governing decisions, and keeps what it has already briefed this session. It
# never parses JSON (see hooks/lib/bootstrap.sh for why).
#
# Advisory by construction, and silent by default: no committed rules, no CLI, an
# old CLI (preflight already prompts once per session), an ungoverned file, a
# crash -- all exit 0 with no output. The only thing ever forwarded is a
# hookSpecificOutput.additionalContext reply for PostToolUse; any other shape,
# above all one carrying a permissionDecision, is dropped.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

# Drain stdin before any early exit, so the caller never sees SIGPIPE.
payload=$(cat)

if [ "${ACTUAL_PLAN_GATE:-on}" = "off" ]; then
  exit 0
fi

if ! rules_present || ! have_actual; then
  exit 0
fi

stderr_file=$(mktemp "${TMPDIR:-/tmp}/actual-rules-brief.XXXXXX") || exit 0
trap 'rm -f "$stderr_file"' EXIT

# Resolve the rules directory BEFORE the cd (see plan-gate.sh).
dir=$(rules_dir)
repo_root=$(resolve_repo_root)
cd "$repo_root" 2>/dev/null || true

reply=$(printf '%s' "$payload" | actual rules brief --claude-hook --rules-dir "$dir" 2>"$stderr_file")
status=$?

# Any failure -- including an old CLI's unknown subcommand -- is silence.
[ "$status" -eq 0 ] || exit 0

trimmed=${reply#"${reply%%[![:space:]]*}"}
trimmed=${trimmed%"${trimmed##*[![:space:]]}"}

# Forward only the one allowlisted shape: a compact object whose sole content is
# PostToolUse additionalContext. Matching the exact opening and closing bytes
# (rather than blocklisting fields) keeps every unrecognized shape -- an added
# decision, updatedInput, a permissionDecision, garbage -- on the silent side.
# The escape and duplicate-key guards are the same ones the gates use: they
# defend the literal-bytes match against \uXXXX spellings.
prefix='{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"'
if [ "${trimmed#"$prefix"}" != "$trimmed" ] \
   && [ "${trimmed%\"\}\}}" != "$trimmed" ] \
   && ! has_permission_decision "$trimmed" \
   && ! has_unicode_escape "$trimmed" \
   && ! has_duplicate_permission_decision "$trimmed"; then
  printf '%s\n' "$trimmed"
fi
exit 0
