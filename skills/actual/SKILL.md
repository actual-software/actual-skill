---
name: actual
description: >-
  Feature-complete companion for the actual CLI, an ADR-powered
  CLAUDE.md/AGENTS.md generator. Runs and troubleshoots actual adr-bot,
  status, auth, config, runners, and models, plus the Actual AI platform
  surface: login, logout, whoami, and advisor (org-scoped architecture
  Q&A). Covers all 5 runners (claude-cli, anthropic-api, openai-api,
  codex-cli, cursor-cli), all model patterns, all 3 output formats
  (claude-md, agents-md, cursor-rules), and all error types. Use when
  working with the actual CLI, running actual adr-bot, signing in to
  Actual AI, asking the advisor, configuring runners or models,
  troubleshooting errors, or managing output files.
---

# actual CLI Companion

Inline knowledge and operational workflows for the actual CLI. Read this file first; load reference files only when you need deeper detail for a specific topic.

## CLI Not Installed

If the `actual` binary is not in PATH, **stop and help the user install it** before doing anything else. All commands, pre-flight checks, and diagnostics require the CLI.

Detect with:
```bash
command -v actual
```

Install options (try in this order):

| Method | Command |
|--------|---------|
| npm/npx (quickest) | `npm install -g @actualai/actual` |
| Homebrew (macOS/Linux) | `brew install actual-software/actual/actual` |
| GitHub Release (manual) | Download from `actual-software/actual-releases` on GitHub |

For one-off use without installing globally:
```bash
npx @actualai/actual adr-bot [flags]
```

After install, verify: `actual --version`

Before using a documented subcommand or flag, verify it exists in the installed
CLI with `actual --help` or `actual <subcommand> --help`. If it is missing,
help the user update the CLI; do not run development-only flags against an older
release.


## Commands

| Command | Purpose | Key Flags |
|---------|---------|-----------|
| `actual adr-bot` | Analyze repo, fetch ADRs, tailor, write output | `--dry-run [--full]`, `--force`, `--no-tailor`, `--project PATH`, `--model`, `--runner`, `--verbose`, `--reset-rejections`, `--max-budget-usd`, `--no-tui`, `--output-format`, `--show-errors` |
| `actual status` | Check output file state | `--verbose` |
| `actual auth` | Check the runner (coding-agent) auth status | (none) |
| `actual config show` | Display current config | (none) |
| `actual config set <key> <value>` | Set a config value | (none) |
| `actual config path` | Print config file path | (none) |
| `actual runners` | List available runners | (none) |
| `actual models` | List known models by runner | (none) |
| `actual login` | Sign in to Actual AI (browser OAuth) | `--org <id>`, `--api-url <url>`, `--no-browser` |
| `actual logout` | Sign out of Actual AI and clear local credentials | (none) |
| `actual whoami` | Show the signed-in Actual AI identity (no network) | (none) |
| `actual advisor "<query>"` | Ask the Advisor an architecture question | Released v0.2.0: `--org <uuid>`, `--repo <uuid>`, `--api-url <url>`; newer builds may add named/automatic scope |
| `actual cache clear` | Clear local analysis and tailoring caches | (none) |
| `actual plan-check` | Check an implementation plan against the rules in `.actual/rules/` | `--claude-hook` (newer builds only; verify with `actual plan-check --help`). Resolve plan text in the order below; never emit `permissionDecision: "allow"` |

## Platform Identity & Advisor

These commands talk to the **Actual AI platform** (your account/org) and are **separate from `actual auth`** — `actual auth` only checks the local coding-agent/runner (claude/codex/cursor) that `adr-bot` drives. `login`/`logout`/`whoami` manage your Actual AI platform identity; `advisor` asks organization- or repository-scoped architecture questions against it. (The runner/model sections below pertain to `adr-bot`, not to these.)

**Endpoint config** — production works without an override.
- `login` reads `--api-url <url>`, then `ACTUAL_AUTH_URL`, then defaults to `https://app.actual.ai`.
- `advisor` reads `--api-url <url>`, then `ACTUAL_API_URL`, then defaults to `https://api-service.api.prod.actual.ai`.
- OAuth `client_id`/scopes default to `actual-cli` and `openid profile offline_access adr:query adr:review` (override via `ACTUAL_OAUTH_CLIENT_ID` / `ACTUAL_OAUTH_SCOPES`).

