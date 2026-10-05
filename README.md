<h1 align="center">Actual.ai CLI Skill</h1>

<p align="center">
  <a href="https://app.actual.ai">
    <img src="assets/logo.png" alt="Actual.ai" width="160">
  </a>
</p>

<p align="center"><strong>Keep AI coding agents aligned with your architecture.</strong></p>

<p align="center">
  <a href="https://github.com/actual-software/actual-skill/blob/main/LICENSE"><img src="https://img.shields.io/github/license/actual-software/actual-skill" alt="License"></a>
  <a href="https://github.com/actual-software/actual-skill/releases"><img src="https://img.shields.io/github/v/release/actual-software/actual-skill" alt="Release"></a>
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

### Install Actual.ai Skill — Codex

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

## What is the Actual.ai Skill?

The Actual.ai Skill gives your AI coding agents architectural guardrails, keeping every plan and change grounded in the ADRs your team has already written.

## Why do I need the Actual.ai Skill?

AI coding agents write fast, but they write blind: they don't know the architectural decisions your team has already made, so they drift from established patterns and the changes they produce slip through without ever being checked against those decisions. The Actual.ai Skill closes that gap. It gives your agent ADR-backed context before it writes a line, and architecture-aware checks on the plan it proposes and the diff it produces — so every change stays consistent with the decisions your team has committed to, instead of quietly eroding them.

## Who is the Actual.ai Skill for?

The Actual.ai Skill is for AI-native software teams — the engineers shipping with coding agents every day, and the leaders accountable for the code those agents produce. If your codebase carries architectural decisions worth protecting and agents are now writing a real share of it, the skill keeps that work consistent with the decisions you've already made, so quality and architectural intent hold even as agent-authored code scales. It meets your team in whatever agent they already use — Claude Code, Codex, ChatGPT, Cursor, or OpenCode.

## Where does the Actual.ai Skill work?

Right in the terminal — on your machine, in CI anywhere Node runs, and inside the coding agents your team already uses. Sign in once and org-scoped architecture answers are available from anywhere, grounded in your own ADRs with every answer citing its sources. In a repository without committed decisions it stays silent and never touches unrelated work.

Full documentation lives online: the [getting started guide and command reference](https://app.actual.ai/cli/docs) for humans, the machine-readable [docs.md](https://app.actual.ai/cli/docs.md), the [developer resources](https://app.actual.ai/developers) (OpenAPI spec, npm package, auth, and service status), and a concise [llms.txt](https://app.actual.ai/cli/llms.txt) summary for LLMs.

## When does the Actual.ai Skill run?

In Claude Code, the Actual.ai CLI Skill acts at three points in a session, with its hooks registered on install and no further setup. At **session start** (`SessionStart`: `startup`, `resume`, `clear`, `compact`, `fork`) it checks that the `actual` CLI is installed and new enough and says how to fix it if not, re-injecting the reminder after a compact. When you **leave plan mode** (`PreToolUse` on `ExitPlanMode`) — the plan/implementation boundary — it checks the plan against the ADR rules committed in `.actual/rules/` and blocks a conflicting plan before it reaches the approval dialog; this was verified on Claude Code 2.1.231, and because the ordering is observed behavior rather than a documented contract it is worth re-checking on a materially newer release. And at the **end of every turn** (`Stop`) it checks the turn's working-tree diff — tracked changes vs `HEAD`, plus untracked, non-ignored files — with `actual impl-check`, sending the reason back to Claude on a conflict and keeping the turn going until it is fixed; because this fires every turn whether or not the session went through plan mode, work that skipped the plan gate is still governed.

A rule that stays unresolved stops blocking after three denied rounds per session (`ACTUAL_PLAN_CHECK_MAX_ROUNDS` / `ACTUAL_IMPL_CHECK_MAX_ROUNDS`; the two budgets are independent).

## How do I install and use the Actual.ai Skill?

### Install Actual.ai Skill — ChatGPT and Codex plugin

This repository also contains a universal plugin manifest at `.codex-plugin/plugin.json`. During local testing, package the repository root as the `actual-cli` plugin and install it from a local marketplace. After public review and publication, install **Actual CLI** from the universal Plugins Directory shared by ChatGPT and Codex.

### How governance behaves

The hooks never hard-fail: a missing, outdated, or crashing CLI produces a message and no decision. A conforming plan makes no permission decision, so the user's approval dialog still appears, and a conforming diff lets the turn end normally. Only an explicit deny from `plan-check` or `impl-check` can block.

A human can clear a denied rule for the session from an ordinary terminal with `actual check-override --session <id> --rule <doc-slug>::<rule-id> --reason "..."`; one override covers both hooks.

Set `ACTUAL_PLAN_GATE=off` to disable all of them, or `ACTUAL_RULES_DIR` to point them at a different rules directory (forwarded to the CLI as `--rules-dir`). Run `bash hooks/tests/run.sh` to exercise the hooks locally — no network or CLI install needed.

Hooks are a Claude Code feature; the Codex/universal manifest (`.codex-plugin/plugin.json`) has no equivalent, so it deliberately declares none.

### Requirements

The Actual.ai CLI Skill needs the [actual CLI](https://cli.actual.ai) installed (`npm install -g @actualai/actual` or `brew install actual-software/actual/actual`) and at least one runner configured (see `actual runners`).

## License

Apache-2.0
