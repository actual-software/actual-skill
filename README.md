# actual CLI Skill

A feature-complete AI companion for the [actual CLI](https://cli.actual.ai),
an ADR-powered CLAUDE.md/AGENTS.md generator.

## What it does

- Runs and troubleshoots `actual adr-bot` with pre-flight → dry-run → execute → diagnose → retry
- Covers all 5 runners (claude-cli, anthropic-api, openai-api, codex-cli, cursor-cli)
- Covers all 3 output formats (claude-md, agents-md, cursor-rules)
- Includes error catalog, config reference, runner guide, and diagnostic script
- Works as inline knowledge AND operational automation

## Install

### Claude Code (recommended)

```bash
# Add this repo as a marketplace
/plugin marketplace add actual-software/actual-skill

# Install the plugin
/plugin install actual-cli@actual-cli-skills
```

### Codex (OpenAI)

```
$skill-installer install the actual skill from actual-software/actual-skill
```

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

## Requirements

- The [actual CLI](https://cli.actual.ai) installed
  (`npm install -g @actualai/actual` or `brew install actual-software/actual/actual`)
- At least one runner configured (see `actual runners`)

## License

Apache-2.0
