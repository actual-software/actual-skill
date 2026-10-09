<h1 align="center">Actual.ai CLI Skill</h1>

<p align="center">
  <a href="https://app.actual.ai">
    <img src="assets/logo.png" alt="Actual.ai" width="160">
  </a>
</p>

<p align="center"><strong>Keep AI coding agents aligned with your architecture.</strong></p>

<p align="center">
  <a href="https://github.com/actual-software/actual-skill/blob/main/LICENSE"><img src="https://img.shields.io/github/license/actual-software/actual-skill" alt="License"></a>
  <a href="https://github.com/actual-software/actual-skill/stargazers"><img src="https://img.shields.io/github/stars/actual-software/actual-skill?style=flat" alt="Stars"></a>
  <a href="https://github.com/actual-software/actual-skill/issues"><img src="https://img.shields.io/github/issues/actual-software/actual-skill" alt="Issues"></a>
</p>

## Quickstart

### Install Actual.ai Skill — Claude Code CLI

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

<details>
<summary><strong>Install Actual.ai Skill — Codex</strong></summary>

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
</details>

<details>
<summary><strong>Install Actual.ai Skill — OpenCode / Cursor / Manual</strong></summary>

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

</details>

## Use Actual.ai Skill

Once installed, ask your agent in plain language. For example:

- "Set up Actual for this repository."
- "Preview the ADR guidance Actual would add here."
- "Ask the Actual advisor how we should handle database access in a new service."
- "Sign me in to Actual AI."
- "Diagnose why Actual is failing."

In Codex, you can also call the skill directly by starting the prompt with `$actual`.

## What is the Actual.ai Skill?

The Actual.ai Skill gives your AI coding agents architectural guardrails, keeping every plan and change grounded in the ADRs your team has already written.

## Why do I need the Actual.ai Skill?

Coding agents don't know the architecture decisions your team has already made, so they write code that ignores them. The skill gives your agent your team's ADRs as context, so its code follows your architecture from the start.

## Who is the Actual.ai Skill for?

AI-native software teams: developers who build with coding agents and want those agents to follow the architecture decisions their team has already made.

## Where does the Actual.ai Skill work?

Inside the coding agent your team already uses: Claude Code, Codex, ChatGPT, Cursor, or OpenCode. It works in any repository with architecture rules committed in `.actual/rules/`, and stays silent in repositories without them.

## When does the Actual.ai Skill run?

Whenever an architecture question comes up. Before your agent writes code, it asks your ADRs how your team builds things and gets an answer that cites its sources. In Claude Code, the skill also checks the plan before implementation starts and the changes at the end of every turn.

## How does the Actual.ai Skill work?

### ADR-backed context

The skill runs `actual adr-bot`, which reads your repository, fetches your team's ADRs from Actual AI, and writes guidance tailored to your codebase into the file your agent reads: `CLAUDE.md`, `AGENTS.md`, or Cursor rules. Your agent starts every session already knowing how your team builds things.

### Architecture answers

When your agent hits an architecture question, the skill asks the Actual advisor. The advisor answers from your organization's ADRs and cites its sources, so you can trace every recommendation back to a decision your team made.

### Governance

In Claude Code, the skill checks your agent's work against the architecture rules committed in `.actual/rules/`. When your agent leaves plan mode, its plan is checked before you see the approval dialog. At the end of every turn, its changes are checked too. A conflict goes back to the agent with the reason, and the turn continues until it's fixed.

Governance never gets in the way of unrelated work. Outside a repository with `.actual/rules/`, the checks do nothing. If the CLI is missing, outdated, or crashes, you get a message instead of a block. A rule that stays unresolved stops blocking after three denied rounds per session. To clear a denied rule for the rest of the session, run `actual check-override --session <id> --rule <doc-slug>::<rule-id> --reason "..."` from a terminal.

Set `ACTUAL_PLAN_GATE=off` to turn governance off, or `ACTUAL_RULES_DIR` to use a different rules directory. The hooks also stay silent inside the `claude` subprocesses `actual` itself spawns (marked with `ACTUAL_CLI_SUBPROCESS=1`), so the judge's own Stop hook can't rerun `impl-check` and recurse. Run `bash hooks/tests/run.sh` to test the hooks locally; it needs no network or CLI install. Governance relies on Claude Code hooks, so it isn't available in Codex, ChatGPT, Cursor, or OpenCode.

### Session summary

In Claude Code, a status line shows how many of your repository's ADRs have been added to your agent's context this session: `Actual AI: 3 of 12 ADRs added to context`. It reads `0 of 12` from the start of the session and updates after each of your agent's replies, in the background, so no reply waits on it. In the terminal it sits under the prompt as `⚠ actual-cli: Actual AI: …`; the ⚠ is how Claude Code marks a plugin's status line, not a warning.

It counts against the same rules directory as the checks, `ACTUAL_RULES_DIR` included, and shows nothing outside a repository with `.actual/rules/`, when the rules hold no decision, or when the CLI is missing or predates `actual session summary`. `ACTUAL_PLAN_GATE=off` leaves it on. The line is a Claude Code mod, `hooks/session-summary.ts`, so it needs Claude Code 2.1.287 or later; older releases run the checks as before and skip the line. Run `claude plugin test .` to test it.

### Troubleshooting

When something fails, the skill diagnoses it for you. It knows every error the CLI can return, all five runners (`claude-cli`, `anthropic-api`, `openai-api`, `codex-cli`, `cursor-cli`), and all three output formats, so it can find the cause and retry without you reading logs.

### Documentation

See the [Actual CLI docs](https://actual.ai/cli/docs) for getting started and the full command reference. Point your agent at [docs.md](https://actual.ai/cli/docs.md) for the same docs in Markdown.

### Requirements

- A supported coding agent: Claude Code, Codex, ChatGPT, Cursor, or OpenCode.
- Your repository onboarded at [app.actual.ai](https://app.actual.ai), so Actual can generate its ADRs.
- The `actual` CLI ([actual-software/actual-cli](https://github.com/actual-software/actual-cli)). The skill offers to install it on first use, or you can install it yourself with `npm install -g @actualai/actual` or `brew install actual-software/actual/actual`.

## License

Apache-2.0
