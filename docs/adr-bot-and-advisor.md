# adr-bot and the Advisor

The skill also runs two other CLI commands, `actual adr-bot` and `actual advisor`, when you ask for them. Neither is part of governance, and neither runs on its own. Their full reference, flags included, is in the actual-cli repository: [adr-bot and the Advisor](https://github.com/actual-software/actual-cli/blob/main/docs/ADR_BOT_AND_ADVISOR.md).

## ADR-backed context

The skill runs `actual adr-bot`, which reads your repository, fetches your team's ADRs from Actual AI, and writes guidance tailored to your codebase into the file your agent reads: `CLAUDE.md`, `AGENTS.md`, or Cursor rules. Your agent starts every session already knowing how your team builds things.

Ask your agent: "Run adr-bot to write our ADRs into CLAUDE.md."

## Architecture answers

When you ask, the skill puts your architecture question to the Actual advisor. The advisor answers from your organization's ADRs and cites its sources, so you can trace every recommendation back to a decision your team made. It needs a sign-in first, with `actual login`.

Ask your agent: "Ask the Actual advisor how we should handle database access in a new service."
