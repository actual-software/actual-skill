#!/usr/bin/env bash
# impl-gate.sh - Stop hook: the implementation-stage governance checkpoint.
#
# Fires when Claude finishes responding to a turn -- unconditionally, every
# time, never gated on plan-gate.sh having run earlier in the same session.
# A turn that skipped plan mode entirely (no ExitPlanMode call at all) must
# still be governed; see AK-754. Hands the turn's accumulated `git diff HEAD`
# to `actual impl-check --claude-hook`, the implementation-stage counterpart
# of `plan-check` (see AK-755): the same committed `.actual/rules/` corpus,
# the same pipeline, and the same revision-loop session machinery (keyed on
# session_id, shared with plan-check sessions in the same repo) -- just a
# diff instead of plan text.
#
# Unlike plan-gate.sh's PreToolUse/ExitPlanMode contract, Stop's decision
# control is NOT hookSpecificOutput.permissionDecision. It is a top-level
# `decision`/`reason` pair -- `{"decision":"block","reason":"..."}` --
# verified against https://code.claude.com/docs/en/hooks (Stop decision
# control), not assumed from the PreToolUse precedent: the two hook events
# are not guaranteed to behave identically, and here they in fact don't.
# `actual impl-check --claude-hook` reuses plan-check's own JSON renderer,
# which always emits a PreToolUse-shaped hookSpecificOutput regardless of
# which Claude Code event is asking (see plan_check_hook::render_deny /
# render_notice in the actual-cli repo). Forwarded verbatim to Stop, that
# shape carries no `decision` field at all -- Claude Code would silently
# ignore it and let the turn end, exactly the failure this hook exists to
# prevent. So, unlike plan-gate.sh, this wrapper does not forward the CLI's
# JSON byte-for-byte: it classifies the verdict and re-renders it in Stop's
# own shape (see bootstrap.sh's render_stop_verdict). That classification is
# still pure byte-matching, never a JSON parse -- same reason plan-gate.sh
# gives.
#
# Fail-open contract, identical to plan-gate.sh: no committed rules -> silent
# no-op; no `actual` binary, or one too old for `impl-check` -> a notice,
# never a block; any unexpected condition -> let the turn end normally. Only
# an explicit deny from `impl-check` can force continuation.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

# 1. Drain stdin before any early exit, so the caller never sees SIGPIPE.
payload=$(cat)

# 2. Explicit opt-out, shared with plan-gate.sh -- one switch disables all
#    of this plugin's governance hooks.
if [ "${ACTUAL_PLAN_GATE:-on}" = "off" ]; then
  exit 0
fi

# 3. No committed rules means nothing to govern. Silent no-op -- no output at
#    all -- so installing the plugin is invisible in unrelated repositories.
#    Unconditional: this must fire and decide on its own regardless of
#    whether plan-gate.sh ran earlier in this session.
if ! rules_present; then
  exit 0
fi

# 4. Rules exist but the CLI is missing: say so, decide nothing. A Stop
#    hook's fail-open notice can only ever be user-facing (see
#    emit_stop_notice's comment): Stop has no channel that reaches Claude
#    without also forcing continuation, and a missing CLI must never force
#    continuation.
if ! have_actual; then
  emit_stop_notice "$(install_message)"
  exit 0
fi

# 5. Delegate. Resolve --rules-dir before the cd, same reasoning as
#    plan-gate.sh: resolve_repo_root and rules_dir both read cwd.
stderr_file=$(mktemp "${TMPDIR:-/tmp}/actual-impl-gate.XXXXXX") || exit 0
trap 'rm -f "$stderr_file"' EXIT

dir=$(rules_dir)

repo_root=$(resolve_repo_root)
cd "$repo_root" 2>/dev/null || true

verdict=$(printf '%s' "$payload" | actual impl-check --claude-hook --rules-dir "$dir" 2>"$stderr_file")
status=$?

case "$status" in
  0)
    render_stop_verdict "$verdict"
    exit 0
    ;;
  2)
    # Unknown subcommand: a CLI with plan-check but no impl-check yet
    # (pre-AK-755), fail open with upgrade guidance. Any other exit 2 is
    # impl-check's own fallback block path.
    if is_unrecognized_impl_check "$stderr_file"; then
      emit_stop_notice "$(impl_upgrade_message)"
      exit 0
    fi
    # A real deny via the exit-2 fallback: Stop's exit-2 contract is "blocks,
    # stderr is the reason Claude sees" -- identical to PreToolUse's -- so
    # this passes straight through with no reshaping needed, same as
    # plan-gate.sh's own exit-2 branch.
    cat "$stderr_file" >&2
    exit 2
    ;;
  *)
    # Crash, timeout, panic, anything unforeseen: never penalize the agent
    # for it, and never force continuation over it.
    emit_stop_notice \
      "Actual implementation governance did not run (actual impl-check exited ${status}); this turn's diff was not checked against .actual/rules/."
    exit 0
    ;;
esac
