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

If the `actual` binary is not in PATH, **stop before doing anything else** — all commands, pre-flight checks, and diagnostics require the CLI. Offer to install it rather than just printing the steps: ask using an interactive question tool (e.g. `AskUserQuestion`) so your turn actually pauses for an answer, and don't continue — not even to keep exploring or planning — until the user responds. Mentioning it and continuing anyway isn't the same as asking. If they agree, run the command yourself with the Bash tool; if they decline, leave it at that and resume — installation stays optional, but only once they've actually answered.

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

After installing (or after the user declines and installs it themselves), verify: `actual --version`

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
| `actual plan-check` | Check an implementation plan against the rules in `.actual/rules/` | `--claude-hook`, `--rules-dir <dir>`, `--max-rounds` (newer builds only; verify with `actual plan-check --help`). Resolve plan text in the order below; never emit `permissionDecision: "allow"` |
| `actual impl-check` | Check a `git diff` against the rules in `.actual/rules/` — plan-check's implementation-stage counterpart (AK-755) | `--claude-hook`, `--diff-file <path>`, `--rules-dir <dir>`, `--max-rounds` (newer builds only; verify with `actual impl-check --help`). `--claude-hook` always resolves the diff via `git diff HEAD`; direct mode also accepts `--diff-file` or piped stdin. Never emit `permissionDecision: "allow"` |
| `actual check-override` | A human explicitly clears a rule that `plan-check` or `impl-check` denied for a session (refuses to run non-interactively; never invoked by the agent). `plan-check-override` still works as a backward-compatible alias | `--session <id>`, `--rule <doc-slug>::<rule-id>` (repeatable), `--reason "<text>"` — all required; `--repo`/`--rules-dir` optional, defaulting to the current directory |

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

## Plan- and Implementation-Stage Governance (Claude Code hooks)

This plugin ships Claude Code hooks that check an implementation plan, and separately
the diff an agent actually produces, against the ADR rules committed in the
repository. They are registered automatically on install — there is no manual setup.

| Hook | Event | What it does |
|------|-------|--------------|
| `hooks/preflight.sh` | `SessionStart` (`startup`, `resume`, `clear`, `compact`, `fork`) | Bootstrap preflight: reports whether the `actual` CLI is installed and new enough for `plan-check` and `impl-check`. Re-runs after compact so the reminder survives summarization |
| `hooks/plan-gate.sh` | `PreToolUse` on `ExitPlanMode` | The plan/implementation boundary. Hands the plan to `actual plan-check` and blocks a non-conforming plan |
| `hooks/impl-gate.sh` | `Stop` | The end-of-turn checkpoint (AK-754). Hands the turn's accumulated `git diff HEAD` to `actual impl-check` and forces the agent to continue on a non-conforming diff. Fires **unconditionally, every turn** — never gated on `plan-gate.sh` having run earlier in the session, so a turn that skips plan mode entirely is still governed |

`PreToolUse` on `ExitPlanMode` fires **after** the plan is written and **before** the
user's plan-approval dialog, so a blocked plan is revised by the agent rather than
shown to the human as an approvable artifact.

This ordering is **observed behavior, not a documented contract**. It was verified on
Claude Code **2.1.231**: a hook deny on `ExitPlanMode` logs `ExitPlanMode tool
permission denied`, the agent receives the reason and revises, and no approval dialog
is shown. Re-check it when moving to a materially newer Claude Code. Enforcement does
not depend on it — a deny blocks the call whenever the hook runs — but the "the human
never sees a blocked plan" property does.

