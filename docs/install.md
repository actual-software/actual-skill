# Install the Actual.ai Skill

## skills.sh (any agent)

```bash
npx skills add actual-software/actual-skill
```

This installs the `actual` skill into the agents you pick. It doesn't add the Claude Code hooks; install the plugin below for those.

## Claude Code

Run each step as its own copy/paste.

Step 1 — add this repo as a marketplace:

```
/plugin marketplace add actual-software/actual-skill
```

Step 2 — install the plugin:

```
/plugin install actual-cli@actual-cli-skills
```

Step 3 — reload plugins so Claude Code CLI loads the newly installed plugin:

```
/reload-plugins
```

Step 4 — run the skill in your coding agent:

```
/actual
```

The first time you run it, the skill asks for your permission to install the Actual.ai CLI for you. For example:

```
/actual

The `actual` CLI is not installed. Should I install it with:

    npm install -g @actualai/actual

Then I'll verify it with `actual --version`.
```

## Codex

```
$skill-installer install the actual skill from actual-software/actual-skill
```

On first use, the actual skill will offer to install the `actual` CLI if it is not already on your `PATH`. For example:

```
$actual

The `actual` CLI is still not installed. Should I install it with:

    npm install -g @actualai/actual

Then I'll verify it with `actual --version`.
```

In Codex, you can also call the skill directly by starting the prompt with `$actual`.

## OpenCode, Cursor or manual

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

- A supported coding agent: Claude Code, Codex, ChatGPT, Cursor, or OpenCode.
- Your repository onboarded at [app.actual.ai](https://app.actual.ai), so Actual can generate its ADRs.
- The `actual` CLI ([actual-software/actual-cli](https://github.com/actual-software/actual-cli)). The skill offers to install it on first use, or you can install it yourself with `npm install -g @actualai/actual` or `brew install actual-software/actual/actual`.
