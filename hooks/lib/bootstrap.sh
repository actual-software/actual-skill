#!/usr/bin/env bash
# bootstrap.sh - Shared preflight helpers for the actual plan-stage governance hooks.
#
# Sourced by all four hooks: plan-gate.sh (PreToolUse:ExitPlanMode),
# impl-gate.sh (Stop), rules-brief.sh (PostToolUse:Read, PreToolUse:Edit|Write) and preflight.sh
# (SessionStart). Read-only: never modifies files, config, or state.
#
# Portability: bash 3.2+ (stock macOS) and Linux. Deliberately depends on NOTHING
# beyond bash builtins, `command`, `git`, and the POSIX `cat`, `mktemp`, `sleep`
# and `rm`. In particular it never parses JSON,
# so `jq` and `python3` are not required -- neither ships on stock macOS. JSON is
# only ever *written* here, which is trivial. Parsing the hook envelope is the
# CLI's job (see `actual plan-check --claude-hook`).
#
# Note: these scripts intentionally do NOT `set -e`. The governance gate must fail
# open -- an unexpected error has to leave the agent's work untouched, never abort
# a tool call. Errors are handled explicitly at each call site instead.

set -uo pipefail

# --- Repo and rules discovery ---

# Canonicalize a directory path -- resolves symlinks and trailing slashes so two
# paths can be compared as plain strings. Fails for anything that is not a directory.
canonical_dir() {
  [ -n "${1:-}" ] || return 1
  [ -d "$1" ] || return 1
  (cd -- "$1" 2>/dev/null && pwd -P) || return 1
}

# True when $2 is $1 itself or a directory beneath it. Both arguments must already
# be canonical.
is_within() {
  local outer="${1%/}" inner="$2"
  [ -n "$outer" ] || return 0        # "/" contains every absolute path
  [ "$inner" = "$outer" ] || [ "${inner#"${outer}/"}" != "$inner" ]
}

# Resolve the repository root the hook is running against -- the checkout whose
# .actual/rules/ must govern this decision.
#
# Two signals, neither sufficient alone:
#
#   CLAUDE_PROJECT_DIR  Claude Code's project root. It does NOT follow the session
#                       into a git worktree: it keeps naming the original checkout
#                       while the session works in another one, on another branch.
#   git toplevel of cwd The checkout actually being worked in. But when Claude Code
#                       was launched inside a subdirectory of a larger repository,
#                       this is the outer repo, not the subproject.
#
# When one contains the other, the DEEPER path is the more specific context and wins:
#
#   worktree   project=/repo, toplevel=/repo/.claude/worktrees/x  -> the worktree.
#              Claude Code puts worktrees under the project root, so the active
#              checkout is nested inside CLAUDE_PROJECT_DIR, not outside it.
#   monorepo   project=/repo/packages/api, toplevel=/repo         -> the subproject.
#   ordinary   the two are equal                                  -> either.
#
# Otherwise they are unrelated (a worktree created outside the project root, say) and
# the active checkout under cwd wins. All of this reads cwd rather than the hook
# envelope's `cwd` field, which would mean parsing JSON; Claude Code runs the hook
# from that directory, so the two agree.
resolve_repo_root() {
  local project_dir here git_root

  project_dir=$(canonical_dir "${CLAUDE_PROJECT_DIR:-}") || project_dir=""
  here=$(pwd -P 2>/dev/null) || here="$PWD"

  git_root=$(git rev-parse --show-toplevel 2>/dev/null) || git_root=""
  if [ -n "$git_root" ]; then
    git_root=$(canonical_dir "$git_root") || git_root=""
  fi

  # Only one signal available.
  if [ -z "$project_dir" ]; then
    [ -n "$git_root" ] && { printf '%s' "$git_root"; return 0; }
    printf '%s' "$here"
    return 0
  fi
  if [ -z "$git_root" ]; then
    printf '%s' "$project_dir"
    return 0
  fi

  # Both known: the deeper of the two when nested, else the active checkout.
  if is_within "$project_dir" "$git_root"; then
    printf '%s' "$git_root"
    return 0
  fi
  if is_within "$git_root" "$project_dir"; then
    printf '%s' "$project_dir"
    return 0
  fi
  printf '%s' "$git_root"
}

# Directory holding the committed rule files. ACTUAL_RULES_DIR overrides it, which
# is how a monorepo points the gate at a subproject's rules. plan-gate.sh passes
# this path to the CLI as --rules-dir so scoring uses the same directory.
#
# $1 is an already-resolved repo root. Optional, and resolve_repo_root is called
# when it is absent -- but that call spawns `git rev-parse`, so a caller that
# needs the root anyway should resolve it once and pass it here rather than pay
# for a second spawn. rules-brief.sh runs on every Read and does exactly that.
rules_dir() {
  if [ -n "${ACTUAL_RULES_DIR:-}" ]; then
    printf '%s' "${ACTUAL_RULES_DIR}"
    return 0
  fi
  printf '%s/.actual/rules' "${1:-$(resolve_repo_root)}"
}

