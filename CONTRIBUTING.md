# Contributing

## Bump the plugin version in every user-facing pull request

The plugin ships to two agents, Claude Code and Codex, and each updates an installed copy only when the manifest's `version` changes. Claude Code compares `version` in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) with the installed copy, for auto-update and for `claude plugin update`. Codex reads [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json) and installs each version into a cache folder of its own, `~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/`, so it keeps running the old folder until the version moves. A change merged without a new version reaches people who install afterwards, and nobody who already has the plugin gets it until a later pull request raises the version. Merging to `main` is the release.

The hook scripts are shared, so the two manifests carry one version, and a pull request raises both together; the hook harness fails when they differ. A pull request that changes anything under these paths raises it, in the same pull request:

- `hooks/`, including `hooks/lib/`, `hooks/hooks.json`, `hooks/codex-hooks.json` and the mod, `hooks/register.js`
- `skills/`
- `.claude-plugin/`
- `.codex-plugin/`

When the plugin gains another component either agent loads, such as a `commands/` directory or a `.mcp.json`, add its path to this list.

Everything else can merge without a bump, because none of it changes what runs in a session. That covers the tests that sit under `hooks/` (`hooks/tests/` and the `*.test.ts` files) and the docs.

### Every Codex release asks users to trust the hooks again

Codex runs a plugin's hooks only once the user has trusted them in `/hooks`, and the trust it records covers the plugin's whole content. After an update every hook shows as modified and stays off until the user reviews it again, whatever the release changed. So a release costs Codex users a review: group small changes into one release rather than shipping each on its own, and say in the release notes when hooks changed.

### Choosing the number

Raise the minor number for something new, such as a hook, a mod feature or a skill capability; 1.3.0 added the implementation gate. A fix, or a change to something that already exists, raises the patch number, the way 1.4.1 stopped `turn-start.sh` running on a CLI too old for it. Bump in a commit of its own on top of the change, `chore(release): bump plugin version to X.Y.Z`, so the history shows where each release starts.

### Check the number again before you merge

Two pull requests that raise the version to the same number merge without a conflict, because git sees the same edit on both sides. The second to merge ships under a version people may already have. Anyone who updated between the two merges doesn't get it until the version moves again. So before you merge, compare your `version` with the one on `main`, and raise it again if `main` already has it.
