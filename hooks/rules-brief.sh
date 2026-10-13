#!/usr/bin/env bash
# rules-brief.sh - brief the agent on the rules that govern a file it is working
# on. One script, two registrations in hooks/hooks.json:
#
#   PostToolUse  Read        the main path (below).
#   PreToolUse   Edit|Write  the reminder, for files written without being read
#                            first -- mostly new files from Write (AK-794).
#
# Claude Code requires a Read before an Edit or an overwrite, and PostToolUse
# context lands before the model's next step, so this is the delivery point that
# reaches the agent ahead of its first edit (PreToolUse Edit|Write context only
# arrives with the tool result, after the edit ran). Observed on Claude Code
# 2.1.231; the model applied the context in every test run.
#
# The PreToolUse registration is the fallback that remark implies: its context
# lands with the tool result, after the edit ran, so it can only prompt a
# revision. It costs nothing on a file already briefed, because the CLI keeps
# one once-per-session memory across both events and answers that file with
# silence. It never emits a permissionDecision, and a PreToolUse hook that names
# none neither grants nor blocks: the normal permission flow decides.
#
# This wrapper does only cheap shell checks and then hands the raw hook envelope
# to `actual rules brief --claude-hook`, which resolves the file, ranks the
# governing decisions, and keeps what it has already briefed this session. It
# never parses JSON (see hooks/lib/bootstrap.sh for why).
#
# Advisory by construction, and silent by default: no committed rules, no CLI, an
# old CLI (preflight already prompts once per session), an ungoverned file, a
# crash -- all exit 0 with no output. The only thing ever forwarded is a
# hookSpecificOutput.additionalContext reply for the event this hook was called
# for; any other shape, above all one carrying a permissionDecision, is dropped.

set -uo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/bootstrap.sh
. "${SCRIPT_DIR}/lib/bootstrap.sh"

# Whether the span between the prefix and the closing "}} is one JSON string.
# C locale, as the guards in bootstrap.sh run: the two substitutions walk the
# whole brief, and under a UTF-8 locale on bash 3.2 that cost about 0.18s of CPU
# at 3.5KB and 0.32s at 4.2KB, against 0.02-0.03s here, inside a 2-second
# timeout. The result is the same either way: UTF-8 continuation bytes never
# equal a backslash or a quote.
is_single_json_string() {
  local LC_ALL=C
  local body=${1#"$2"}
  body=${body%\"\}\}}
  body=${body//\\\\/}
  body=${body//\\\"/}
  case "$body" in
    *'"'*) return 1 ;;
  esac
  return 0
}

# Drain stdin before any early exit, so the caller never sees SIGPIPE.
payload=$(cat)

# Where the Claude Code mod (hooks/register.js) loads, it briefs Reads, Edits
# and Writes itself, so this hook stands down rather than briefing first --
# settings hooks run before the mod's own brief. The mod cannot simply skip this
# hook without skipping every other hook on the same event too, so it signals
# instead, a different way per event.
#
# PostToolUse: a top-level field on the event it passes down. It cannot be
# forged by content: inside tool_response every quote is escaped, so an
# unescaped `"key":true` can only be structure.
case "$payload" in
  *'"actual_rules_brief_by_mod":true'*) exit 0 ;;
esac

# The event this hook was called for, which the reply must name. Read from the
# envelope rather than assumed, since one script serves both registrations;
# the field is top level, ahead of any tool content that could spell it. An
# envelope naming neither is not one this hook was registered for.
case "$payload" in
  *'"hook_event_name":"PostToolUse"'*|*'"hook_event_name": "PostToolUse"'*) event=PostToolUse ;;
  *'"hook_event_name":"PreToolUse"'*|*'"hook_event_name": "PreToolUse"'*) event=PreToolUse ;;
  *) exit 0 ;;
esac

# PreToolUse: a file per session, which the mod writes before this hook runs.
# A field cannot ride this event: the only thing the mod can change is the
# tool's arguments, and those are what the permission check judges -- auto
# mode's classifier refuses to judge a Write carrying one it does not know, so
# the Write never runs. TMPDIR because both sides see the same one (the mod
# cannot see CLAUDE_PLUGIN_DATA); trailing slashes stripped on both. The id is
# the first top-level session_id, and a content-spelled one cannot match:
# inside a string its quotes are escaped.
if [ "$event" = PreToolUse ]; then
  sid_re='"session_id": ?"([A-Za-z0-9_-]+)"'
  if [[ $payload =~ $sid_re ]]; then
    tmp=${TMPDIR:-/tmp}
    while [ "${tmp%/}" != "$tmp" ]; do tmp=${tmp%/}; done
    [ -n "$tmp" ] || tmp=/tmp
    [ -e "${tmp}/actual-skill-mod/${BASH_REMATCH[1]}" ] && exit 0
  fi
fi

# Two switches, because they answer different questions. ACTUAL_PLAN_GATE is the
# master off switch every hook in this plugin honours. ACTUAL_RULES_BRIEF turns
# off read-time briefing alone, leaving the plan and Stop gates running: briefing
# is the only hook here that fires on every Read, so it is the only one whose
# cost a user might want to drop without giving up the checks that block.
# Also a no-op inside actual-cli's own subprocesses (see
# inside_actual_subprocess). Briefing cannot recurse the way impl-gate.sh does
# -- it spawns no judge -- but a judge subprocess reads files constantly, so
# every one of those Reads would spawn a CLI this hook has no reason to run,
# and each brief it forwarded would land in the judge's own context as
# additionalContext. A conformance judge must weigh the rules it was given,
# not rules a hook injected into it mid-prompt.
if [ "${ACTUAL_PLAN_GATE:-on}" = "off" ] || [ "${ACTUAL_RULES_BRIEF:-on}" = "off" ] \
   || inside_actual_subprocess; then
  exit 0