### login — interactive; hand off to the human

`actual login` runs a browser OAuth flow (auth-code + PKCE + a `127.0.0.1` loopback). **It needs a human at a browser, so an agent cannot complete it inside a non-interactive shell.** Drive it like this:

1. First check whether the user is already signed in with `actual whoami` (no network; non-zero exit / "Not signed in" when logged out). If signed in, skip login.
2. If not signed in, **ask the human to run login**, or run it for them and surface the URL:
   ```bash
   actual login --no-browser       # prints the authorize URL instead of opening a browser
   actual login --org <org-id>     # multi-org accounts: pre-select an org (single-org auto-selects)
   ```
   With `--no-browser`, give the printed URL to the user to open; the CLI waits on the loopback redirect to finish the sign-in.
3. A multi-org user who omits `--org` picks the org on the consent page; if the redirect times out, re-run with `--org <id>`.

Do **not** attempt to script the browser/consent step — treat login as a human handoff, then resume automation once `whoami` succeeds.

### whoami — safe, non-interactive

```bash
actual whoami
```

Prints the cached identity — Organization, Account, Member, Scopes — with **no network call**. Use it as the pre-flight gate before `advisor`: exit code `2` ("Not signed in to Actual AI") means run `login` first.

### logout

```bash
actual logout
```

Best-effort server-side token revoke, then always clears local credentials. Safe and non-interactive.

### advisor — non-interactive, async query

`actual advisor "<question>"` asks an architecture question. It is **agent-friendly** (no TTY required): it starts an async job, polls to completion, and prints a plain-text summary followed by the related ADRs. Progress ("advisor thinking…") goes to stderr; the answer goes to stdout.

```bash
actual advisor "How should I handle database access in a new service?"

# point at a local/staging endpoint — one export steers it; --api-url overrides
ACTUAL_API_URL=https://your-advisor-endpoint actual advisor "…"

# released v0.2.0: scope by connected-repository UUID
actual advisor "…" --repo <repo-uuid>

# newer builds only; verify these flags with `actual advisor --help`
actual advisor "…" --repo actual-software/actual-cli
actual advisor --show-scope
actual advisor --repo none
actual advisor --repo auto
```

Requires a valid signed-in session — `NotLoggedIn` (exit `2`) means run `login` first. The advisor transparently refreshes an expired token before the call. Output is human-readable text today (no `--json` flag yet).

Scope behavior is version-dependent:

- Released v0.2.0 accepts only a connected-repository UUID; omitting `--repo`
  uses organization scope.
- Newer builds may accept a name or `owner/name`, remember a per-working-tree
  scope, auto-detect from `origin`, and expose `--show-scope`, `--repo none`,
  and `--repo auto`.

Always inspect `actual advisor --help` before using the newer scope workflow.

> For the full OAuth flow, scopes, multi-org selection, the advisor poll model, and org/repo scoping, see `references/platform-advisor.md`.

## Plan-Stage Governance (Claude Code hooks)

This plugin ships Claude Code hooks that check an implementation plan against the
ADR rules committed in the repository **before** implementation begins. They are
registered automatically on install — there is no manual setup.

| Hook | Event | What it does |
|------|-------|--------------|
| `hooks/preflight.sh` | `SessionStart` | Bootstrap preflight: reports whether the `actual` CLI is installed and new enough, once per session |
| `hooks/plan-gate.sh` | `PreToolUse` on `ExitPlanMode` | The plan/implementation boundary. Hands the plan to `actual plan-check` and blocks a non-conforming plan |

`PreToolUse` on `ExitPlanMode` fires **after** the plan is written and **before** the
user's plan-approval dialog, so a blocked plan is revised by the agent rather than
shown to the human as an approvable artifact.

### When the hooks do nothing

Both hooks are silent no-ops — no output, exit 0 — unless the repository has at
least one `*.md` file in `.actual/rules/`. Installing the plugin therefore has no
effect on repositories that are not governed by Actual.