# Count the *.md rule files in a directory. Top level only -- the observed
# `.actual/rules/` layout is flat. Prints 0 for a missing or empty directory.
rules_count() {
  local dir="$1"
  [ -d "$dir" ] || { printf '0'; return 0; }

  local f count=0
  for f in "$dir"/*.md; do
    # Guards the literal glob pattern when nothing matches (no nullglob in bash 3.2).
    [ -e "$f" ] && count=$((count + 1))
  done
  printf '%s' "$count"
}

# True when this repo has committed rules to govern against. When false every hook
# must be a completely silent no-op, so installing the plugin never affects
# unrelated repositories.
#
# $1 is an already-resolved rules directory, for the same reason rules_dir takes
# a root: without it this re-resolves the directory, and therefore the repo root,
# from scratch.
rules_present() {
  [ "$(rules_count "${1:-$(rules_dir)}")" -gt 0 ]
}

# True inside a `claude` subprocess that actual-cli itself spawned (its
# conformance judge, stage-2 rank, or tailoring), which the CLI marks with
# ACTUAL_CLI_SUBPROCESS=1. Every hook must be a silent no-op there. Otherwise
# the subprocess's own Stop hook reruns `actual impl-check`, which spawns
# another subprocess, and so on -- an unbounded chain that holds the outer
# judge until its budget expires and leaves orphaned hooks spawning model
# calls after it gives up. actual-cli also passes disableAllHooks to those
# subprocesses; this is the backstop for a runner or Claude Code version
# where that flag doesn't take effect.
inside_actual_subprocess() {
  [ "${ACTUAL_CLI_SUBPROCESS:-}" = "1" ]
}

# True when a SessionStart envelope ($1) names source "startup": a session
# starting, rather than one resumed, cleared, compacted or forked. A substring
# match with whitespace dropped, like is_deny_decision, so nothing parses JSON.
# An envelope it cannot read counts as a later SessionStart, the gentler case.
is_session_startup() {
  local s="$1"
  s=${s// /}
  s=${s//$'\n'/}
  s=${s//$'\t'/}
  s=${s//$'\r'/}
  [ "${s#*\"source\":\"startup\"}" != "$s" ]
}

# --- CLI detection ---

have_actual() {
  command -v actual >/dev/null 2>&1
}

# The oldest CLI release this plugin supports. 0.8.0 is the first whose
# `session summary --json` returns the line the band above the prompt shows.
# Raise it in the change that starts relying on a newer release, along with
# plugin.json's version and the README's requirement.
MIN_CLI_VERSION=0.8.0

# The oldest release every check runs in full on. 0.7.0 added the
# UserPromptSubmit dispatch turn-start.sh needs, and without it the Stop check
# misses work committed during a turn. Below this version the upgrade offer
# interrupts the task when a session starts (min_version_interrupt). Raise it
# in the change that makes a check rely on a newer release.
GATES_MIN_CLI_VERSION=0.7.0

# Seconds each `actual` call preflight.sh makes may take: the budget the mod
# gives each of its own spawns (SPAWN_TIMEOUT_MS in register.js).
CLI_CALL_TIMEOUT=2

# Run `actual "$@"` with stdin closed and print its stdout. A call still running
# after CLI_CALL_TIMEOUT seconds is killed and fails with status 124, as
# timeout(1) does, which stock macOS lacks. Output goes through a file because
# npm's launcher runs the real binary as a child that inherits stdout, and a
# killed launcher would leave that child holding a pipe open. A CLI killed by
# SIGKILL from elsewhere, or a temp file that cannot be made, also gives 124.
run_actual() {
  local out pid watchdog status
  out=$(mktemp "${TMPDIR:-/tmp}/actual-preflight.XXXXXX") || return 124
  actual "$@" </dev/null >"$out" 2>/dev/null &
  pid=$!
  # The watchdog kills its own sleep when it is stopped, so a call that answers
  # in time leaves no process behind.
  ( sleeper=""
    trap '[ -n "$sleeper" ] && kill "$sleeper"; exit 0' TERM
    sleep "$CLI_CALL_TIMEOUT" &
    sleeper=$!
    wait "$sleeper" && kill -KILL "$pid" ) </dev/null >/dev/null 2>&1 &
  watchdog=$!
  wait "$pid"
  status=$?
  kill "$watchdog" 2>/dev/null && wait "$watchdog" 2>/dev/null
  [ "$status" -eq 137 ] && status=124
  printf '%s' "$(<"$out")"
  rm -f "$out"
  return "$status"
}

# The installed CLI's version as MAJOR.MINOR.PATCH, from `actual --version`
# ("actual 0.8.0"). A pre-release suffix is dropped, so 0.8.0-rc.1 counts as
# 0.8.0. Prints nothing and fails when the output names no version or no answer
# came in time, with status 2 when `actual --version` itself fails: that CLI
# cannot run at all, as npm's launcher shows when its platform package is
# missing. A slow answer is not that, so it reads as an unreadable version.
cli_version() {
  local out status re='[0-9]+\.[0-9]+\.[0-9]+'
  out=$(run_actual --version)
  status=$?
  [ "$status" -eq 124 ] && return 1
  [ "$status" -eq 0 ] || return 2
  [[ $out =~ $re ]] || return 1
  printf '%s' "${BASH_REMATCH[0]}"
}

# True when version $1 is older than version $2. Each dot-separated part is
# compared as a number, so 0.10.0 is newer than 0.8.0.
version_older_than() {
  local a="$1." b="$2." x y
  while [ -n "$a" ] && [ -n "$b" ]; do
    x=${a%%.*} y=${b%%.*}
    [ "$x" -lt "$y" ] && return 0
    [ "$x" -gt "$y" ] && return 1
    a=${a#*.} b=${b#*.}
  done
  return 1
}

# True when plan-check exited 2 because this CLI build has no such subcommand.
# Used by the gate instead of a --help spawn: an unknown subcommand must fail
# open with upgrade guidance, not be treated as a deny (exit 2 fallback).
is_unrecognized_plan_check() {
  local err
  err=$(<"$1") || return 1
  case "$err" in
    *unrecognized\ subcommand*plan-check*) return 0 ;;
  esac
  return 1
}

# impl-check's own counterpart of is_unrecognized_plan_check.
is_unrecognized_impl_check() {
  local err
  err=$(<"$1") || return 1
  case "$err" in
    *unrecognized\ subcommand*impl-check*) return 0 ;;
  esac
  return 1
}

# True when a plan-check/impl-check exit 2 came from the CLI rejecting its own
# invocation (clap argument parsing: a bad ACTUAL_IMPL_CHECK_MAX_ROUNDS value,
# a version-skewed flag) rather than from a deny. Every clap error starts with
# "error: "; the CLI's deny reasons never do. Rejected before the judge ran, so
# no round limit ever breaks the loop -- the gates must fail open on this, not
# block. Check is_unrecognized_* first: that stderr also starts with "error: "
# but gets its own upgrade guidance.
is_cli_usage_error() {
  local err
  err=$(<"$1") || return 1
  case "$err" in
    'error: '*) return 0 ;;
  esac
  return 1
}

# impl-check's UserPromptSubmit dispatch (CLI 0.7.0) post-dates impl-check,
# and a CLI without it runs the whole check on that envelope instead of
# recording where the turn starts. The dispatch has no flag of its own, so this
# reads the help that documents it; no earlier release names the event there.
have_turn_start() {
  local help
  help=$(actual impl-check --help 2>/dev/null) || return 1
  case "$help" in
    *UserPromptSubmit*) return 0 ;;
  esac
  return 1
}

# ADR header v2 (a YAML header at the top of a rule file) is read by the CLI, not
# by this plugin, and a CLI that predates it reads such a file as a flat v1
# document: wrong scope, wrong briefs, nothing said. There is no flag to probe, so
# like have_turn_start this reads the help that documents it. `rules brief --help`
# names the capability marker `adr-header-v2` (actual-cli 0.9.0, AK-962). The
# marker is an agreed literal, not a version comparison: it is true for exactly
# the builds that parse the header.
have_adr_v2() {
  local help
  help=$(actual rules brief --help 2>/dev/null) || return 1
  case "$help" in
    *adr-header-v2*) return 0 ;;
  esac
  return 1
}

# True when any rule file in the directory opens with a `---` line, which is what
# a v2 header starts with. The first line only: this plugin never parses YAML,
# and a v1 file starts with a `# ` title. Stops at the first hit, and reads with a
# builtin, so a v1 repository pays one `read` per file and spawns nothing.
rules_have_v2_header() {
  local dir="$1" f line
  [ -d "$dir" ] || return 1
  for f in "$dir"/*.md; do
    [ -e "$f" ] || continue
    line=
    IFS= read -r line <"$f" || true
    line=${line%$'\r'}
    [ "$line" = '---' ] && return 0
  done
  return 1
}

# True when this repository has v2 rule files and the installed CLI cannot read
# them. The only state that changes behaviour: a v1 repository, or a CLI that
# has the marker, behaves exactly as before. Callers have already checked
# have_actual, because the probe spawns it. The cheap file check goes first so a
# v1 repository never spawns the probe.
adr_v2_unsupported() {
  rules_have_v2_header "$1" && ! have_adr_v2
}

# --- Operator-facing messages ---

# Install matrix mirrors the one documented in skills/actual/SKILL.md.
#
# Phrased as an instruction to the agent, not just information for a human: this
# text is consumed as hook context (SessionStart additionalContext, or a PreToolUse
# systemMessage), so ask the agent to actively offer the install rather than passively
# describe it. It must still ask the user first -- installing a global CLI is a
# machine-wide change the agent should never make unprompted. Do not use it from
# impl-gate.sh: Stop's systemMessage is shown to the user and never reaches
# Claude (see stop_install_notice).
#
# additionalContext/systemMessage is advisory, not a directive the agent is forced to
# act on -- unlike a deny, nothing about the hook protocol makes the agent interrupt
# what it is already doing to surface this. Observed on Claude Code 2.1.206, in two
# stages:
#   1. A softer "offer to install" phrasing, dropped into a session already mid-task
#      (a feature plan already underway), was silently absorbed into context and
#      never mentioned in any reply.
#   2. Adding "regardless of what else is in progress" / "in your very next reply"
#      fixed that -- the agent did mention it -- but then proceeded straight through
#      plan approval into implementation without ever getting an actual answer.
#      Mentioning something in passing and pausing for a decision are different
#      behaviors, and the text has to ask for the second one explicitly: naming the
#      question tool (AskUserQuestion, matching SKILL.md's existing convention) and
#      saying in so many words that a mention followed by continuing anyway does not
#      count as asking.
# This is still a probability improvement, not a guarantee: the fail-open contract
# (see plan-gate.sh) means a missing CLI can never become a real interrupt (a deny)
# just to make this more reliable, so the agent is always free to disregard it.
install_message() {
  cat <<'EOF'
Actual plan-stage governance is configured for this repository (.actual/rules/ is
present), but the `actual` CLI is not on PATH, so plans are not being checked.

This is worth interrupting the current task for: mention it in your very next reply,
regardless of what else is in progress. Offer to install it now rather than just
describing the steps -- ask using an interactive question tool (e.g. AskUserQuestion)
so your turn actually pauses for the user's answer, and do not continue this task --
exploring, planning, or implementing -- until they respond. Mentioning this and then
carrying on anyway does not satisfy this; wait for the answer first.

If they agree, run one of these with the Bash tool:
  npm install -g @actualai/actual
  brew install actual-software/actual/actual

Then verify with: actual --version. If they decline, don't run anything --
installation stays optional -- but only resume the original task once they have
actually answered either way.
Docs: https://cli.actual.ai
EOF
}

upgrade_message() {
  cat <<'EOF'
Actual plan-stage governance is configured for this repository (.actual/rules/ is
present), but the installed `actual` CLI has no `plan-check` subcommand, so plans
are not being checked.

This is worth interrupting the current task for: mention it in your very next reply,
regardless of what else is in progress. Offer to upgrade it now rather than just
describing the steps -- ask using an interactive question tool (e.g. AskUserQuestion)
so your turn actually pauses for the user's answer, and do not continue this task --
exploring, planning, or implementing -- until they respond. Mentioning this and then
carrying on anyway does not satisfy this; wait for the answer first.

If they agree, run one of these with the Bash tool:
  npm install -g @actualai/actual@latest
  brew upgrade actual-software/actual/actual

Then verify with: actual plan-check --help. If they decline, don't run anything --
upgrading stays optional -- but only resume the original task once they have
actually answered either way.
EOF
}

# For a repository with committed rules whose `actual` is on PATH but fails
# `actual --version`. Nothing there is checked, and the gates only report that
# they did not run, so this asks the way install_message does. A CLI that
# cannot run cannot name the channel that installed it, so both commands go
# out, and Homebrew's is `reinstall` because `brew install` leaves an installed
# formula as it is.
reinstall_interrupt() {
  cat <<'EOF'
Actual governance is configured for this repository (.actual/rules/ is present),
but the installed `actual` CLI does not run: `actual --version` failed, so no plan
or diff is being checked.

This is worth interrupting the current task for: mention it in your very next reply,
regardless of what else is in progress. Offer to reinstall it now rather than just
describing the steps -- ask using an interactive question tool (e.g. AskUserQuestion)
so your turn actually pauses for the user's answer, and do not continue this task --
exploring, planning, or implementing -- until they respond. Mentioning this and then
carrying on anyway does not satisfy this; wait for the answer first.

If they agree, run whichever of these installed it, with the Bash tool:
  npm install -g @actualai/actual
  brew reinstall actual-software/actual/actual

Check which first: `ls -l "$(command -v actual)"` shows a link into Homebrew's
Cellar for a Homebrew install and into node_modules for an npm one. Running the
other command would add a second copy instead of repairing this one, so ask the
user if neither applies.

Then verify with: actual --version. If they decline, don't run anything --
reinstalling stays optional -- but only resume the original task once they have
actually answered either way.
EOF
}

# Upgrade advice for a CLI older than MIN_CLI_VERSION, which preflight.sh gives
# in a repository with committed rules, in one of three forms. $1 is the
# installed version.
#
# This one is for a CLI older than GATES_MIN_CLI_VERSION when a session starts.
# Some check there is not running in full, so the user believes their work is
# governed when part of it is not: the false sense of safety that earns
# install_message its interrupt-and-wait wording.
min_version_interrupt() {
  local installed="$1" how
  how=$(upgrade_instructions)
  cat <<EOF
Actual governance is configured for this repository (.actual/rules/ is present),
but the installed \`actual\` CLI is ${installed} and its checks need ${GATES_MIN_CLI_VERSION} or
later to run in full, so some of your changes can go unchecked. This plugin
needs ${MIN_CLI_VERSION} or later.

This is worth interrupting the current task for: mention it in your very next reply,
regardless of what else is in progress. Offer to upgrade it now rather than just
describing the steps -- ask using an interactive question tool (e.g. AskUserQuestion)
so your turn actually pauses for the user's answer, and do not continue this task --
exploring, planning, or implementing -- until they respond. Mentioning this and then
carrying on anyway does not satisfy this; wait for the answer first.

${how}

Then verify with: actual --version. If they decline, don't run anything --
upgrading stays optional -- but only resume the original task once they have
actually answered either way.
EOF
}

# The same news for every later SessionStart: resume, clear, compact and fork.
# The interrupt asked when the session started, and asking that way again after
# each compaction would put a user who said no in front of the same blocking
# question until they upgrade. So this asks at a pause, and not after a no.
min_version_reminder() {
  local installed="$1" how
  how=$(upgrade_instructions)
  cat <<EOF
Actual governance is configured for this repository (.actual/rules/ is present),
but the installed \`actual\` CLI is ${installed} and its checks need ${GATES_MIN_CLI_VERSION} or
later to run in full, so some of your changes can go unchecked. This plugin
needs ${MIN_CLI_VERSION} or later.

This session is already under way, so this does not need to interrupt the task
in progress. At a natural pause, such as the end of your next reply, mention it
once and offer to upgrade, asking with an interactive question tool (e.g.
AskUserQuestion). If the user already declined it in this session, don't ask again.

${how}

Then verify with: actual --version. If they decline, don't run anything --
upgrading stays optional.
EOF
}

# The ADR header v2 counterpart of the upgrade messages above. Same escalation
# as them, for the same reason: the gates are supposed to block, and against v2
# files an old CLI would judge from the wrong scope, so the user believes they
# are governed when they are not. The gates stand down on this path (see
# adr_v2_unsupported), so nothing is checked until the CLI is upgraded.
adr_v2_upgrade_message() {
  cat <<'EOF'
Actual governance is configured for this repository, and its .actual/rules/ files
use the ADR header v2 format (a YAML header at the top of each file), but the
installed `actual` CLI is too old to read it (it needs 0.9.0 or newer). Plans and
changes are not being checked against these rules, and rule briefing is off, until
the CLI is upgraded.

This is worth interrupting the current task for: mention it in your very next reply,
regardless of what else is in progress. Offer to upgrade it now rather than just
describing the steps -- ask using an interactive question tool (e.g. AskUserQuestion)
so your turn actually pauses for the user's answer, and do not continue this task --
exploring, planning, or implementing -- until they respond. Mentioning this and then
carrying on anyway does not satisfy this; wait for the answer first.

If they agree, run one of these with the Bash tool:
  npm install -g @actualai/actual@latest
  brew upgrade actual-software/actual/actual

Then verify with: actual rules brief --help (it should name adr-header-v2). If they
decline, don't run anything -- upgrading stays optional -- but only resume the
original task once they have actually answered either way.
EOF
}

# One line, for the places the full message above does not fit: a PreToolUse
# notice and Stop's user-facing systemMessage, both repeated on every plan and
# every turn. What failed and the command that fixes it.
adr_v2_standdown_notice() {
  printf '%s' "Actual governance stood down: .actual/rules/ uses the ADR header v2 format, which the installed \`actual\` CLI is too old to read (needs 0.9.0+), so $1. Upgrade with \`npm install -g @actualai/actual@latest\` or \`brew upgrade actual-software/actual/actual\`."
}

# For a CLI from GATES_MIN_CLI_VERSION up to MIN_CLI_VERSION. Every check runs
# on it, so nothing it lacks leaves work unchecked, and the agent offers the
# upgrade at a pause rather than stopping the task. preflight.sh appends this
# to the message that governance is active.
min_version_offer() {
  local installed="$1" how
  how=$(upgrade_instructions)
  cat <<EOF
The installed \`actual\` CLI is ${installed}, and the actual plugin loaded in this
session needs ${MIN_CLI_VERSION} or later, so some of what it adds may not work as
documented.

Every check above runs on this version, so this does not need to interrupt the
task in progress. At a natural pause, such as the end of your next reply, mention
it once and offer to upgrade, asking with an interactive question tool (e.g.
AskUserQuestion). If the user already declined it in this session, don't ask again.

${how}

Then verify with: actual --version. If they decline, don't run anything --
upgrading stays optional.
EOF
}

# How to upgrade, for the messages above. `actual version --json` names the
# command for the channel that installed this CLI, which it reads from its own
# path. Without --check it answers from local facts, so a session start never
# waits on the registry. A CLI older than that subcommand gets both commands,
# and a way to tell which applies: running the other would leave a second
# `actual` on PATH.
#
# The agent runs this command on the user's yes, so it is passed on only when
# it is one actual-cli names for its two channels, compared whole: a prefix
# match would also pass `npm install -g @actualai/actual @someone/else`. A CLI
# installed some other way always gets the release page below, which is also
# the release_url actual-cli reports.
upgrade_instructions() {
  local out="" channel="" cmd=""
  out=$(run_actual version --json) || out=""
  if [ -n "$out" ] && ! has_unicode_escape "$out"; then
    channel=$(extract_json_string_field "$out" channel) || channel=""
    cmd=$(extract_json_string_field "$out" upgrade_command) || cmd=""
  fi
  case "$cmd" in
    'brew upgrade actual-software/actual/actual') ;;
    'npm install -g @actualai/actual'|'npm install -g @actualai/actual@latest') ;;
    *) cmd="" ;;
  esac

  if [ -n "$cmd" ]; then
    cat <<EOF
If they agree, run this with the Bash tool:
  ${cmd}
EOF
  elif [ "$channel" = "other" ]; then
    cat <<'EOF'
It was installed without Homebrew or npm, so don't run either of those: each would
add a second copy instead of upgrading this one. If they agree, help them replace
it with the latest release from https://github.com/actual-software/actual-releases/releases/latest.
EOF
  else
    cat <<'EOF'
If they agree, run whichever of these installed it, with the Bash tool:
  npm install -g @actualai/actual@latest
  brew upgrade actual-software/actual/actual

Check which first: `ls -l "$(command -v actual)"` shows a link into Homebrew's
Cellar for a Homebrew install and into node_modules for an npm one. Running the
other command would add a second copy instead of upgrading this one, so ask the
user if neither applies.
EOF
  fi
}

# User-facing counterparts of install_message and the upgrade advice above, for
# impl-gate.sh only. Stop's systemMessage is shown to the user and does not
# reach Claude, and it is emitted again at the end of every turn until the CLI
# can actually run the check. The agent-directed essay (AskUserQuestion, "your
# very next reply") is the wrong text for that channel and that cadence.
# SessionStart already delivers the essay as additionalContext, which is the
# channel the agent reads. These stay one sentence: what failed, and the
# command that fixes it.
stop_install_notice() {
  cat <<'EOF'
Actual implementation governance did not run: the `actual` CLI is not installed, so this turn's diff was not checked against .actual/rules/. Install it with `npm install -g @actualai/actual` or `brew install actual-software/actual/actual`.
EOF
}

stop_impl_upgrade_notice() {
  cat <<'EOF'
Actual implementation governance did not run: the installed `actual` CLI has no `impl-check` subcommand, so this turn's diff was not checked against .actual/rules/. Upgrade it with `npm install -g @actualai/actual@latest` or `brew upgrade actual-software/actual/actual`.
EOF
}

# --- JSON writing ---

# Escape a string for use inside a JSON string literal. Pure parameter expansion,
# no subprocesses. Order matters: backslashes first.
json_escape() {
  local s="$1"
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=${s//$'\t'/\\t}
  s=${s//$'\r'/\\r}
  s=${s//$'\n'/\\n}
  printf '%s' "$s"
}

# True when a JSON object names permissionDecision:deny. Whitespace-insensitive so
# pretty-printed CLI output is still caught. A substring match, not a parse -- so
# plan-gate.sh forwards a verdict only when this recognizes it, never on the absence
# of some other shape. JSON lets any character be spelled as a \uXXXX escape, which
# defeats a literal-bytes match; an escaped "allow" that this function fails to
# recognize as deny is therefore refused (advisory, no decision), not forwarded.
# That asymmetry is deliberate: the failure mode of this match landing wrong must be
# fail-safe, and "no decision" is always safe here.
is_deny_decision() {
  local s="$1"
  s=${s// /}
  s=${s//$'\n'/}
  s=${s//$'\t'/}
  s=${s//$'\r'/}
  [ "${s#*\"permissionDecision\":\"deny\"}" != "$s" ]
}

# True when a JSON object names a systemMessage field at all (any value). Used
# together with has_permission_decision below to allowlist a second shape
# plan-gate.sh may forward: a bare notice, such as partial-coverage or
# round-limit disclosure, that carries no permission decision of any kind.
has_system_message() {
  local s="$1"
  s=${s// /}
  s=${s//$'\n'/}
  s=${s//$'\t'/}
  s=${s//$'\r'/}
  [ "${s#*\"systemMessage\":}" != "$s" ]
}

# True when a JSON object names a permissionDecision field at all, regardless of
# its value. Deliberately broader than is_deny_decision: a verdict that carries
# any permissionDecision -- deny (already forwarded on its own), allow, or an
# escaped/unrecognized value -- must never additionally be forwarded as a bare
# notice. Fail-safe means the notice path requires proven absence of this field,
# not merely a failed match against "allow" or "deny".
has_permission_decision() {
  # C locale for the three substitutions below. In a UTF-8 locale bash walks
  # the string by character, and on stock macOS bash 3.2 that cost a median
  # 0.98s of CPU and 1.38s of wall time on a 3,508-byte brief -- against this
  # hook's 2-second timeout, which 2 of 12 runs under load exceeded. A
  # cancelled brief is not merely late: the CLI records its decisions in
  # session memory before returning, so a later read of the same file is
  # deduped against a brief the agent never saw. C locale makes it 0.19s.
  local LC_ALL=C
  local s="$1"
  s=${s// /}
  s=${s//$'\n'/}
  s=${s//$'\t'/}
  s=${s//$'\r'/}
  [ "${s#*\"permissionDecision\":}" != "$s" ]
}

# True when the payload contains a \uXXXX escape anywhere. JSON permits spelling any
# character this way, which is exactly what defeats the literal-bytes matching above:
# a payload can decode to "permissionDecision":"allow" while never containing those
# literal bytes (escape the key, the value, or both) -- and, on a duplicate key,
# whichever decoder reads it last wins, so an escaped duplicate can silently override
# even a literal "deny". Neither is_deny_decision's nor has_permission_decision's
# match can be trusted against such a payload, so plan-gate.sh must gate both the
# deny and the notice branch on this, not treat a failed literal match as proof of
# anything.
#
# Escaped backslash pairs (\\) are dropped first, left to right, the same way a
# JSON decoder tokenizes them: a deny reason quoting source code that contains a
# é-style literal arrives as \\u00e9, which decodes to a backslash followed
# by plain text, not an escape. Without this, such a deny would be refused as
# uninterpretable and the turn would end unblocked. An escaped backslash followed
# by a real escape (\\p) still leaves the p behind to be caught.
has_unicode_escape() {
  # C locale, as above: see has_permission_decision.
  local LC_ALL=C
  local s="$1"
  s=${s// /}
  s=${s//$'\n'/}
  s=${s//$'\t'/}
  s=${s//$'\r'/}
  s=${s//\\\\/}
  case "$s" in
    *'\u'[0-9a-fA-F][0-9a-fA-F][0-9a-fA-F][0-9a-fA-F]*) return 0 ;;
  esac
  return 1
}

# True when the payload names permissionDecision twice in plain bytes, with no
# escape needed. A decoder resolving duplicate keys last-wins (as Claude Code's
# does) reads whichever value comes last, so a literal "deny" followed by a
# second, literal permissionDecision key decodes to that second value even
# though is_deny_decision's literal-bytes match is satisfied by the first
# occurrence alone. has_unicode_escape does not catch this -- nothing here is
# escaped -- so check for the duplicate explicitly, on the same fail-safe
# footing: cut at the first permissionDecision key and look for a second.
has_duplicate_permission_decision() {
  # C locale, as above: see has_permission_decision.
  local LC_ALL=C
  local s="$1"
  s=${s// /}
  s=${s//$'\n'/}
  s=${s//$'\t'/}
  s=${s//$'\r'/}
  local rest="${s#*\"permissionDecision\":}"
  [ "$rest" = "$s" ] && return 1
  [ "${rest#*\"permissionDecision\":}" != "$rest" ]
}

# Advisory for a PreToolUse hook that is NOT making a permission decision.
#
# Deliberately emits no `permissionDecision`. Per the hook protocol a hook "can deny
# the call, but staying silent doesn't approve it" -- so omitting the field leaves the
# normal permission flow intact. A conforming plan must stay silent on that field;
# only `deny` (or exit 2) may block.
#
# `allow` is never correct on this gate, because it is a grant: a gate has no business
# approving a plan on the user's behalf. Measured on Claude Code 2.1.231, an `allow`
# here does NOT in fact bypass the plan-approval dialog -- Claude Code logs "Hook
# returned 'allow' for ExitPlanMode, but ask rule/safety check requires full
# permission pipeline" and prompts the user anyway. That upstream safety check is
# undocumented, so this wrapper drops an `allow` verdict rather than depending on it.
#
# systemMessage is emitted both top level and inside hookSpecificOutput because its
# documented location has moved between versions; unknown fields are ignored.
emit_pretooluse_notice() {
  local msg
  msg=$(json_escape "$1")
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"PreToolUse","systemMessage":"%s"}}\n' \
    "$msg" "$msg"
}

emit_sessionstart_context() {
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
    "$(json_escape "$1")"
}

# --- Stop hook output (impl-gate.sh) ---
#
# Stop's decision control is NOT hookSpecificOutput.permissionDecision -- it is
# a top-level `decision`/`reason` pair, `{"decision":"block","reason":"..."}`,
# verified against https://code.claude.com/docs/en/hooks (Stop decision
# control), not assumed from the PreToolUse/ExitPlanMode precedent these
# PreToolUse emitters above were verified against. `actual impl-check
# --claude-hook` reuses plan-check's own JSON renderer, which always emits a
# PreToolUse-shaped hookSpecificOutput regardless of which Claude Code event is
# asking -- forwarded verbatim to Stop, that shape carries no `decision` field
# at all, so Claude Code would silently ignore it and let the turn end. Every
# function below therefore re-renders rather than forwards.

# Extract the value of the first "<field>" string in a JSON document, as a
# quote-aware byte scan -- never a JSON parse, matching this library's
# dependency-hygiene constraint (see the file header). The returned value is
# still JSON-string-escaped exactly as it appeared in $1: callers that copy it
# into a *_raw emitter below must not run it through json_escape again, or
# they will double-escape it.
#
# Whitespace between the field name, the colon, and the opening quote is
# skipped (space, tab, CR, LF -- the same set is_deny_decision strips). A
# pretty-printed `"permissionDecisionReason": "..."`, or one with the colon on
# the next line, still yields the reason. Whitespace inside the value is kept.
# An occurrence of the field name that is not followed by that colon-quote
# shape is not a field (a shorter key that is only a prefix of a longer one,
# for example); the scan resumes after it.
#
# Callers MUST gate this on has_unicode_escape/has_duplicate_permission_decision
# returning false first (impl-gate.sh always does, via render_stop_verdict):
# a \uXXXX escape spells a literal double-quote a byte scan cannot see, so
# this function's quote-termination logic can only be trusted once those
# checks have ruled that out. Prints nothing and fails (exit 1) when the
# field is absent or its value is not a terminated string.
extract_json_string_field() {
  local s="$1" field="$2" key rest out c i len found_colon found_quote
  key="\"${field}\""

  while :; do
    rest="${s#*"$key"}"
    [ "$rest" = "$s" ] && return 1
    # Resume here if this occurrence is not a field, so a prefix of a longer
    # key cannot hide a later real one.
    s="$rest"

    i=0
    len=${#rest}
    found_colon=0
    while [ "$i" -lt "$len" ]; do
      c="${rest:$i:1}"
      case "$c" in
        ' '|$'\t'|$'\n'|$'\r') i=$((i + 1)) ;;
        ':') found_colon=1; i=$((i + 1)); break ;;
        *) break ;;
      esac
    done
    [ "$found_colon" -eq 1 ] || continue

    found_quote=0
    while [ "$i" -lt "$len" ]; do
      c="${rest:$i:1}"
      case "$c" in
        ' '|$'\t'|$'\n'|$'\r') i=$((i + 1)) ;;
        '"') found_quote=1; i=$((i + 1)); break ;;
        *) break ;;
      esac
    done
    [ "$found_quote" -eq 1 ] || continue

    out=""
    while [ "$i" -lt "$len" ]; do
      c="${rest:$i:1}"
      if [ "$c" = '\' ]; then
        # A backslash always introduces a single-char escape here (\\, \", \n,
        # \t, \r, \/, \b, \f) -- \uXXXX is excluded by the caller-side gate
        # above -- so consume it and the next byte together, verbatim, and
        # never test that next byte as a potential terminating quote.
        out="${out}${c}${rest:$((i + 1)):1}"
        i=$((i + 2))
        continue
      fi
      if [ "$c" = '"' ]; then
        printf '%s' "$out"
        return 0
      fi
      out="${out}${c}"
      i=$((i + 1))
    done
    return 1
  done
}

# Stop's one blocking shape: top-level decision:"block" with a required
# reason (see the section comment above for why this differs from
# emit_pretooluse_notice's shape). $1 has already been extracted from another
# JSON document's string value via extract_json_string_field and is therefore
# already valid JSON-string-escaped bytes -- running it through json_escape
# here would double-escape it. A script-composed reason goes through
# emit_stop_block instead, which escapes first.
emit_stop_block_raw() {
  printf '{"decision":"block","reason":"%s"}\n' "$1"
}

# Same shape as emit_stop_block_raw, for a reason this script composed rather
# than extracted. json_escape runs first so a quote or newline in $1 cannot
# break the emitted object.
emit_stop_block() {
  emit_stop_block_raw "$(json_escape "$1")"
}

# Advisory for a Stop hook that must NOT force continuation. Stop's only two
# channels that reach Claude -- decision:"block" and
# hookSpecificOutput.additionalContext -- both force continuation ("the same
# loop protections as decision: block", per the docs); neither is safe for a
# fail-open notice that must let the turn end normally. So this emits a plain,
# user-facing systemMessage and nothing else -- unlike
# emit_pretooluse_notice, there is no agent-facing counterpart here to also
# populate.
emit_stop_notice() {
  printf '{"systemMessage":"%s"}\n' "$(json_escape "$1")"
}

# Same shape, but $1 is already JSON-string-escaped (see emit_stop_block_raw).
emit_stop_notice_raw() {
  printf '{"systemMessage":"%s"}\n' "$1"
}

# Classify and re-render `actual impl-check --claude-hook`'s PreToolUse-shaped
# stdout ($1) into Stop's own JSON contract, printing the result (or nothing)
# to stdout. Mirrors the allowlist plan-gate.sh applies inline to its own
# verdict -- see that script's comments for the full rationale -- but ends in
# a re-render instead of a forward. A recognized deny always blocks: the
# extracted reason when the scan can read it, otherwise a fixed reason. A deny
# must not degrade to a notice, which would let the turn end.
render_stop_verdict() {
  local verdict="$1" trimmed reason message

  trimmed=${verdict#"${verdict%%[![:space:]]*}"}
  trimmed=${trimmed%"${trimmed##*[![:space:]]}"}

  if [ "${trimmed#\{}" != "$trimmed" ] && [ "${trimmed%\}}" != "$trimmed" ]; then
    if has_unicode_escape "$trimmed" || has_duplicate_permission_decision "$trimmed"; then
      emit_stop_notice \
        "Actual implementation governance received a verdict it could not safely interpret (it contained an escaped character sequence or a duplicate permissionDecision key); this turn's diff was not checked against .actual/rules/."
    elif is_deny_decision "$trimmed"; then
      reason=$(extract_json_string_field "$verdict" "permissionDecisionReason") || reason=""
      if [ -n "$reason" ]; then
        emit_stop_block_raw "$reason"
      else
        # Missing, empty, or not a string. Stop requires a reason on block;
        # an empty one fails schema validation and the turn would end.
        emit_stop_block \
          "Actual implementation governance denied this diff, but the verdict reason could not be read. Revise the diff so it conforms to .actual/rules/."
      fi
    elif has_system_message "$trimmed" && ! has_permission_decision "$trimmed"; then
      message=$(extract_json_string_field "$verdict" "systemMessage") || message=""
      [ -n "$message" ] && emit_stop_notice_raw "$message"
    fi
  fi
}
