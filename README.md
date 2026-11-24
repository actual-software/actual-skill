<p align="center">
  <a href="https://actual.ai/developers">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logo-white-text.png">
      <img src="assets/logo-black-text.png" alt="Actual AI" width="240">
    </picture>
  </a>
</p>

<h1 align="center">Architectural context for coding agents</h1>

<p align="center"><strong>Align coding agents with your architecture decisions</strong></p>

<p align="center">
  <a href="https://github.com/actual-software/actual-skill/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Factual-software%2Factual-skill%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version" alt="Version"></a>
  <a href="https://skills.sh/actual-software/actual-skill"><img src="https://img.shields.io/badge/skills.sh-actual--skill-black" alt="skills.sh"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/actual-software/actual-skill" alt="License"></a>
  <a href="https://github.com/actual-software/actual-skill/stargazers"><img src="https://img.shields.io/github/stars/actual-software/actual-skill?style=flat" alt="Stars"></a>
</p>

In Claude Code, the Actual.AI Plugin checks your coding agent's work against the architecture rules committed in `.actual/rules/`: its plan before you see the approval dialog, and its changes at the end of every turn. A conflict goes back to the agent with the reason. As the agent reads a file, it's briefed on the rules that govern it, and you can override a denied rule from the session. The [actual CLI](https://github.com/actual-software/actual-cli) does the checking. The plugin's `actual` skill runs and troubleshoots it for your agent, and its `adr-draft` and `adr-bootstrap` skills write ADRs with you, one at a time or as a repository's first set. The same checks and briefing run in Codex, with [a few differences](docs/reference.md#governance-in-codex).

## Getting started

1. Install the Actual.AI Plugin in Claude Code:

   ```
   /plugin marketplace add actual-software/actual-skill
   /plugin install actual-cli@actual-cli-skills
   /reload-plugins
   ```

2. Install the actual CLI, which runs the checks:

   ```bash
   npm install -g @actualai/actual
   ```

   [Homebrew and other install options](docs/install.md).

3. Optionally, run `actual login` to sign in to Actual AI. The checks, `actual rules` and drafting ADRs run signed out. Signed in, new ADRs go to Actual AI instead of `docs/adr/`.

4. Add your team's architecture decisions. Signed out, `actual adr create` (CLI 0.17.0 or later; `new` is its alias) writes each one into `docs/adr/` as accepted, along with the rule file under `.actual/rules/` that the checks read:

   ```bash
   actual adr create "Use Postgres for storage" --policy "MUST: Services store relational data in Postgres."
   ```

   Signed in, the same command saves the decision to Actual AI and writes an accepted one's rule file under `.actual/rules/`. The sync pull request [app.actual.ai](https://app.actual.ai) opens also writes both files for each accepted decision. You can have your agent draft decisions with you too: `/actual-cli:adr-draft <a decision>` for one, or `/actual-cli:adr-bootstrap` to propose a foundation set from the code. `actual rules ls` lists the rule files the checks read and marks a draft as not enforced.

From then on, every plan and every turn in that repository is checked against those decisions.

To install the plugin in Codex, see [Codex plugin](docs/install.md#codex-plugin). `npx skills add actual-software/actual-skill` installs the skills alone, without the checks, in Claude Code or another agent.

## Use

The checks run on their own. You can also ask your agent:

- "Which of our architecture rules govern `src/payments/`?"
- "Check my uncommitted changes against our architecture rules."
- "Diagnose why Actual is failing."
- "Draft an ADR for how we call the payment provider."
- "Propose the foundation ADRs for this repository."
- "List our draft decisions in Actual AI."

When a check denies, Claude Code asks whether to revise or override; `/actual-cli:override <rule-id|all> [code] [reason]` overrides from the prompt at any time. The [reference](docs/reference.md) covers the checks, overrides, rule briefing, settings and troubleshooting. The `adr-draft` skill creates, changes or removes one ADR with you, and `adr-bootstrap` proposes a set from the code, your ADR files and, if you agree, your past sessions in the repository, then creates the ones you pick through `adr-draft`. Signed out, each is an accepted file in `docs/adr/` that the checks enforce at once, and signed in, a decision in Actual AI, accepted or a draft as you choose ([Drafting ADRs](docs/reference.md#drafting-adrs)). The `actual` skill still runs adr-bot and the Advisor when you ask for them: [adr-bot and the Advisor](docs/adr-bot-and-advisor.md).

## License

[Apache-2.0](LICENSE)