The gate also never hard-fails. If the CLI is missing, too old, or crashes, the hook
reports the problem and **makes no permission decision**, leaving the normal approval
flow intact. Only an explicit **deny** from `plan-check` (JSON `permissionDecision`
or exit 2) can block a plan. A conforming plan must print no `permissionDecision`
(empty stdout is the contract). Never emit `permissionDecision: "allow"`: that
field is version-fragile on `ExitPlanMode` and can skip the user's plan-approval
dialog. The wrapper will drop an `allow` verdict if one is returned.

### Environment variables

| Variable | Effect |
|----------|--------|
| `ACTUAL_PLAN_GATE=off` | Disable both hooks entirely |
| `ACTUAL_RULES_DIR` | Govern against a different rules directory (e.g. a subproject in a monorepo) |

### `--claude-hook` plan resolution

The wrapper does not parse the hook envelope. `actual plan-check --claude-hook`
must resolve plan text itself, in this order, and stop at the first hit:

1. **`tool_input.plan`** — non-empty string. Current Claude Code injects the plan
   into the envelope before hooks run, even when the model's literal input was
   empty. Older builds also put the plan here.
2. **`tool_input.planFilePath`** — set and readable. Same injection; no transcript
   I/O.
3. **Transcript fallback** — only if both of those are missing: `prompt_id` +
   `transcript_path` → the `plan_mode` attachment → `planFilePath`. Do not scrape
   the transcript when (1) or (2) already produced the plan.
4. If none of those work: fail open (notice, no `permissionDecision`).

Fixtures under `hooks/tests/fixtures/` encode the three envelopes:

| Fixture | Shape |
|---------|--------|
| `pretooluse-plan-injected.json` | Current: `tool_input.plan` and `tool_input.planFilePath` |
| `pretooluse-plan-inline.json` | Legacy: plan in `tool_input.plan` only |
| `pretooluse-plan-file.json` | Legacy: empty `tool_input`; plan only via transcript |

### Requirements

`actual plan-check` is only present in newer CLI builds. On an older CLI the hook
emits an upgrade message instead of a flag error — check with:

```bash
actual plan-check --help
```

### Testing the hooks

```bash
bash hooks/tests/run.sh
```

Runs the full decision matrix (no-op, missing binary, old CLI, pass, deny, crash)
against recorded hook payloads and a fake CLI. No network and no real `actual`
install required.

## Runner Decision Tree

Use this to determine which runner a user needs:

```
Has claude binary installed?
  YES -> claude-cli (default runner, no API key needed)
  NO  -> Do they want Anthropic models?
           YES -> anthropic-api (needs ANTHROPIC_API_KEY)
           NO  -> Do they want OpenAI models?
                    YES -> codex-cli or openai-api (needs OPENAI_API_KEY)
                    NO  -> cursor-cli (needs agent binary, optional CURSOR_API_KEY)
```

### Runner Summary

| Runner | Binary | Auth | Default Model |
|--------|--------|------|---------------|
| claude-cli | `claude` | `claude auth login` | claude-sonnet-4-6 |
| anthropic-api | (none) | `ANTHROPIC_API_KEY` | claude-sonnet-4-6 |
| openai-api | (none) | `OPENAI_API_KEY` | gpt-5.2 |
| codex-cli | `codex` | `OPENAI_API_KEY` or `codex login` (ChatGPT OAuth) | gpt-5.2 |
| cursor-cli | `agent` | Optional `CURSOR_API_KEY` | (cursor default) |

### Model-to-Runner Inference

The CLI auto-selects a runner from the model name:

| Model Pattern | Inferred Runner |
|---------------|-----------------|
| `sonnet`, `opus`, `haiku` (short aliases) | claude-cli |
| `claude-*` (full names) | anthropic-api |
| `gpt-*`, `o1*`, `o3*`, `o4*`, `chatgpt-*` | codex-cli |
| `codex-*`, `gpt-*-codex*` | codex-cli |
| Unrecognized | Error with suggestions |

> For deep runner details (install steps, compatibility, special behaviors), see `references/runner-guide.md`.

## Non-Interactive Environments

This skill runs inside coding agents (Claude Code, Codex, Cursor) where the Bash tool does **not** provide a TTY. The CLI's TUI prompts and confirmation dialogs will fail with `TerminalIOError` unless disabled.

