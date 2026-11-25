#!/usr/bin/env bash
# check-version-bump.sh - fail a pull request that changes shipped plugin files without
# raising the plugin version above main's.
#
# Claude Code and Codex update an installed plugin only when `version` in its manifest
# changes, so a shipped change merged without a higher version reaches nobody who already
# has the plugin. See CONTRIBUTING.md.
#
# Run from a checkout of the pull request's head with history (fetch-depth: 0). Fetches
# main each run, so a re-run compares against main as it is then, not as it was when the
# pull request was opened.
#
# Usage: bash .github/scripts/check-version-bump.sh

set -euo pipefail

MANIFEST=.claude-plugin/plugin.json
CODEX_MANIFEST=.codex-plugin/plugin.json

# The marketplace installs the whole repository, so every path ships except the ones no
# session reads. Keep in step with CONTRIBUTING.md.
is_shipped() {
  case "$1" in
    docs/* | .github/* | .actual/* | hooks/tests/* | hooks/*.test.ts) return 1 ;;
    README.md | CONTRIBUTING.md | CHANGELOG.md | LICENSE | tsconfig.json) return 1 ;;
  esac
  return 0
}

# Fetch main now rather than trusting the event's base SHA or a stale local ref.
git fetch --quiet --no-tags origin main
main_ref=FETCH_HEAD
base=$(git merge-base "$main_ref" HEAD)

shipped=()
# NUL-separated, so git doesn't quote names with non-ASCII characters out of their pattern.
while IFS= read -r -d '' path; do
  if is_shipped "$path"; then shipped+=("$path"); fi
done < <(git diff -z --name-only --no-renames "$base" HEAD)

if [ "${#shipped[@]}" -eq 0 ]; then
  echo "No shipped plugin files changed, so the version doesn't need to change."
  exit 0
fi

main_version=$(git show "$main_ref:$MANIFEST" | jq -r '.version')
pr_version=$(jq -r '.version' "$MANIFEST")
codex_version=$(jq -r '.version' "$CODEX_MANIFEST")

semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
if ! [[ $main_version =~ $semver ]]; then
  echo "::error::main's version \"$main_version\" isn't three numbers, such as 1.14.0. Fix it on main first."
  exit 1
fi
if ! [[ $pr_version =~ $semver ]]; then
  echo "::error file=$MANIFEST::Set version to three numbers above main's $main_version, such as 1.14.0 (it is \"$pr_version\")."
  exit 1
fi

# Succeeds when $1 > $2, compared as MAJOR.MINOR.PATCH numbers.
newer() {
  local IFS=.
  local -a a b
  read -r -a a <<<"$1"
  read -r -a b <<<"$2"
  for i in 0 1 2; do
    if ((a[i] > b[i])); then return 0; fi
    if ((a[i] < b[i])); then return 1; fi
  done
  return 1
}

echo "This pull request changes files that ship to plugin users:"
printf '  %s\n' "${shipped[@]}"
echo "main's version: $main_version. This pull request's version: $pr_version."

if ! newer "$pr_version" "$main_version"; then
  echo "::error file=$MANIFEST::Raise version above main's $main_version (it is $pr_version) in .claude-plugin/plugin.json and .codex-plugin/plugin.json, or users who already have the plugin won't get this change. See CONTRIBUTING.md."
  exit 1
fi

if [ "$codex_version" != "$pr_version" ]; then
  echo "::error file=$CODEX_MANIFEST::Set version to $pr_version here too (it is $codex_version), or Codex users won't get this change."
  exit 1
fi

echo "The version is above main's, so installed copies will update."
