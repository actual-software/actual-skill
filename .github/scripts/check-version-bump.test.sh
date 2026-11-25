#!/usr/bin/env bash
# check-version-bump.test.sh - cases for check-version-bump.sh, run against a throwaway
# origin and clone so no network is needed. A wrong edit to the exempt-path list or the
# version comparison would let the check pass pull requests it should fail, and nothing
# else would notice.
#
# Usage: bash .github/scripts/check-version-bump.test.sh

set -uo pipefail

SCRIPT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/check-version-bump.sh"
W=$(mktemp -d "${TMPDIR:-/tmp}/version-check-tests.XXXXXX") || exit 1
trap 'rm -rf "$W"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
pass_count=0
fail_count=0

set_version() { # <dir> <version>
  for m in .claude-plugin/plugin.json .codex-plugin/plugin.json; do
    jq --arg v "$2" '.version = $v' "$1/$m" >"$1/$m.tmp" && mv "$1/$m.tmp" "$1/$m"
  done
}
commit() { git -C "$1" add -A && git -C "$1" commit -qm change; }

# An origin whose main is at version $1, and a clone of it in $W/pr on a branch.
fresh() {
  rm -rf "$W/origin.git" "$W/main" "$W/pr"
  git init -q --bare -b main "$W/origin.git"
  git init -q -b main "$W/main"
  mkdir -p "$W/main"/{.claude-plugin,.codex-plugin,skills/actual,hooks/tests,docs}
  echo '{"name": "actual-cli", "version": "0"}' >"$W/main/.claude-plugin/plugin.json"
  cp "$W/main/.claude-plugin/plugin.json" "$W/main/.codex-plugin/plugin.json"
  for f in skills/actual/SKILL.md hooks/preflight.sh hooks/tests/run.sh hooks/register.test.ts docs/install.md; do
    echo "$f" >"$W/main/$f"
  done
  set_version "$W/main" "$1"
  commit "$W/main"
  git -C "$W/main" push -q "$W/origin.git" main
  git clone -q "$W/origin.git" "$W/pr"
  git -C "$W/pr" checkout -q -b pr
}

expect() { # <case> <exit code> <text the output contains>
  local out code
  out=$(cd "$W/pr" && bash "$SCRIPT" 2>&1)
  code=$?
  if [ "$code" = "$2" ] && grep -qF -- "$3" <<<"$out"; then
    printf '  [PASS] %s\n' "$1"
    pass_count=$((pass_count + 1))
  else
    printf '  [FAIL] %s\n         wanted exit %s and %s, got exit %s:\n' "$1" "$2" "$3" "$code"
    printf '%s\n' "$out" | sed 's/^/         /'
    fail_count=$((fail_count + 1))
  fi
}

fresh 1.13.2
echo more >>"$W/pr/docs/install.md"
echo more >>"$W/pr/hooks/tests/run.sh"
echo more >>"$W/pr/hooks/register.test.ts"
echo more >>"$W/pr/README.md"
mkdir -p "$W/pr/.github/workflows" && echo ci >"$W/pr/.github/workflows/x.yml"
commit "$W/pr"
expect "docs, tests and CI only: passes without a bump" 0 "No shipped plugin files changed"

fresh 1.13.2
mkdir -p "$W/pr/scripts" && echo s >"$W/pr/scripts/helper.sh"
commit "$W/pr"
expect "a new top-level path counts as shipped: fails" 1 "scripts/helper.sh"

fresh 1.13.2
echo more >>"$W/pr/skills/actual/SKILL.md"
jq '.version = "1.13.3"' "$W/pr/.claude-plugin/plugin.json" >"$W/pr/x" && mv "$W/pr/x" "$W/pr/.claude-plugin/plugin.json"
commit "$W/pr"
expect "Codex manifest left behind: fails" 1 "Set version to 1.13.3 here too (it is 1.13.2)"

fresh 1.13.2
echo more >>"$W/pr/skills/actual/SKILL.md"
commit "$W/pr"
expect "shipped change at main's version: fails naming both" 1 "main's version: 1.13.2. This pull request's version: 1.13.2."

fresh 1.13.2
mkdir -p "$W/pr/agents" && echo a >"$W/pr/agents/openai.yaml"
set_version "$W/pr" 1.8.1
commit "$W/pr"
expect "agents/ change below main's version: fails" 1 "Raise version above main's 1.13.2 (it is 1.8.1)"

fresh 1.9.9
echo more >>"$W/pr/hooks/preflight.sh"
set_version "$W/pr" 1.10.0
commit "$W/pr"
expect "1.9.9 to 1.10.0 compares as numbers: passes" 0 "above main's"

fresh 1.10.0
echo more >>"$W/pr/hooks/preflight.sh"
set_version "$W/pr" 1.9.9
commit "$W/pr"
expect "1.10.0 to 1.9.9 compares as numbers: fails" 1 "it is 1.9.9"

fresh 1.13.2
git -C "$W/pr" mv skills/actual/SKILL.md docs/moved.md
commit "$W/pr"
expect "moving a file out of skills/: counts as shipped" 1 "skills/actual/SKILL.md"

fresh 1.13.2
echo more >>"$W/pr/skills/actual/SKILL.md"
set_version "$W/pr" 1.13.3
commit "$W/pr"
expect "raised above main's: passes" 0 "above main's"
echo more >>"$W/main/hooks/preflight.sh"
set_version "$W/main" 1.13.3
commit "$W/main"
git -C "$W/main" push -q "$W/origin.git" main
expect "re-run after main reaches the same version: fails" 1 "main's version: 1.13.3. This pull request's version: 1.13.3."

fresh 1.13.2
echo more >>"$W/pr/docs/install.md"
commit "$W/pr"
echo more >>"$W/main/hooks/preflight.sh"
commit "$W/main"
git -C "$W/main" push -q "$W/origin.git" main
expect "main's own shipped changes don't count against the pull request" 0 "No shipped plugin files changed"

printf '%s passed, %s failed\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ]