**Always pass `--force --no-tui`** on every `actual adr-bot` invocation:
- `--no-tui` disables TUI rendering that requires a terminal
- `--force` skips interactive confirmation prompts that cannot receive input

Use the agent's built-in question/confirmation tools (e.g., `AskUserQuestion`) for user confirmation instead of relying on CLI prompts.

## Sync Quick Reference

The most common sync patterns:

```bash
# Preview what sync would do (safe, no file changes)
actual adr-bot --dry-run --force --no-tui

# Preview with full content
actual adr-bot --dry-run --full --force --no-tui

# Run sync
actual adr-bot --force --no-tui

# Sync specific subdirectories only (monorepo)
actual adr-bot --force --no-tui --project services/api --project services/web

# Use a specific runner/model
actual adr-bot --force --no-tui --runner anthropic-api --model claude-sonnet-4-6

# Skip AI tailoring (use raw ADRs)
actual adr-bot --force --no-tui --no-tailor

# Re-offer previously rejected ADRs
actual adr-bot --force --no-tui --reset-rejections

# Set spending cap
actual adr-bot --force --no-tui --max-budget-usd 5.00
```

> For the complete 13-step sync internals, see `references/sync-workflow.md`.

## Operational Workflow: Running Sync

Follow this pattern whenever running sync. Do NOT skip pre-flight.

### 0. Verify CLI installed (LOW freedom -- exact check)

```bash
command -v actual       # Must succeed before anything else
```

