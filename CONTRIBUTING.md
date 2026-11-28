# Contributing

## Bump the plugin version in every user-facing pull request

The plugin ships to two agents, Claude Code and Codex, and each updates an installed copy only when the manifest's `version` changes. Claude Code compares `version` in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) with the installed copy, for auto-update and for `claude plugin update`. Codex reads [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json) and installs each version into a cache folder of its own, `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, so it keeps running the old folder until the version moves. A change merged without a new version reaches people who install afterwards, and nobody who already has the plugin gets it until a later pull request raises the version. Merging to `main` is the release.

The hook scripts are shared, so the two manifests carry one version, and a pull request raises both together. The marketplace installs the whole repository, so a pull request that changes any file raises the version in the same pull request, except one that changes only these paths, which no session reads:

- `docs/`, `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md` and `LICENSE`
- `.github/` and `.actual/`
- the tests under `hooks/`: `hooks/tests/` and the `*.test.ts` files
- `tsconfig.json`

The **Plugin version** check enforces this on every pull request to `main`. When the pull request changes a path outside this list, the check fails unless `version` in `.claude-plugin/plugin.json` is above the one on `main`, compared as numbers (1.10.0 is above 1.9.9), and `.codex-plugin/plugin.json` carries the same number (the hook harness checks that too). The list lives in `is_shipped` in [`.github/scripts/check-version-bump.sh`](.github/scripts/check-version-bump.sh); change both together.

A pull request that raises the version needs an approving review from a teammate, because [`.github/CODEOWNERS`](.github/CODEOWNERS) owns `.claude-plugin/` and `.codex-plugin/`. A pull request that leaves them alone can merge without one.

### Every Codex release asks users to trust the hooks again

Codex runs a plugin's hooks only once the user has trusted them in `/hooks`, and the trust it records covers the plugin's whole content. After an update every hook shows as modified and stays off until the user reviews it again, whatever the release changed. So a release costs Codex users a review: group small changes into one release rather than shipping each on its own, and say in the release notes when hooks changed.

### Choosing the number

Raise the minor number for something new, such as a hook, a mod feature or a skill capability; 1.3.0 added the implementation gate. A fix, or a change to something that already exists, raises the patch number, the way 1.4.1 stopped `turn-start.sh` running on a CLI too old for it. Bump in a commit of its own on top of the change, `chore(release): bump plugin version to X.Y.Z`, so the history shows where each release starts.

### Check the number again before you merge

Two pull requests that raise the version to the same number merge without a conflict, because git sees the same edit on both sides. The second to merge ships under a version people may already have. Anyone who updated between the two merges doesn't get it until the version moves again. The Plugin version check reads `main` each time it runs, but a check that passed before the other pull request merged stays green. So before you merge, update your branch from `main` or re-run the check, and raise the version again if it fails.

## Record each user-facing change in CHANGELOG.md

[CHANGELOG.md](CHANGELOG.md) uses the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format, as actual-cli's does. Each pull request that the [documentation ADR](docs/adr/dd50a7e0-9a6a-4e55-abdf-8dd77dfba656-update-docs-actual-ai-with-every-user-facing-plugin-change.md) covers adds a line under `## [Unreleased]`, in an `Added`, `Changed` or `Fixed` group. The line says what changed for someone using the plugin and links the docs.actual.ai page that its docs pull request updates:

```markdown
### Changed
- <What changed, for someone using the plugin>. See [<Page title>](https://docs.actual.ai/plugin/<page>)
```

A change that needs a newer Actual CLI names that minimum version in the same line.

Merging to `main` is the release, so the commit that bumps the version also moves the lines under `## [Unreleased]` to a heading for the new version, `## [X.Y.Z] - YYYY-MM-DD`, dated the day it merges. When you raise the number again before merging, change the heading with it.
