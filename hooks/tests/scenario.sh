#!/usr/bin/env bash
# scenario.sh - run and analyse briefing scenarios against a real repository.
#
# Three commands, matching the three things that turned out to be needed when
# refining the mod against live sessions:
#
#   doctor <repo>        Is this repo usable for a scenario at all?
#   replay <transcript>  What would the extractor do with that session's
#                        commands, without re-running the session?
#   analyse <transcript> What did briefing actually do, and what did the gate
#                        then block on?
#
# `replay` is the fast loop: change the extractor, replay a recorded session,
# see the difference. `analyse` is the slow loop: what a real session did.
#
# Deliberately a test-side tool, not shipped behaviour: it reads transcripts
# and rule files and changes nothing.

set -uo pipefail

HOOKS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
CLI=${ACTUAL_CLI:-actual}

die() { printf 'scenario: %s\n' "$1" >&2; exit 1; }

# --- doctor ---------------------------------------------------------------
#
# Every one of these has blocked a scenario at least once. The path-bearing
# rules check is the one that is easy to miss: selection scores on `verify`
# path globs, so a rule set whose Verify blocks are all generic shell commands
# governs no file, and briefing silently never fires.
cmd_doctor() {
  local repo="${1:-$PWD}" fail=0
  repo=$(cd "$repo" 2>/dev/null && pwd) || die "no such directory: ${1:-$PWD}"
  printf 'repo: %s\n\n' "$repo"

  local rules="${repo}/.actual/rules"
  local count=0
  [ -d "$rules" ] && count=$(find "$rules" -maxdepth 1 -name '*.md' | wc -l | tr -d ' ')
  if [ "$count" -gt 0 ]; then
    printf '  ok    %s rule documents\n' "$count"
  else
    printf '  FAIL  no rule documents in .actual/rules\n'; fail=1
  fi

  # Ask the real question rather than a proxy for it: does the selector
  # actually return a decision for a file in this repo?
  #
  # This used to check how many documents name a path in their `Verify` block,
  # because selection was path-only and a rule set written without paths
  # governed nothing. `rules brief` now passes the file's path as query text as
  # well, so the title and scope-prose fields match too and a pathless corpus
  # briefs normally. The proxy would now fail a repo that works.
  if [ "$count" -gt 0 ]; then
    local sample selected=0
    sample=$(git -C "$repo" ls-files '*.ts' '*.tsx' '*.py' '*.go' '*.rs' '*.rb' '*.java' 2>/dev/null \
      | grep -v -e node_modules -e '\.test\.' -e '_test\.' | head -1)
    if [ -z "$sample" ]; then
      printf '  warn  found no source file to probe selection with\n'
    else
      # `rules brief`, not `rules select`: only brief passes the file's path as
      # query text, so `rules select --file` alone still answers the old,
      # path-only question and would fail a repository that briefs fine.
      selected=$("$CLI" rules brief --file "$repo/$sample" --repo "$repo" 2>/dev/null | wc -c | tr -d ' ')
      selected=${selected:-0}
      if [ "$selected" -gt 1 ]; then
        printf '  ok    briefing answers for %s (%s chars)\n' "$sample" "$selected"
      else
        printf '  FAIL  briefing answers nothing for %s.\n' "$sample"
        printf '        Check the rules parse: %s rules ls\n' "$CLI"
        fail=1
      fi
    fi
  fi

  if git -C "$repo" diff --quiet 2>/dev/null && git -C "$repo" diff --cached --quiet 2>/dev/null; then
    printf '  ok    working tree clean\n'
  else
    printf '  FAIL  working tree dirty -- impl-gate re-checks the same pre-existing\n'
    printf '        conflicts every turn and the session never reaches your prompt\n'; fail=1
  fi

  if command -v "$CLI" >/dev/null 2>&1 && "$CLI" rules brief --help >/dev/null 2>&1; then
    printf '  ok    %s has `rules brief`\n' "$CLI"
  else
    printf '  FAIL  %s is missing or has no `rules brief` subcommand\n' "$CLI"; fail=1
  fi

  if [ "${CLAUDE_CODE_ENABLE_FUNCTION_HOOKS:-}" = "1" ]; then
    printf '  ok    CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 (mods load)\n'
  else
    printf '  warn  CLAUDE_CODE_ENABLE_FUNCTION_HOOKS is unset: on 2.1.285/286 the\n'
    printf '        mod will not load and only the Read hook will brief\n'
  fi

  [ "$fail" -eq 0 ] && printf '\nready\n' || printf '\nnot ready\n'
  return "$fail"
}

# --- transcript helpers ---------------------------------------------------

newest_transcript() {
  local repo="${1:-$PWD}" slug
  repo=$(cd "$repo" && pwd)
  slug=$(printf '%s' "$repo" | sed 's|/|-|g')
  ls -t "${HOME}/.claude/projects/${slug}/"*.jsonl 2>/dev/null | head -1
}

resolve_transcript() {
  local arg="${1:-}"
  if [ -z "$arg" ]; then newest_transcript "$PWD"
  elif [ -f "$arg" ]; then printf '%s' "$arg"
  elif [ -d "$arg" ]; then newest_transcript "$arg"
  else printf ''
  fi
}

# --- replay ---------------------------------------------------------------
#
# Pulls every Bash command out of a transcript and runs the mod's own
# extraction over it, tracking the shell's directory across calls exactly as
# the mod does. Shows what would be briefed without spending a model call, so
# an extractor change can be checked against real commands in a second.
cmd_replay() {
  local t repo
  t=$(resolve_transcript "${1:-}")
  [ -n "$t" ] && [ -f "$t" ] || die "no transcript found (pass a path or a repo)"
  repo=$(python3 - "$t" <<'PY'
import json,sys
for l in open(sys.argv[1]):
    try: d=json.loads(l)
    except Exception: continue
    if d.get("cwd"): print(d["cwd"]); break
PY
)
  [ -n "$repo" ] || die "could not read the repo from $t"
  printf 'transcript: %s\nrepo:       %s\n\n' "$t" "$repo"
  node "${HOOKS_DIR}/tests/replay.mjs" "$t" "$repo" "${HOOKS_DIR}/register.js"
}

# --- analyse --------------------------------------------------------------
cmd_analyse() {
  local t
  t=$(resolve_transcript "${1:-}")
  [ -n "$t" ] && [ -f "$t" ] || die "no transcript found (pass a path or a repo)"
  printf 'transcript: %s\n\n' "$t"
  python3 "${HOOKS_DIR}/tests/analyse.py" "$t"
}

case "${1:-}" in
  doctor) shift; cmd_doctor "$@" ;;
  replay) shift; cmd_replay "$@" ;;
  analyse|analyze) shift; cmd_analyse "$@" ;;
  *) cat >&2 <<'USAGE'
usage: scenario.sh <command> [argument]

  doctor  [repo]              check whether a repo can run a scenario
  replay  [transcript|repo]   re-run the extractor over a session's Bash calls
  analyse [transcript|repo]   what briefing did, and what the gate blocked on

With no argument, replay and analyse use the newest transcript for the current
directory. ACTUAL_CLI overrides which `actual` binary doctor probes.
USAGE
    exit 2 ;;
esac