If missing, follow the install steps in [CLI Not Installed](#cli-not-installed) above. Do NOT proceed until `actual --version` succeeds.

### 1. Pre-flight (LOW freedom -- exact commands)

```bash
actual runners          # Verify runner is available
actual auth             # Verify authentication (for claude-cli)
actual config show      # Review current configuration
```

If any check shows a problem, diagnose and fix before proceeding.

### 2. Dry-run (LOW freedom -- exact command)

```bash
actual adr-bot --dry-run --force --no-tui [--full] [user's flags]
```

Show the user what would change. Let them review.

### 3. Confirm (HIGH freedom)

Ask user if they want to proceed using the agent's built-in tools (e.g., `AskUserQuestion`). Do NOT rely on CLI prompts — they will fail in non-interactive shells. If no, stop.

### 4. Execute (LOW freedom -- exact command)

```bash
actual adr-bot --force --no-tui [user's flags]
```

### 5. On failure: Diagnose

Match the error against the troubleshooting table below. For full error details, load `references/error-catalog.md`.

### 6. Fix and retry

Apply the fix, then return to step 1 to verify.

## Operational Workflow: Diagnostics

For comprehensive environment checks, run the bundled diagnostic script:

Run the bundled `scripts/diagnose.sh` by its absolute path under the active
`actual` skill directory. Do not assume a Claude-specific install location.
For example, when the current directory is the skill directory:

```bash
bash scripts/diagnose.sh
```

This checks all binaries, auth status, environment variables, config, and output files in one pass. It is read-only and never modifies anything.

Use inline commands instead when checking a single thing (e.g., just `actual auth`).

## Troubleshooting Quick Reference

| Error | Exit Code | Likely Cause | Quick Fix |
|-------|-----------|-------------|-----------|
| ClaudeNotFound | 2 | `claude` binary not in PATH | Install Claude Code CLI |
| ClaudeNotAuthenticated | 2 | Not logged in | Run `claude auth login` |
| CodexNotFound | 2 | `codex` binary not in PATH | Install Codex CLI |
| CodexNotAuthenticated | 2 | No auth for codex | Set `OPENAI_API_KEY` or run `codex login` |
| CursorNotFound | 2 | `agent` binary not in PATH | Install Cursor CLI |
| ApiKeyMissing | 2 | Required env var not set | Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` |
| NotLoggedIn | 2 | Not signed in to the Actual AI platform | Run `actual login` |
| CodexCliModelRequiresApiKey | 2 | ChatGPT OAuth with explicit model | Set `OPENAI_API_KEY` (OAuth only supports default model) |
| CreditBalanceTooLow | 3 | Insufficient API credits | Add credits to account |
| ApiError | 3 | API request failed | Check API URL, network, credentials |
| ApiResponseError | 3 | Unexpected API response | Check API status, retry |
| RunnerFailed | 1 | Runner process errored | Check runner output, logs |
| RunnerOutputParse | 1 | Could not parse runner output | Check model compatibility |
| RunnerTimeout | 1 | Runner exceeded time limit | Increase `invocation_timeout_secs` |
| ConfigError | 1 | Invalid config file | Check YAML syntax, run `actual config show` |
| AnalysisEmpty | 1 | No analysis results | Check project path, repo content |
| TailoringValidationError | 1 | Tailored output invalid | Retry, or use `--no-tailor` |
| TerminalIOError | 1 | CLI needs a TTY (non-interactive shell) | Add `--force --no-tui` flags |
| IoError | 5 | File I/O failure | Check permissions, disk space |
| UserCancelled | 4 | User cancelled operation | (intentional) |

> For full error details with hints and diagnosis steps, see `references/error-catalog.md`.

## Exit Code Categories

| Code | Category | Errors |
|------|----------|--------|
| 1 | General / runtime | RunnerFailed, RunnerOutputParse, ConfigError, RunnerTimeout, AnalysisEmpty, TailoringValidationError, InternalError, TerminalIOError |
| 2 | Auth / setup | ClaudeNotFound, ClaudeNotAuthenticated, CodexNotFound, CodexNotAuthenticated, CursorNotFound, ApiKeyMissing, CodexCliModelRequiresApiKey, NotLoggedIn |
| 3 | Billing / API | CreditBalanceTooLow, ApiError, ApiResponseError |
| 4 | User cancelled | UserCancelled |
| 5 | I/O | IoError |

## Config Quick Reference

Config file: `~/.actualai/actual/config.yaml` (override with `ACTUAL_CONFIG` or `ACTUAL_CONFIG_DIR` env vars).

Most-used config keys:

| Key | Default | Purpose |
|-----|---------|---------|
| `runner` | claude-cli | Which runner to use |
| `model` | claude-sonnet-4-6 | Model for Anthropic runners |
| `output_format` | claude-md | Output format: claude-md, agents-md, cursor-rules |
| `batch_size` | 15 | ADRs per batch (min 1) |
| `concurrency` | 10 | Parallel requests (min 1) |
| `invocation_timeout_secs` | 600 | Runner timeout in seconds (min 1) |
| `max_budget_usd` | (none) | Spending cap (positive, finite) |

> For all 18 config keys with validation rules, see `references/config-reference.md`.

## Output Formats

| Format | File | Header |
|--------|------|--------|
| claude-md (default) | `CLAUDE.md` | `# Project Guidelines` |
| agents-md | `AGENTS.md` | `# Project Guidelines` |
| cursor-rules | `.cursor/rules/actual-policies.mdc` | YAML frontmatter (`alwaysApply: true`) |

Managed sections use markers: `<!-- managed:actual-start -->` / `<!-- managed:actual-end -->`.

Merge behavior:
- **New root file**: header + managed section
- **New subdir file**: managed section only (no header)
- **Existing with markers**: replace between markers, preserve surrounding content
- **Existing without markers**: append managed section

> For full format details and merge internals, see `references/output-formats.md`.

## Reference Files

Load these only when you need deeper detail on a specific topic:

| File | When to Load |
|------|-------------|
| `references/sync-workflow.md` | Debugging sync failures, understanding sync internals |
| `references/runner-guide.md` | Setting up a runner, model compatibility, runner-specific behavior |
| `references/error-catalog.md` | Troubleshooting a specific error with full diagnosis steps |
| `references/config-reference.md` | Looking up config keys, validation rules, dotpath syntax |
| `references/output-formats.md` | Output format questions, managed section behavior, merge logic |
| `references/platform-advisor.md` | Login/OAuth flow, scopes, multi-org selection, advisor poll model, org/repo scoping |

## Additional Resources

For anything not covered by this skill or its reference files, fetch the full CLI documentation:

- **Full docs (Markdown)**: https://cli.actual.ai/docs.md — complete command reference, all flags, runners, output formats, config keys, and troubleshooting
- **LLM summary**: https://cli.actual.ai/llms.txt — concise machine-readable overview
