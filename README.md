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

Your agent is also briefed as it reads. When it opens a file covered by a rule, the rules governing that file are surfaced before it makes its first edit. Briefing is advisory: it never blocks anything, and it needs a CLI new enough to have `actual rules brief` — if yours isn't, the two checks above still run and the session start tells you so.

Reads through the shell count too, and they are most of them. Measured across 212 local sessions, four in five file reads went through `cat`, `head`, `sed -n` or `grep` rather than the Read tool, and a hook never sees those. A Claude Code mod covers them: it briefs a read-only Bash command the same way the hook briefs a Read, and the two share one record of what has already been said, so reading a file twice does not brief it twice. The mod needs Claude Code 2.1.287 or later; on 2.1.285 and 2.1.286 set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` to load it. Without it the Read path still works on its own.

Briefing is capped so it cannot crowd out your agent's context: 48,000 characters per session by default, which is roughly two and a half times what a 40-file session was measured to use against a 425-rule repository. When the cap is reached your agent is told once, rather than briefing going quietly dead.

You can see briefing happen. Under the tool call that triggered one, a dim line names what arrived — `⊢ actual: briefed 2 ADRs, 8 of 35 rules — tokens.ts` — and when a governed file is read but says nothing, it tells you why instead of leaving you to guess: already briefed this session, budget spent, or the CLI could not answer. Run `/rules-brief` for the same thing across the whole session, including the reads that briefed nothing. None of this costs your agent any context: it is drawn in the terminal and never sent to the model, so it is not counted against the cap above. It needs a terminal or the desktop app — nothing is drawn in `claude -p`, the SDK, the VS Code chat panel or a cloud session, though briefing itself still runs there.

Governance never gets in the way of unrelated work. Outside a repository with `.actual/rules/`, the checks do nothing. If the CLI is missing, outdated, or crashes, you get a message instead of a block. A rule that stays unresolved stops blocking after three denied rounds per session. To clear a denied rule for the rest of the session, run `actual check-override --session <id> --rule <doc-slug>::<rule-id> --reason "..."` from a terminal.

Set `ACTUAL_PLAN_GATE=off` to turn governance off, `ACTUAL_RULES_BRIEF=off` to turn off briefing alone while the checks keep running, or `ACTUAL_RULES_DIR` to use a different rules directory. The briefing limits have their own variables — `ACTUAL_RULES_BRIEF_MAX_SESSION_CHARS` for the per-session cap and `ACTUAL_RULES_BRIEF_LIMIT`, `_RULES_PER_DECISION`, `_MAX_CHARS` and `_MIN_SCORE` for `actual rules brief`'s own limits — and the same settings appear as labelled rows under `/plugin`. `_MIN_SCORE` is worth knowing about if briefing feels noisy: a rule's score reflects how narrowly its `verify` path is written, so the useful floor differs per repository and there is no good default.

The hooks also stay silent inside the `claude` subprocesses `actual` itself spawns (marked with `ACTUAL_CLI_SUBPROCESS=1`), so the judge's own Stop hook can't rerun `impl-check` and recurse. Failures are silent by design, so if you need to see why briefing isn't appearing, set `ACTUAL_HOOK_DEBUG=1` and run `claude --debug`; it reports the rules directory, the CLI's exit status, why a reply was dropped, and how much context briefing has used. Run `bash hooks/tests/run.sh` to test the hooks locally, and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test .` to test the mod; neither needs the network or a CLI install. Governance relies on Claude Code hooks, so it isn't available in Codex, ChatGPT, Cursor, or OpenCode.

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
