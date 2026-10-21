<p align="center">
  <a href="https://actual.ai/developers">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/logo-white-text.png">
      <img src="assets/logo-black-text.png" alt="Actual AI" width="240">
    </picture>
  </a>
</p>

<h1 align="center">Architectural context for coding agents</h1>

<p align="center"><strong>Teach coding agents to run, configure, and troubleshoot the actual CLI autonomously. Installs into Claude Code, Codex, and more.</strong></p>

<p align="center">
  <a href="https://github.com/actual-software/actual-skill/releases"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Factual-software%2Factual-skill%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version" alt="Version"></a>
  <a href="https://skills.sh/actual-software/actual-skill"><img src="https://img.shields.io/badge/skills.sh-actual--skill-black" alt="skills.sh"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/actual-software/actual-skill" alt="License"></a>
  <a href="https://github.com/actual-software/actual-skill/stargazers"><img src="https://img.shields.io/github/stars/actual-software/actual-skill?style=flat" alt="Stars"></a>
</p>

The skill drives the [actual CLI](https://github.com/actual-software/actual-cli) for your agent: it writes your team's architecture decisions (ADRs) into `CLAUDE.md`, `AGENTS.md` or Cursor rules, answers architecture questions from them, and fixes CLI failures. In Claude Code, it also checks plans and changes against the rules in `.actual/rules/`.

## Install

```bash
npx skills add actual-software/actual-skill
```

In Claude Code, install the plugin instead to get the plan and change checks:

```
/plugin marketplace add actual-software/actual-skill
/plugin install actual-cli@actual-cli-skills
/reload-plugins
```

On first run, the skill offers to install the actual CLI. [Other install options](docs/install.md).

## Use

Ask your agent:

- "Set up Actual for this repository."
- "Ask the Actual advisor how we should handle database access in a new service."
- "Diagnose why Actual is failing."

The [reference](docs/reference.md) covers the checks, rule briefing, settings and troubleshooting.

## License

[Apache-2.0](LICENSE)
