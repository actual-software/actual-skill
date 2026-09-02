# actual CLI Skill

A feature-complete AI companion for the [actual CLI](https://cli.actual.ai),
an ADR-powered CLAUDE.md/AGENTS.md generator.

## What it does

- Runs and troubleshoots `actual adr-bot` with pre-flight → dry-run → execute → diagnose → retry
- Covers all 5 runners (claude-cli, anthropic-api, openai-api, codex-cli, cursor-cli)
- Covers all 3 output formats (claude-md, agents-md, cursor-rules)
- Includes error catalog, config reference, runner guide, and diagnostic script
- Works as inline knowledge AND operational automation
- Ships Claude Code hooks that check implementation plans against the ADRs
  committed in `.actual/rules/` before implementation begins

## Install

### Claude Code (recommended)

```bash
# Add this repo as a marketplace
/plugin marketplace add actual-software/actual-skill

# Install the plugin
/plugin install actual-cli@actual-cli-skills
```

### Codex (OpenAI) — current skill install

```
$skill-installer install the actual skill from actual-software/actual-skill
```

### ChatGPT and Codex plugin

This repository also contains a universal plugin manifest at
`.codex-plugin/plugin.json`. During local testing, package the repository root
as the `actual-cli` plugin and install it from a local marketplace. After public
review and publication, install **Actual CLI** from the universal Plugins
Directory shared by ChatGPT and Codex.

### OpenCode / Cursor / Manual

Clone and symlink to your global skills directory:

```bash
git clone https://github.com/actual-software/actual-skill.git ~/.local/share/actual-skill

# For OpenCode
ln -s ~/.local/share/actual-skill/skills/actual ~/.config/opencode/skills/actual

# For Cursor
ln -s ~/.local/share/actual-skill/skills/actual ~/.cursor/skills/actual

# For Claude Code (alternative to marketplace)
ln -s ~/.local/share/actual-skill/skills/actual ~/.claude/skills/actual

# For Codex (alternative to $skill-installer)
ln -s ~/.local/share/actual-skill/skills/actual ~/.agents/skills/actual
```

## Plan-stage governance (Claude Code)

Installing the plugin registers two hooks, with no further setup:

- **`SessionStart`** (`startup`, `resume`, `clear`, `compact`, `fork`) — checks
  that the `actual` CLI is installed and new enough, and says how to fix it if
  not. Compact re-injects the reminder after summarization.
- **`PreToolUse` on `ExitPlanMode`** — the plan/implementation boundary. The plan is
  checked against the ADR rules committed in `.actual/rules/`, and a conflicting plan
  is blocked before it reaches the approval dialog. Verified on Claude Code 2.1.231;
  the ordering is observed behavior rather than a documented contract, so it is worth
  re-checking on a materially newer release.

Both hooks are **silent no-ops in any repository without `.actual/rules/`**, so
installing the plugin does not affect unrelated work. They also never hard-fail: a
missing, outdated, or crashing CLI produces a message and no permission decision.
A conforming plan also makes no permission decision, so the user's approval dialog
still appears. Only an explicit deny from `plan-check` can block.

In a git worktree the rules enforced are the active worktree's, on its own branch:
`CLAUDE_PROJECT_DIR` stays on the original checkout there, so the hooks fall back to
the git toplevel of the working directory whenever it lies outside that project root.

Set `ACTUAL_PLAN_GATE=off` to disable them, or `ACTUAL_RULES_DIR` to point them at a
different rules directory (forwarded to the CLI as `--rules-dir`). Run
`bash hooks/tests/run.sh` to exercise the hooks locally — no network or CLI
install needed.

Hooks are a Claude Code feature; the Codex/universal manifest
(`.codex-plugin/plugin.json`) has no equivalent, so it deliberately declares none.

## Documentation

- [Getting started and full command reference](https://actual.ai/cli/docs) - human-readable docs
- [docs.md](https://actual.ai/cli/docs.md) - full docs in Markdown (machine-readable)
- [Developer resources](https://actual.ai/developers) - OpenAPI spec, npm package, auth, and service status
- [llms.txt](https://actual.ai/cli/llms.txt) - concise LLM-friendly summary

## Requirements

- The [actual CLI](https://cli.actual.ai) installed
  (`npm install -g @actualai/actual` or `brew install actual-software/actual/actual`)
- At least one runner configured (see `actual runners`)

## License

Apache-2.0
