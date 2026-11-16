# Install the Actual.ai Skill

## Claude Code plugin

The plugin brings the plan and change checks, rule briefing and in-session overrides, along with the `actual` skill. Run each step as its own copy/paste.

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

## Skill only

These install the `actual` skill without the checks, briefing or overrides, which need the Claude Code plugin's hooks.

### skills.sh (any agent)

```bash
npx skills add actual-software/actual-skill
```

This installs the `actual` skill into the agents you pick.

### Codex

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

### OpenCode, Cursor or manual

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

## Keep Actual.ai Skill up to date — Claude Code CLI

Claude Code updates the plugin for you once auto-update is on for the `actual-cli-skills` marketplace. It's off by default for a third-party marketplace like this one, so turn it on once: run `/plugin`, open the **Marketplaces** tab, select `actual-cli-skills`, and choose **Enable auto-update**.

The same switch in a settings file is `"autoUpdate": true` on the marketplace's `extraKnownMarketplaces` entry. In `~/.claude/settings.json`, add that line to the `actual-cli-skills` entry if one is already there, or add the whole entry:

```json
{
  "extraKnownMarketplaces": {
    "actual-cli-skills": {
      "source": { "source": "github", "repo": "actual-software/actual-skill" },
      "autoUpdate": true
    }
  }
}
```

Re-adding the marketplace with `claude plugin marketplace add` rewrites this entry without the `autoUpdate` line, so add the line back if you do.

An organization can put the same entry in its [managed settings](https://code.claude.com/docs/en/plugins/org#set-update-policy) to turn auto-update on for everyone, and setting `autoUpdate` there locks the toggle in `/plugin`.

With auto-update on, Claude Code checks for a new version in the background, up to ten minutes after the first message of each interactive session. The new version loads in your next session, or straight away if you run `/reload-plugins` when Claude Code tells you the plugin was updated. Setting `DISABLE_AUTOUPDATER`, `DISABLE_UPDATES` or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turns these background updates off unless `FORCE_AUTOUPDATE_PLUGINS=1` is set as well.

To update by hand, refresh the marketplace, then update the plugin:

```
claude plugin marketplace update actual-cli-skills
claude plugin update actual-cli@actual-cli-skills
```

Then restart Claude Code, or run `/reload-plugins` in a session that's already open. If `claude plugin update` reports that the plugin is already at the latest version, there's no newer release yet.

## Requirements

- Claude Code, for the checks, briefing and overrides. The skill alone also runs in Codex, ChatGPT, Cursor and OpenCode.
- Architecture rules in `.actual/rules/`, written by hand or merged from the sync pull request [app.actual.ai](https://app.actual.ai) opens. The plugin stays silent in a repository without them.
- The `actual` CLI 0.8.0 or later ([actual-software/actual-cli](https://github.com/actual-software/actual-cli)). The skill offers to install it on first use, or you can install it yourself with `npm install -g @actualai/actual` or `brew install actual-software/actual/actual`. In Claude Code, each session start in a repository with rules compares the installed version with the one the skill needs and offers to upgrade an older CLI, with the command for however you installed it when the CLI can name it, or both commands when it's too old to. A declined offer doesn't come back as an interruption after a compaction or a resume.
  - Rule files with a YAML header need `actual` 0.9.0 or later. Upgrade with `npm install -g @actualai/actual@latest` or `brew upgrade actual-software/actual/actual`. Check with `actual rules brief --help`, which names `adr-header-v2` on a CLI that reads them.
