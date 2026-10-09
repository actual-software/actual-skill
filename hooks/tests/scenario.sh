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

  if [ "$count" -gt 0 ]; then
    local withpath
    withpath=$(python3 - "$rules" <<'PY'
import glob,re,sys,os
n=0
for f in glob.glob(os.path.join(sys.argv[1],'*.md')):
    m=re.search(r'^### Verify(.*?)(^## |\Z)', open(f).read(), re.S|re.M)
    block=m.group(1) if m else ''
    paths=[p for p in re.findall(r'[\w.][\w./*-]*/[\w./*-]*(?:\*|\.\w{1,5})', block)
           if not p.startswith(('http','npm','//'))]
    if paths: n+=1
print(n)
PY
)
    # A proportion, not a count. One path-bearing document in 155 is
    # indistinguishable from none in practice: observed on more-later, where
    # `rules select` returned 0 decisions for every file sampled.
    local pct=$(( withpath * 100 / count ))
    if [ "$pct" -ge 10 ]; then
      printf '  ok    %s of %s documents (%s%%) name a path or glob in Verify\n' \
        "$withpath" "$count" "$pct"
    else
      printf '  FAIL  only %s of %s documents (%s%%) name a path in Verify, so\n' \
        "$withpath" "$count" "$pct"
      printf '        almost nothing is governed and briefing will not fire.\n'
      printf '        Check with: %s rules select --file <a source file> --no-rank\n' "$CLI"
      fail=1
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