`Stop` fires when Claude finishes responding to a turn. Per Claude Code's own hooks
reference (https://code.claude.com/docs/en/hooks), a `Stop` hook forces continuation
through a top-level `{"decision":"block","reason":"..."}` (or exit 2 with the reason
on stderr) — a different JSON shape from `PreToolUse`'s
`hookSpecificOutput.permissionDecision`, and not one this plugin assumed by analogy:
it was verified against the documented Stop contract specifically, because the two
hook events are not guaranteed to behave identically. See "Stop hook: `impl-gate.sh`'s
JSON contract" below for why that distinction matters here in particular.

### This is an advisory gate, not an enforcement boundary

Worth stating plainly: this raises the cost of an unreviewed change and catches
oversights before they ship, but it is not a security control, and several
deliberate design choices mean it fails open rather than blocking under real-world
conditions:

- **Any infrastructure problem fails open** — no `actual` CLI installed, no runner
  available, the judge call itself failing, no plan text or diff resolvable, no rules
  directory readable. All of these degrade to a non-blocking notice, never a deny.
  A hook that could get stuck or wrongly block on its own dependencies being
  unavailable would make the tool itself unreliable for reasons that have nothing to
  do with the plan or the diff.
- **A rules corpus over ~60 individual rules selected for one plan or diff is only
  partially judged** — one large document is enough on its own, and several
  ordinary ones add up just as easily. A broad or vague plan, or a large diff, is
  *more* likely to hit this, not less, since the deterministic selector has no
  relevance threshold below which it stops adding documents. This is disclosed, not
  silent: a deterministically-prioritized prefix of the rules is judged and
  acted on normally, and every surface (the panel, `--json`'s `partial`
  field, the hook's deny message, and its otherwise-silent notice) says
  plainly "N of M rules checked" rather than either reporting the prefix as
  complete coverage or refusing to check anything at all.
- **The revision loop's own escape valves are additional, deliberate fail-open
  paths, not enforcement**: the round limit stops blocking a persistently
  unresolved rule specifically so the hook does not get uninstalled, and a human
  can run `actual check-override` to wave a specific rule through outright.
  An override recorded against a session clears that rule for both `plan-check` and
  `impl-check` checks of that session — one override, not two independent
  mechanisms. Both round-limit passes and overrides are recorded
  (`~/.actualai/actual/plan-check-overrides.log`), which makes them *inspectable*,
  not enforced.

None of this is a defect — a hook that could hang or wrongly block a tool call
under infrastructure failure would be worse than one that fails open — but treat
every deny this plugin produces as a strong nudge with a paper trail, not a
guarantee nothing gets past it.

### When the hooks do nothing

All three hooks are silent no-ops — no output, exit 0 — unless the repository has at
least one `*.md` file in `.actual/rules/`. Installing the plugin therefore has no
effect on repositories that are not governed by Actual.

The gates also never hard-fail. If the CLI is missing, too old, or crashes, the hook
reports the problem and **makes no blocking decision**, leaving the turn to proceed
normally. Only an explicit **deny** from `plan-check`/`impl-check` (JSON decision or
exit 2) can block, and only when the wrapper can read it: a verdict that carries a
`\uXXXX` escape anywhere, or a duplicate `permissionDecision` key, is refused with a
notice saying the material was not checked, because the wrapper matches bytes and
never parses JSON. A conforming plan must print no `permissionDecision` --
either empty stdout, or a bare `systemMessage` notice (a partial-coverage or
round-limit disclosure, for example) with no decision attached, are both the
contract. Never emit `permissionDecision: "allow"`: it is a
**grant**, and a gate has no business approving a plan on the user's behalf. On
Claude Code 2.1.231 an `allow` does not actually bypass the plan-approval dialog —
Claude Code logs `Hook returned 'allow' for ExitPlanMode, but ask rule/safety check
requires full permission pipeline` and prompts the user anyway — but that safety
check is undocumented, so the wrapper drops an `allow` verdict rather than rely on it.

### Which repository root is governed

`<repo>` is the checkout the session is actually working in. Two signals decide it,
because neither is sufficient alone. `CLAUDE_PROJECT_DIR` is Claude Code's project
root, but it does **not** follow the session into a git worktree — it keeps naming
the original checkout. The git toplevel of the working directory names the active
checkout, but when Claude Code was launched inside a subdirectory of a larger
repository it names the outer repo rather than the subproject.

When one contains the other, the **deeper** path wins, because it is the more
specific context:

| Situation | `CLAUDE_PROJECT_DIR` | git toplevel of cwd | Governed |
|---|---|---|---|
| Worktree | `/repo` | `/repo/.claude/worktrees/x` | the worktree |
| Monorepo subproject | `/repo/packages/api` | `/repo` | the subproject |
| Ordinary session | `/repo` | `/repo` | either, they agree |

Otherwise the two are unrelated — a worktree created outside the project root, say —
and the active checkout under the working directory wins.

Measured on Claude Code **2.1.231**: entering a worktree leaves `CLAUDE_PROJECT_DIR`
on the original checkout and moves the working directory to
`<project>/.claude/worktrees/<name>`, i.e. **nested inside** that project root. A
plain "is cwd inside `CLAUDE_PROJECT_DIR`" test therefore keeps the original root and
governs the wrong branch, which is why the rule is depth rather than containment.

### Stop hook: `impl-gate.sh`'s JSON contract

`impl-gate.sh` cannot forward `actual impl-check --claude-hook`'s stdout the way
`plan-gate.sh` forwards `plan-check`'s: `impl-check --claude-hook` reuses
`plan-check`'s own JSON renderer in the CLI, so its output is always
`PreToolUse`-shaped (`hookSpecificOutput.hookEventName: "PreToolUse"`,
`permissionDecision`), regardless of which Claude Code event is actually asking.
`Stop`'s own decision control is a **top-level** `decision`/`reason` pair —
`{"decision":"block","reason":"..."}` — with no `hookSpecificOutput` involved at
all. Forwarded verbatim, the CLI's verdict would carry no `decision` field Claude
Code recognizes for `Stop`, and the turn would end silently ungoverned — exactly
the failure this hook exists to prevent.

So `impl-gate.sh` classifies the CLI's verdict — the same byte-matching allowlist
`plan-gate.sh` applies (`is_deny_decision`, `has_system_message`,
`has_permission_decision`, and the `\uXXXX`-escape / duplicate-key guards; see
`hooks/lib/bootstrap.sh`) — and **re-renders** it in `Stop`'s own shape instead of
forwarding it:

- A recognized **deny** becomes `{"decision":"block","reason":"<extracted
  permissionDecisionReason>"}`. The reason text is pulled out of the CLI's JSON with
  a quote-aware byte scan (`extract_json_string_field`), never a JSON parse — same
  dependency-hygiene constraint as everything else in `bootstrap.sh` — and is only
  trusted once the escape/duplicate-key guards have already passed, since those are
  exactly what make quote-termination unambiguous. Whitespace between the field
  name, the colon, and the opening quote is skipped, so a pretty-printed verdict
  still yields its reason. A recognized deny whose reason cannot be read still
  blocks, with a fixed reason; it does not degrade to a notice.
- A recognized bare **notice** (partial coverage, round-limit pass — no permission
  decision at all) becomes a plain top-level `{"systemMessage":"..."}`. This is
  deliberately *not* `hookSpecificOutput.additionalContext`: per Claude Code's docs,
  `additionalContext` on `Stop` "keeps the conversation going through the same loop
  protections as `decision: block`" — i.e. it also forces continuation — so it is
  unsafe for a fail-open notice that must let the turn end normally.
  `systemMessage` is `Stop`'s only channel that does not force continuation.
- Anything unsafe to interpret (an escape or duplicate key) or anything not on the
  allowlist (e.g. a wrongly-emitted `allow`) produces no decision at all, same as
  `plan-gate.sh`.
- The exit-2 fallback path is the one place this **is** a straight passthrough:
  `Stop`'s exit-2 contract ("blocks, stderr is the reason Claude sees") is identical
  to `PreToolUse`'s, so `impl-gate.sh` just propagates the CLI's stderr and exit
  code unchanged.

This was verified against Claude Code's documented `Stop` hook contract
(https://code.claude.com/docs/en/hooks) specifically — not assumed from the
`PreToolUse`/`ExitPlanMode` precedent above. The two hook events are not
guaranteed to behave identically, and here, concretely, they don't: the CLI's
renderer has no notion of which event asked, so the shell wrapper is the only
place that distinction is applied.

### Environment variables

| Variable | Effect |
|----------|--------|
| `ACTUAL_PLAN_GATE=off` | Disable all of this plugin's governance hooks (`plan-gate.sh`, `impl-gate.sh`, and their `preflight.sh` reminder) |
| `ACTUAL_RULES_DIR` | Govern against a different rules directory (e.g. a subproject in a monorepo). Each hook forwards the resolved path to the CLI as `--rules-dir`; `plan-check`/`impl-check` must honor that flag rather than rediscovering rules from cwd |
| `ACTUAL_PLAN_CHECK_MAX_ROUNDS` | Override `plan-check --claude-hook`'s round limit (default 3). Independent of the variable below — the two commands' revision loops are budgeted separately, even though they share session state |
| `ACTUAL_IMPL_CHECK_MAX_ROUNDS` | Override `impl-check --claude-hook`'s round limit (default 3) |

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

The hook always invokes `actual plan-check --claude-hook --rules-dir <dir>`,
where `<dir>` is `ACTUAL_RULES_DIR` if set, otherwise `<repo>/.actual/rules`.
`plan-check` must score that directory and must not ignore the flag in favor of
cwd. `--help` should list `--rules-dir`.

Stdout must be exactly one JSON object, or empty. Logs go to stderr. A line
before the JSON makes the wrapper drop a deny; `{...}` that is not valid hook
JSON is forwarded and Claude Code reports a hook error.

Fixtures under `hooks/tests/fixtures/` encode the three envelopes:

| Fixture | Shape |
|---------|--------|
| `pretooluse-plan-injected.json` | Current: `tool_input.plan` and `tool_input.planFilePath` |
| `pretooluse-plan-inline.json` | Legacy: plan in `tool_input.plan` only |
| `pretooluse-plan-file.json` | Legacy: empty `tool_input`; plan only via transcript |

### `--claude-hook` diff resolution

Unlike plan text, there is no envelope field carrying the material to check — no
tool call injects a diff the way `ExitPlanMode` injects a plan. `actual impl-check
--claude-hook` always resolves the diff by shelling out to `git diff HEAD` in the
resolved repository root; the hook envelope (`hooks/tests/fixtures/stop-turn.json`
is the recorded shape) is forwarded unparsed purely to key the revision-loop session
off `session_id`, the same way `plan-check`'s envelope is. An empty diff (the working
tree already matches `HEAD`) is not an error — it is the ordinary "nothing changed
this turn" case — and degrades to a non-blocking notice, never a deny.

The hook always invokes `actual impl-check --claude-hook --rules-dir <dir>`, same
`<dir>` resolution as `plan-check`'s.

### Requirements

`actual plan-check` and `actual impl-check` are only present in newer CLI builds
(`impl-check` newer still — see AK-755). On an older CLI the relevant hook emits an
upgrade message instead of a flag error — check with:

```bash
actual plan-check --help
actual impl-check --help
```

`preflight.sh` probes both independently at `SessionStart` and surfaces whichever is
missing — a CLI can have `plan-check` without `impl-check` (it shipped first), but
not the reverse, so `plan-check`'s own upgrade guidance takes priority when neither
is present.

### The revision loop, overrides, and round limits

A denied plan is not a dead end: the agent revises and calls `ExitPlanMode`
again, which fires the hook again. Likewise, a denied diff is not a dead end at
`Stop`: the agent is forced to continue, fixes it, and the next `Stop` re-evaluates
the new accumulated diff. Both commands track this per `(session_id, rules_dir)` —
not `session_id` alone, since one Claude Code conversation can govern more than one
repository or monorepo subproject (`ACTUAL_RULES_DIR`), and those commonly share
synced rule slugs from the same ADR bank. `plan-check` and `impl-check` sessions for
the same `(session_id, rules_dir)` share this same state — a rule an override clears
is cleared for both, and a session `impl-check` sees for the first time (no prior
`plan-check` call ever touched it) simply starts fresh, the same as any other new
session. State lives under the user's config directory, never inside the governed
repo.

- **A `requires_decision` verdict blocks exactly like a real conflict.** A
  plan the judge classifies as *deliberately* superseding a rule is not
  automatically believed — that classification is model output, not a
  recorded human decision — so it is denied the same way an outright
  violation is, not just noted and allowed to proceed.
- **Cleared rules stay cleared — for the plan text that earned it.** Once a
  rule is judged conforming against a specific plan, it is never sent to the
  judge again *for that same plan text* in this session — a later round
  cannot re-flag it, even if the judge would otherwise be non-deterministic
  about it. Edit the plan at all and the rule is judged fresh; a clearance is
  never a standing pass regardless of what the plan says later.
- **An explicit, recorded override.** A human — never the agent — runs
  `actual check-override --session <id> --rule <doc-slug>::<rule-id>
  --reason "<why>"` directly, from an interactive terminal (it refuses to run
  non-interactively, since the whole point is that this is a human action).
  `plan-check-override` still works as a backward-compatible alias. The deny
  message names the session id but deliberately does not hand back a
  ready-to-paste invocation — run `actual check-override --help` for the
  exact flags, and pass `--repo`/`--rules-dir` if you are not standing in the
  same repo the denial came from. An overridden rule is excluded from judging
  from then on regardless of plan or diff text — by both commands, since they
  share session state — and every subsequent round says so in a non-blocking
  notice — an override is visible, never a silent bypass.
- **A round limit, tracked per rule.** After `--max-rounds` (default 3, or
  `ACTUAL_PLAN_CHECK_MAX_ROUNDS` / `ACTUAL_IMPL_CHECK_MAX_ROUNDS` respectively —
  each command's revision loop is budgeted independently) denials of the *same
  rule*, the gate stops blocking on that rule specifically, rather than denying
  indefinitely. A rule that has exhausted its own count never exempts a different,
  still-fresh conflict in the same round — the whole call stays denied until
  every currently-blocking rule has individually hit its limit. This pass is
  not silent either: the hook emits a loud notice, and both an override and a
  round-limit pass are appended to `~/.actualai/actual/plan-check-overrides.log`
  (kept under its original filename for history continuity; JSONL, one line per
  event) for a durable, inspectable trace.

For `impl-gate.sh` specifically, a round-limit pass or override clearance is a bare
notice — see "Stop hook: `impl-gate.sh`'s JSON contract" above: it renders as a
plain `systemMessage`, never `hookSpecificOutput.additionalContext`, since the
latter would force continuation for a condition this is deliberately choosing not
to block on.

### Testing the hooks

```bash
bash hooks/tests/run.sh
```

Runs the full decision matrix (no-op, missing binary, old CLI, pass, deny, crash)
against recorded hook payloads and a fake CLI, for both `plan-gate.sh` and
`impl-gate.sh`. No network and no real `actual` install required.

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
