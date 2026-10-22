# Contributing

## Bump the plugin version in every user-facing pull request

Claude Code updates an installed plugin only when `version` in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json) changes. Auto-update and `claude plugin update` both compare that string with the installed copy, so a change merged without a new version reaches people who install afterwards, and nobody who already has the plugin gets it until a later pull request raises the version. Merging to `main` is the release.

So a pull request that changes anything under these paths also raises `version`, in the same pull request:

- `hooks/`, including `hooks/lib/`, `hooks/hooks.json` and the mod, `hooks/register.js`
- `skills/`
- `.claude-plugin/`

When the plugin gains another component Claude Code loads, such as a `commands/` directory or a `.mcp.json`, add its path to this list.

Everything else can merge without a bump, because none of it changes what runs in a Claude Code session. That covers the tests that sit under `hooks/` (`hooks/tests/` and the `*.test.ts` files), the docs, and the Codex manifest, `.codex-plugin/plugin.json`, which keeps a version of its own.

### Choosing the number

Raise the minor number for something new, such as a hook, a mod feature or a skill capability; 1.3.0 added the implementation gate. A fix, or a change to something that already exists, raises the patch number, the way 1.4.1 stopped `turn-start.sh` running on a CLI too old for it. Bump in a commit of its own on top of the change, `chore(release): bump plugin version to X.Y.Z`, so the history shows where each release starts.

### Check the number again before you merge

Two pull requests that raise the version to the same number merge without a conflict, because git sees the same edit on both sides. The second to merge ships under a version people may already have. Anyone who updated between the two merges doesn't get it until the version moves again. So before you merge, compare your `version` with the one on `main`, and raise it again if `main` already has it.