fi

# Resolve the repo root ONCE and derive everything else from it. The gates call
# rules_present, rules_dir and resolve_repo_root separately and pay for three
# `git rev-parse` spawns; on a 180-second plan or Stop boundary that is noise,
# but this hook runs on every single Read inside a 2-second timeout, and a git
# spawn measured ~12ms here against a warm checkout. Resolve before the cd, for
# the reason plan-gate.sh gives: root resolution reads cwd, so moving first
# would ask the question from a different place than rules_present answers it.
repo_root=$(resolve_repo_root)
dir=$(rules_dir "$repo_root")

if ! rules_present "$dir" || ! have_actual; then
  exit 0
fi

stderr_file=$(mktemp "${TMPDIR:-/tmp}/actual-rules-brief.XXXXXX") || exit 0
trap 'rm -f "$stderr_file"' EXIT

cd "$repo_root" 2>/dev/null || true

# `--repo` states the root rather than letting the CLI infer it. Without it
# the root comes from the envelope's `cwd`, which follows the agent's `cd`, so
# after `cd apps/actual` every file was placed against that subdirectory: ones
# inside it matched against repository-relative globs, ones outside it refused
# as not under the root. `$repo_root` is resolved above, before the cd, by the
# same `resolve_repo_root` the gates use, so both paths name one root.
reply=$(printf '%s' "$payload" | actual rules brief --claude-hook --repo "$repo_root" --rules-dir "$dir" 2>"$stderr_file")
status=$?

# Silence is the whole contract here: on stdout a brief that never arrives
# looks exactly like a file with no rules. The CLI separates the two on stderr
# as `no-brief=<token>`; this hook does not act on it, but the debug stream
# below carries it, so a quiet read can be explained -- and a PostToolUse
# hook that hits its timeout is cancelled with its output discarded and nothing
# shown to anyone, so there is normally no thread to pull at all. ACTUAL_HOOK_DEBUG
# is the thread: it echoes the CLI's exit status and stderr to this hook's own
# stderr, which Claude Code surfaces under `claude --debug`. Diagnostic only --
# it never touches stdout, never changes a forwarding decision, and never
# changes the exit status, so a debugging session governs exactly as a normal
# one does.
if [ -n "${ACTUAL_HOOK_DEBUG:-}" ]; then
  printf 'actual-rules-brief: exit=%s rules-dir=%s\n' "$status" "$dir" >&2
  [ -s "$stderr_file" ] && sed 's/^/actual-rules-brief: cli-stderr: /' "$stderr_file" >&2
  printf 'actual-rules-brief: cli-stdout: %s\n' "$reply" >&2
fi

# Any failure -- including an old CLI's unknown subcommand -- is silence.
[ "$status" -eq 0 ] || exit 0

trimmed=${reply#"${reply%%[![:space:]]*}"}
trimmed=${trimmed%"${trimmed##*[![:space:]]}"}

# Forward only the one allowlisted shape: a compact object whose sole content is
# additionalContext for the event this hook was called for. The CLI echoes the
# envelope's event, so a reply naming the other one is a CLI out of step with
# its input and is dropped like any other surprise. Matching the exact bytes (rather than
# blocklisting fields) keeps every unrecognized shape -- an added decision,
# updatedInput, a permissionDecision, garbage -- on the silent side. The escape
# and duplicate-key guards are the same ones the gates use: they defend the
# literal-bytes match against \uXXXX spellings.
#
# The opening and closing bytes alone are NOT enough to pin the shape, because
# a reply can close hookSpecificOutput early, append whatever it likes, and
# still end in "}} by finishing on a nested object:
#
#   {"hookSpecificOutput":{...,"additionalContext":"x"},"continue":false,"k":{"a":"b"}}
#
# That decodes to continue:false, which halts the agent outright -- worse than
# the permissionDecision case the guards above target. So the span between the
# prefix and the final "}} is also required to be a single JSON string: strip
# the escape pairs a decoder would consume (backslash pairs first, then escaped
# quotes, the same order json_escape writes them) and refuse anything with a
# quote left over, since that quote can only be the string's own terminator and
# therefore means structure follows it. Together with the \uXXXX guard -- which
# rules out a quote spelled \u0022 that this scan cannot see -- the allowlist
# admits exactly the one shape its name claims.
prefix="{\"hookSpecificOutput\":{\"hookEventName\":\"${event}\",\"additionalContext\":\""
if [ "${trimmed#"$prefix"}" != "$trimmed" ] \
   && [ "${trimmed%\"\}\}}" != "$trimmed" ] \
   && ! has_permission_decision "$trimmed" \
   && ! has_unicode_escape "$trimmed" \
   && ! has_duplicate_permission_decision "$trimmed"; then
  if ! is_single_json_string "$trimmed" "$prefix"; then
    [ -n "${ACTUAL_HOOK_DEBUG:-}" ] && \
      printf 'actual-rules-brief: dropped (content is not a single JSON string)\n' >&2
    exit 0
  fi
  printf '%s\n' "$trimmed"
elif [ -n "${ACTUAL_HOOK_DEBUG:-}" ] && [ -n "$trimmed" ]; then
  printf 'actual-rules-brief: dropped (reply is not the allowlisted shape)\n' >&2
fi
exit 0
