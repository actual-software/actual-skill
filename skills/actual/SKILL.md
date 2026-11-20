---
name: actual
description: >-
  Companion for the actual CLI's architecture governance. Runs and
  troubleshoots plan-check and impl-check, which check a plan or a diff
  against the ADR rules committed in .actual/rules/ (in Claude Code this
  plugin runs them on every plan and every turn), the rules commands that
  show which rules govern a file or a plan (rules ls, select, brief and
  index), check-override, the human-only way to clear a denied rule,
  signing in with login, whoami and logout, and the actual adr commands
  for ADR files and decisions in Actual AI. Use when checking a plan or
  changes against the repository's architecture rules, finding the rules
  for a file, explaining a denial or how to override it, signing in to
  Actual AI, listing, importing or changing decisions, installing or
  upgrading the CLI, configuring runners or models, or troubleshooting
  the CLI and its hooks. Runs actual adr-bot (CLAUDE.md, AGENTS.md and
  Cursor rules written from ADRs) and the advisor (org-scoped
  architecture Q&A) only when the user asks for them.
---

# actual CLI Companion

Inline knowledge and operational workflows for the actual CLI. Read this file first; load reference files only when you need deeper detail for a specific topic.

## CLI Not Installed

If the `actual` binary is not in PATH, **stop before doing anything else** — all commands, pre-flight checks, and diagnostics require the CLI. Offer to install it rather than just printing the steps: ask so your turn actually pauses for an answer — with an interactive question tool where you have one (e.g. `AskUserQuestion` in Claude Code), or, in Codex, by asking in your reply and ending your turn on the question — and don't continue — not even to keep exploring or planning — until the user responds. Mentioning it and continuing anyway isn't the same as asking. If they agree, run the command yourself in your shell tool; if they decline, leave it at that and resume — installation stays optional, but only once they've actually answered.

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
npx @actualai/actual <command> [flags]
```

After installing (or after the user declines and installs it themselves), verify: `actual --version`

Before using a documented subcommand or flag, verify it exists in the installed
CLI with `actual --help` or `actual <subcommand> --help`. If it is missing,
help the user update the CLI; do not run development-only flags against an older
release.


## Commands

| Command | Purpose | Key Flags |
|---------|---------|-----------|
| `actual plan-check` | Check an implementation plan against the rules in `.actual/rules/` | `--claude-hook`, `--rules-dir <dir>`, `--max-rounds` (newer builds only; verify with `actual plan-check --help`). Resolve plan text in the order below; never emit `permissionDecision: "allow"` |
| `actual impl-check` | Check a working-tree diff against the rules in `.actual/rules/` — plan-check's implementation-stage counterpart | `--claude-hook`, `--diff-file <path>`, `--rules-dir <dir>`, `--max-rounds` (newer builds only; verify with `actual impl-check --help`). `--claude-hook` always resolves the working-tree diff (tracked changes plus untracked, non-ignored files) against the commit the turn started from when a `UserPromptSubmit` call recorded one, otherwise against `HEAD`. Direct mode also accepts `--diff-file` or piped stdin, and diffs the working tree against `HEAD` when neither is given. Never emit `permissionDecision: "allow"` |
| `actual rules ls` | List the rule documents under `.actual/rules/`, and flag any that fail to parse | `[PATH]` (repository root, default the current directory), `--json` |
| `actual rules select` | Select the rule documents that govern a plan, or a path with no plan | `[PLAN]...`, `--file <path>` (repeatable), `--repo <path>`, `--limit` (default 10), `--min-score`, `--by-adr` |
| `actual rules brief` | The rules governing one file, as briefing delivers them | `--file <path>`, `--repo <path>`, `--rules-dir <dir>`, `--limit`, `--rules-per-decision`, `--max-chars`, `--min-score`; `--claude-hook` is the hooks' mode |
| `actual rules index` | Build or refresh the scope index the checks and `rules select` prefilter with | `[PATH]`, `--rebuild`, `--clear`, `--json` |
| `actual check-override` | A human explicitly clears a rule that `plan-check` or `impl-check` denied for a session. From inside the session the user picks an override in the dialog a denial raises, or types `/actual-cli:override <rule-id\|all> [code] [reason]` (a bare `/override` is an unknown command in Claude Code); the plugin's mod records either through `--claude-hook`, which refuses any process carrying `CLAUDECODE`, as every agent command does. The agent never invokes it. From a terminal it refuses to run non-interactively. `plan-check-override` still works as a backward-compatible alias | `--session <id>`, `--rule <doc-slug>::<rule-id>` (repeatable) — required unless `--claude-hook`; `--reason "<text>"` required through v0.12.0, optional in later builds (verify with `actual check-override --help`); `--reason-code <code>` (0.14.0 or later) sets the code, one of `misread`, `not-here`, `adr-wrong`, `adr-outdated` or `accepted`, and a `--reason` without it is stored as `other`; `--repo`/`--rules-dir` optional, defaulting to the current directory |
| `actual login` | Sign in to Actual AI (browser OAuth) | `--org <id>`, `--api-url <url>`, `--no-browser` |
| `actual whoami` | Show the signed-in Actual AI identity (no network) | (none) |
| `actual logout` | Sign out of Actual AI and clear local credentials | (none) |
| `actual adr create "<title>"` | Write a new decision. Signed out: a file in `docs/adr/` and, for an accepted one, its rule file in `.actual/rules/`. Signed in: a decision in Actual AI, sent once and never retried, and with `--all` (0.16.0 or later), every decision file under `docs/adr/` it doesn't have yet. `new` is its alias | The title or `--title`, `--context <point>` and `--policy "LEVEL: statement"` (each repeatable), `--scope <glob>`, `--status accepted\|draft`, `--root`, `--json`; signed out only, `--deciders`; signed in only, `--file <path>` or `--all` in place of the title and content, `--repo`, `--allow-duplicate` |
| `actual adr check [FILE]...` | Check decision files with Actual AI's save rules and list likely duplicates; local, and compares with Actual AI when signed in. From 0.16.0 it also lists each file under `docs/adr/` that won't publish | `--no-cloud`, `--repo <repo>`, `--root`, `--json` |
| `actual adr discover` | 0.16.0 or later: copy the ADRs a repository keeps in other tools' folders into `docs/adr/imported/` and list the files that won't publish; sends nothing, needs no sign-in | `--dry-run`, `--no-cloud`, `--root`, `--json` |
| `actual adr list` | List the organization's decisions (needs `login`) | `--repo <repo>`, `--state active\|draft\|suggested\|updated\|archived`, `--limit` (1 to 200, default 50), `--offset`, `--json` |
| `actual adr show <id>` | Show one decision with its policies and their ids (needs `login`) | `--json` |
| `actual adr update <id>` | Change a decision's title, context, policies, levels or scope (needs `login`) | `--title`, `--context`, `--policy "[<policy id>=]LEVEL: statement"`, `--level <policy id>=LEVEL`, `--scope`, `--clear-scope`, `--json` |
| `actual adr publish <id>` | Publish a draft decision so it governs (needs `login`) | `--json` |
| `actual adr unpublish <id>` | Move an active decision back to draft (needs `login`) | `--json` |
| `actual adr delete <id>` | Archive an active decision or a draft, as Delete does in the web app (needs `login`) | `--json` |
| `actual adr restore <id>` | Restore an archived decision to the list it came from (needs `login`) | `--json` |
| `actual adr accept <id>` | Accept a suggestion (needs `login`) | `--json` |
| `actual adr reject <id>` | Reject a suggestion, saving the reason with it (needs `login`) | `--reason <text>` (required, up to 10,000 characters), `--json` |
| `actual status` | Check the state of the files `adr-bot` writes | `--verbose` |
| `actual auth` | Check the runner (coding-agent) auth status | (none) |
| `actual config show` | Display current config | (none) |
| `actual config set <key> <value>` | Set a config value | (none) |
| `actual config path` | Print config file path | (none) |
| `actual runners` | List available runners | (none) |
| `actual models` | List known models by runner | (none) |
| `actual cache clear` | Clear local analysis and tailoring caches | (none) |
| `actual adr-bot` | On request only: analyze repo, fetch ADRs, tailor, write `CLAUDE.md`, `AGENTS.md` or Cursor rules | `--dry-run [--full]`, `--force`, `--no-tailor`, `--project PATH`, `--model`, `--runner`, `--verbose`, `--reset-rejections`, `--max-budget-usd`, `--no-tui`, `--output-format`, `--show-errors` |
| `actual advisor "<query>"` | On request only: ask the Advisor an architecture question (needs `login`) | Released v0.2.0: `--org <uuid>`, `--repo <uuid>`, `--api-url <url>`; newer builds may add named/automatic scope |

## Sign-in

These commands manage your **Actual AI platform** identity (your account/org) and are **separate from `actual auth`** — `actual auth` only checks the local coding-agent/runner (claude/codex/cursor) that the checks' judge and `adr-bot` drive. `plan-check`, `impl-check`, `rules` and `adr check` run signed out, and so does `adr create`, which then writes into `docs/adr/`; `advisor` needs a sign-in, and signed in the `adr` commands act on the organization's decisions in Actual AI. (The runner/model sections below pertain to the checks' judge and `adr-bot`, not to these.)

**Endpoint config** — production works without an override.
- `login` reads `--api-url <url>`, then `ACTUAL_AUTH_URL`, then defaults to `https://app.actual.ai`.
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

Prints the cached identity — Organization, Account, Member, Scopes — with **no network call**. Use it as the pre-flight gate before `advisor` and the `adr` commands that reach Actual AI: exit code `2` ("Not signed in to Actual AI") means run `login` first.

### logout

```bash
actual logout
```

Best-effort server-side token revoke, then always clears local credentials. Safe and non-interactive.

> For the full OAuth flow, scopes and multi-org selection, see `references/platform-advisor.md`.

## ADR commands

`actual adr` writes and checks ADRs in the repository and manages the organization's decisions in Actual AI. Signed out, `create` (alias `new`) writes a decision into `docs/adr/`, `check` reads the files there and `discover` copies other tools' ADRs in. Signed in, `create` saves to Actual AI, where the other commands act on the organization's decisions. Every command takes `--json` and prints its result as JSON on stdout, with errors on stderr. The commands arrived in 0.14.0, and 0.16.0 brings `create` into `docs/adr/` signed out, `discover` and `create --all`, so check `actual --version` first. On 0.15.0 and older, `discover` answers `unrecognized subcommand 'discover'` and `create --all` answers `unexpected argument '--all'` (both exit `2`); don't follow the tip it adds to try `--allow-duplicate`, a different flag. To draft a new ADR from the code or a conversation, use the plugin's `adr-draft` skill, which runs `create` and `check` with the user choosing at each step.

### adr create — docs/adr/ signed out, Actual AI signed in; alias new

```bash
actual adr create "Use Postgres for storage" \
  --context "Each service picked its own database." \
  --policy "MUST: Services store relational data in Postgres." \
  --deciders "Platform team" --json
actual adr create --file docs/adr/<file>.md --json     # signed in only
actual adr create --all --json                         # signed in only, 0.16.0 or later
```

Signed out, it writes the decision doc (`docs/adr/<id>-<title>.md`) under a new local id, in the layout Actual AI's sync uses, and for an accepted decision its rule file (`.actual/rules/cross-cutting-<topic>-<hash>.md`), so `plan-check` and `impl-check` enforce it at once. It runs Actual AI's save check first and writes nothing when the decision would be refused (exit `1`), and it never replaces a file. `--status` defaults to `accepted` from a terminal and from an agent's shell alike, and a `draft` file is read by no check. `--deciders` fills the Deciders line. `--file`, `--repo` and `--allow-duplicate` need a sign-in and are refused with the reason (exit `2`). `--json`: `adr_id`, `status`, `decision_file`, and `rule_file` for an accepted decision.

Signed in, it saves a decision to Actual AI from flags or from a file, and writes no file into `docs/adr/`. It refuses a file that doesn't parse, or flags with no `--policy`, before anything is sent, and refuses a likely duplicate of the repository's decisions (exit `1`) unless `--allow-duplicate` is passed. It then sends the decision once and never retries. Actual AI runs the save check as it saves, and a refusal exits `1` with the reasons. Flags save in one request, as the web app's New Decision does, and an accepted save also writes its rule file into `.actual/rules/`, so the checks enforce it at once. A file saves as a draft, as the web app's Import does, and `create` then sets the scope in the file's header and, for an accepted save, publishes it; if either step fails, the decision stays a saved draft and `scope_problem` or `publish_problem` gives the command that finishes the job. With `--file` it renames both files to the names the sync uses for the new id, so the next sync updates them in place. With no terminal it saves a draft unless `--status accepted` is passed; pass that only when the user asks. `--deciders` is refused signed in, so a decision saved to Actual AI has no Deciders line. On exit `3` saying the decision may have been saved, look with `actual adr list` before running `create` again. `--json`: `adr_id`, `status` as saved, `title`, `repo_unique_id`, `rule_file` when an accepted save from flags wrote one or `files_problem` when it couldn't, and with `--file`, `files.renamed` (`from`, `to`), `local_status_was` when the local status changed, and `scope_problem` or `publish_problem` when a step after the save failed.

Signed in, `create --all` (0.16.0 or later) sends each decision file under `docs/adr/` that carries an ADR header and passes `check`, one at a time in path order, and takes no title, `--file`, `--context`, `--policy` or `--status`. Nothing under `docs/adr/drafts/` is sent. Each file keeps the status its header names: a draft becomes a draft in Actual AI, and a file marked accepted is saved and published at once when a person is at the terminal, while from an agent's shell, a script or CI it's saved as a draft that's published once the file is on the default branch. It skips, and lists with the reason, a file whose id is already one of the repository's decisions, one whose status doesn't govern (such as `superseded` or `rejected`), and, unless `--allow-duplicate` is passed, one that looks like a decision there or like one saved earlier in the run. A second run saves nothing twice. A file that fails the check, or that Actual AI refuses, isn't saved; the run goes on to the next file and exits `1` at the end. It stops at the first save whose outcome is unknown (exit `3`), or at the first error that isn't about the file, such as an expired sign-in, and names the files it never sent. Run it only when the user asks, after `check` has shown them which files would go. Signed out it sends nothing, and with a file to send it exits `2` naming `check` and `discover`. `--json`: `repo_unique_id`, `files` (how many decision files it found), `saved` (each `file` with the fields `create --file` prints), `merged` (drafts published once their file reached the default branch), `skipped` and `not_saved` (each `file` and `reason`), `stopped` and `not_sent` when the run stopped early, and `other_files`, the markdown under `docs/adr/` with no ADR header, which `create` can't send.

### adr check — local; compares with Actual AI when signed in

```bash
actual adr check --json                  # the files under docs/adr/ (0.15.0 and older: only those with an ADR header)
actual adr check docs/adr/<file>.md      # only these files
```

Runs the save check on each file and lists likely duplicates among the repository's files and, when signed in, the connected repository's decisions in Actual AI (`--no-cloud` skips those). It exits `1` when a file fails; a likely duplicate is reported without failing. `--json`: `files` (`path`, `adr_id`, `title`, `ok`, `problems`, `warnings`), `duplicates` (`file`, then `other_file` or `other_decision`, and the matching title and policies under `overlap`), `skipped`, and `cloud` (`compared`, `scope`, `decisions`, and a `note` when it didn't compare).

From 0.16.0, with no file named, `check` also reads the files under `docs/adr/` that carry no ADR header, and ends with every file that won't publish, each with its reasons. A file with no ADR header, or one the save check refuses (no policy under `## Decision`, a title on more than one line, a document over the size limit), comes with a recommendation to normalize it: rewrite it in Actual's format, with the ADR header, a `# ` title and policies such as `1. MUST: …` under `## Decision`, as `create` writes them, so that it passes `check`. A file that looks like a decision in Actual AI comes with a recommendation to compare the two. Offer the rewrite, and make it only when the user asks. The list leaves out files whose id is already a decision in Actual AI, READMEs, indexes, templates and everything under `docs/adr/drafts/`, and counts in one line the header-less copies `actual adr-bot` writes. A file without a header doesn't fail the run. 0.15.0 and older check only the files with an ADR header and name the others under `skipped`, still exiting `0`; naming a file checks it anyway.

### adr discover — copies files in; no sign-in; 0.16.0 or later

```bash
actual adr discover --dry-run            # what it would copy, and the files that won't publish
actual adr discover --json
```

Finds the ADR files a repository keeps in the folders ADR tools use, each read three folders deep: the folder adr-tools' `.adr-dir` names (else `doc/adr`), MADR's `docs/decisions`, each `adrFolder` in `.log4brains.yml`, the `backstage.io/adr-location` annotation in `catalog-info.yaml`, and common folders such as `docs/adrs` and `docs/architecture/decisions`. It copies each one kept outside `docs/adr/` into `docs/adr/imported/<folder>/` under its own name, where `<folder>` is the source's folder with `-` between its parts (`doc/adr/0001-record-architecture-decisions.md` goes to `docs/adr/imported/doc-adr/`), so two tools' files of the same name don't collide. It never overwrites a file, copies each source once (`docs/adr/imported/.copied` lists them, and a listed source isn't copied again even after its copy is renamed or deleted), and leaves the sources where they are; `--dry-run` lists what it would copy and writes nothing. It sends nothing. Each file is listed with its layout (`actual`, `madr`, `nygard` or `other`), title and status, and the run ends with the files that won't publish, as `check` lists them (compared with Actual AI when signed in, unless `--no-cloud`). Copies in other layouts don't publish until they're normalized: offer the rewrite, and make it only when the user asks.

### adr list and show — read; need login

```bash
actual adr list --state draft --json
actual adr show <id> --json
```

`list` covers the connected repository the checkout's `origin` remote names, or the whole organization when there is none; `--repo` picks one by name, `owner/name` or id, and `--state` matches a list on the web app's decisions page. `--json`: `decisions`, `total`, and `next_offset` for the next page. `show` prints one decision: `id`, `kind` (`group` for one Actual AI grouped from several policies), `title`, `state`, `status`, `context`, `policies` (each with the `id` that `update` takes), `scope` and `category`. `show` and the commands that change a decision take the id `list` prints; for a grouped decision, the id of any of its policies' rows works too.

### adr update — needs login

```bash
actual adr update <id> --level <policy id>=SHOULD
actual adr update <id> --policy "<policy id>=MUST: Services store relational data in Postgres." --policy "MAY: Jobs read a replica."
```

Changes the title, context, policies, levels or scope, and saves the whole decision as the web app's editor does. `--policy` gives the whole list after the change: prefix a policy's id and `=` to keep it, and leave one out to remove it. `--level` can't be combined with `--policy`. `--context ''` clears the context. A blank `--title`, or a policy with no statement, is refused before anything is sent (exit `1`), and an archived decision can't be changed until it's restored. Editing the list can change policy ids, so take them from this command's output or `adr show` before the next edit. `--json`: `update` (`success`, `adr_id`) and the saved `decision`, or `read_back_problem` when the change was saved but reading it back failed.

### adr publish, unpublish, delete, restore, accept and reject — need login

```bash
actual adr publish <id>
actual adr reject <id> --reason "Covered by the gateway client decision"
```

`publish` makes a draft govern and `unpublish` moves an active decision back to draft. `delete` archives an active decision or a draft, as Delete does in the web app, and `restore` returns an archived one to the list it came from; nothing deletes permanently. `accept` and `reject` act on a suggestion, either a new decision or a suggested change to an active one, and `reject` needs `--reason`, up to 10,000 characters. Each command reads the decision's state first and sends nothing when the state doesn't allow the change (exit `3`). A grouped draft can't be published yet, and a grouped decision can't be restored yet. The next `actual adr refresh` brings the repository's rule files in step with the change, and Actual AI's sync pull request writes the same files. `--json`: `success` and `adr_id`, plus `reason_saved` on `reject`.

Exit codes for every `adr` command: `1` a check failed (the save check, a `--policy` or `--level` value that doesn't parse, a blank `update --title` or policy statement, Actual AI's refusal of the content, `adr check`, `create`'s duplicate refusal, or a file `create --all` didn't save), `2` signed out, a command or flag the pathway can't take (such as `create --file` signed out), no access to the decision, no connected repository could be chosen, or a value refused while the command line is read (such as a blank `--reason`), `3` Actual AI unreachable or another API error, no decision with that id, a change the decision's state doesn't allow, or a `create` whose outcome is unknown, and `5` a local file couldn't be read or written. The CLI's [ADR command reference](https://github.com/actual-software/actual-cli/blob/main/docs/ADR_COMMANDS.md) has the rest.

## Plan- and Implementation-Stage Governance (Claude Code and Codex hooks)

This plugin ships hooks that check an implementation plan, and separately the diff an
agent actually produces, against the ADR rules committed in the repository. Claude
Code registers them from `hooks/hooks.json` automatically on install, with no manual
setup. Codex registers the same scripts from `hooks/codex-hooks.json` and runs them
once the user has trusted them in `/hooks`; see "Codex hooks" below for what differs
there. The table describes Claude Code.

| Hook | Event | What it does |
|------|-------|--------------|
| `hooks/preflight.sh` | `SessionStart` (`startup`, `resume`, `clear`, `compact`, `fork`) | Bootstrap preflight, silent and without running the CLI unless the repository has rules. It reports whether the `actual` CLI is installed, and compares `actual --version` with the minimum the plugin declares (`MIN_CLI_VERSION` in `hooks/lib/bootstrap.sh`). On an older CLI it asks the agent to offer the upgrade: the command `actual version --json` names for the channel that installed it, when it is one of the two commands actual-cli uses, the actual-releases page for a CLI installed some other way, or both the npm and Homebrew commands otherwise. Below `GATES_MIN_CLI_VERSION`, where a check stops running in full, the offer interrupts the task when the session starts (`startup`), and every later SessionStart repeats the news with the offer at a pause, asking the agent not to repeat it after a no. From that floor up it follows the report that governance is active, at a pause. A CLI whose `actual --version` fails runs no check, so it interrupts with the npm and Homebrew reinstall commands instead. The install and reinstall offers interrupt at every SessionStart, and ask the agent not to repeat them after a no. Each CLI call gets `CLI_CALL_TIMEOUT` seconds, and a `--version` that takes longer prompts nothing. When the rule files carry a YAML header (ADR header v2) and the CLI is too old to read it, it reports that instead (see "ADR header v2 rule files"). Re-runs after compact so the reminder survives summarization |
| `hooks/plan-gate.sh` | `PreToolUse` on `ExitPlanMode` | The plan/implementation boundary. Hands the plan to `actual plan-check` and blocks a non-conforming plan |
| `hooks/plan-approval.sh` | `PermissionRequest` on `ExitPlanMode` | Unattended mode only (`ACTUAL_UNATTENDED=on`, or the `unattended` row under `/plugin`): answers Claude Code's plan dialog with allow and the request's `tool_input` echoed back as `updatedInput`, so an agent nobody is watching is not held there. It runs after `plan-gate.sh`, which has already denied a conflicting plan, and approves in any repository, rules or not. Silent, which leaves the dialog in place, whenever the switch is off or `ACTUAL_PLAN_GATE=off` |
| `hooks/turn-start.sh` | `UserPromptSubmit` | Marks where each turn starts: runs `actual impl-check --claude-hook`, which on a `UserPromptSubmit` envelope records `HEAD` for the session, so the `Stop` check also covers work the agent commits, or commits and pushes, during the turn. Silent on every path, since this event's stdout is added to the prompt. Without it, the check diffs against `HEAD`. The dispatch needs CLI 0.7.0 or later, and on an older CLI the call would run a full check on every prompt, so the hook first checks that `actual impl-check --help` names `UserPromptSubmit` and does nothing when it doesn't |
| `hooks/impl-gate.sh` | `Stop` | The end-of-turn checkpoint (AK-754). Hands the turn's accumulated working-tree diff (tracked changes plus untracked, non-ignored files, against the commit `turn-start.sh` recorded when the turn began, or `HEAD` when none was) to `actual impl-check` and forces the agent to continue on a non-conforming diff. Fires **unconditionally, every turn** — never gated on `plan-gate.sh` having run earlier in the session, so a turn that skips plan mode entirely is still governed |
| `hooks/rules-brief.sh` | `PostToolUse` on `Read`, `PreToolUse` on `Edit\|Write` | Read-time briefing (AK-793) and the write-time reminder (AK-794), for versions of Claude Code that cannot load a mod. Hands the envelope to `actual rules brief --claude-hook` and forwards only an allowlisted `additionalContext` reply naming the event it was called for. Advisory: never denies, never decides, silent on any failure; on `PreToolUse` it names no `permissionDecision`, so the normal permission flow is unchanged. **Where the mod loads it stands down**: the mod passes `classic.PostToolUse` (Read) on with an `actual_rules_brief_by_mod` marker, and for Edit and Write sets `ACTUAL_SKILL_MOD_SESSION` to its session id before the hook runs, which the hook inherits and stands down on when it matches its own `session_id`. The mod writes no files. Edit and Write cannot carry a marker: the tool's arguments are what the permission check judges, and auto mode refuses to judge a Write with a field it does not know. Either way the brief is delivered once, by the path that also has a budget and a record, and every other hook on those events still runs. It has no budget, no session cap and none of the four limits below: it forwards none of them |
| `hooks/session-end.sh` | `SessionEnd` | In a repository with rules, forwards the shutdown envelope to `actual __session-ended`, which records the session id, coarse end reason and last completed hook check's blocking state. Silent and fail-open on every path, including missing or older CLIs. It performs no install, version probe or network wait; the companion CLI release must ship before this hook can report end events. The CLI honors telemetry opt-out. Killed sessions still rely on the inactivity fallback |
| `hooks/register.js` | Claude mod, `$.ui.log` per read and a `/rules-brief` pane | What briefing did, for the person watching. One line per read names the ADRs and rule counts; a read that briefed nothing says why (nothing new, budget spent, CLI error), from the reason the CLI names on stderr. A read of only ungoverned files reports nothing, since most files are ungoverned. `/rules-brief` lists the session oldest first, because a suppressed row only makes sense after the delivered row it refers to. The model reads none of it, so none of it is charged against the context budget — and nothing is reported in `claude -p`, the SDK, the VS Code chat panel or a cloud session |
| `hooks/register.js` | Claude mod, `tool.call` on `Bash`, `Read`, `Edit` and `Write` | Briefing for both the Read tool and reads that bypass it. Measured across 212 local sessions, 80% of file reads went through `cat`/`head`/`sed -n`/`grep`, which fires no Read hook. Briefs only a Bash command Claude Code reports as `isReadOnly`, in the call's context beside its output. `Edit` and `Write` are briefed as a reminder for a file never read (AK-794): it lands with the tool result, after the write, and a file already briefed by its read adds nothing and reports nothing. Requires Claude Code 2.1.287+, or 2.1.285/2.1.286 with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` |
| `hooks/register.js` | Claude mod, `session.start`, `tool.call` (a `Read`, `Bash`, `Edit` or `Write` that is briefed or reaches an ungoverned file), `turn.complete` (main loop), `classic.SessionStart` (all but `startup`) and `ui.render` on `AbovePrompt` | The band above the prompt, showing the `line` of `actual session summary --session <id> --rules-dir <dir> --json` as given, such as `Actual AI: 3 of 12 ADRs added to context · 2 areas with no ADR` or `Actual AI: no ADR covers the 3 areas you worked in`. Read for the rules directory briefing uses, in the background at session start, after each read or write the mod briefs, after a read or write the CLI reports ungoverned (which can add an area, and a burst of which shares one call), after each main-loop turn, and on `/clear`, compaction, resume and fork. The ADR count can include the decisions of the one brief the session budget withheld, which the CLI recorded before the mod held it back. Empty with no rule files, no decision in them, no CLI or one too old to write the line, or `ACTUAL_CLI_SUBPROCESS=1`. Drawn in the terminal and the desktop app, and the model never reads it |

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

### Codex hooks

`.codex-plugin/plugin.json` names `hooks/codex-hooks.json`, so Codex never reads
Claude Code's `hooks/hooks.json` (whose `modules` key its parser rejects). Every
command there runs a shared script with `ACTUAL_HOOK_HOST=codex`, which
`hooks/lib/bootstrap.sh` reads to pick the CLI flag (`--codex-hook`), the output
shapes and the wording; unset, everything behaves as in Claude Code.

| Hook | Event | What differs from Claude Code |
|------|-------|-------------------------------|
| `preflight.sh` | `SessionStart` (all five sources) | The same ladder, plus one rung: a CLI without the `codex-hook` capability marker (`actual plan-check --help`, cached per binary like the ADR header v2 probe) gets the upgrade offer, as an interrupt at `startup` and at a pause afterwards, and the Claude Code version minimums are not asked. On `compact` and `clear` it runs `actual rules brief --codex-session-start`, which resets what the session has been briefed, as the mod does in Claude Code. The offers name no Claude Code tool: Codex's default mode has no question tool, so the agent is asked to put the question in its reply and end its turn on it |
| `turn-start.sh` | `UserPromptSubmit` | `impl-check --codex-hook`; probes for `codex-hook` instead of the `UserPromptSubmit` dispatch. Unlike Claude Code, the CLI's reply is forwarded, and it is one of two shapes. After a check stopped the last turn, it is `additionalContext` handing the agent the conflicts with the user's message. For a typed `actual override <rule-id\|all> [code] [reason]` (or `/override`), the override is recorded and the reply is `{"continue":false,"stopReason":…}`, which keeps the prompt from the agent and tells the user what was overridden. The CLI records nothing when the hook's environment carries `CODEX_THREAD_ID` or `CODEX_SESSION_ID`, which the agent's own shell commands have |
| `rules-brief.sh` | `PostToolUse` on `Bash`, `PreToolUse` on `Edit\|Write` | Codex has no Read tool. On `Bash` the CLI briefs the files a read-only command names (`cat`, `head`, `tail`, `sed -n`, `grep`, `rg`, `nl`, `wc` and similar, after a leading `cd`; no output redirection, no command substitution, at most two files). `Edit\|Write` is the alias Codex matches `apply_patch` by, and the CLI briefs the files the patch adds or updates, before it applies. No mod stands this down. The hook passes `--max-session-chars` (`ACTUAL_RULES_BRIEF_MAX_SESSION_CHARS`, default 48000) and the other four limits when they are plain numbers, and the CLI enforces the cap and says once when it is spent. The CLI's reply opens with a `systemMessage`, such as `Actual AI: briefed 2 ADRs · 7 rules · src/a.ts`, because Codex shows `additionalContext` to the model only and has no mod to write a transcript row; Codex shows the line to the user and keeps it out of the model's context. `ACTUAL_RULES_BRIEF_NOTICE=off` passes `--no-brief-notice`, which drops it |
| `plan-gate.sh` | `Stop` | Codex has no `ExitPlanMode`. The hook runs on every `Stop` and `actual plan-check --codex-hook` reads the turn's mode and plan from the rollout at `transcript_path`: outside Plan mode it prints nothing. The hook passes `--codex-ask` (see `impl-gate.sh`), so a conflicting plan ends the turn with `{"continue":false,"stopReason":…}` and waits for the user. Without the flag it gets `{"decision":"block","reason":…}` and the agent revises it in the same turn. Either way the user has seen the first draft. Silent on a missing, unreadable or too-old CLI, which `impl-gate.sh` reports on the same `Stop` |
| `impl-gate.sh` | `Stop` | `impl-check --codex-hook`, which skips a Plan-mode turn. Its reply is already Codex's `Stop` shape, so it is forwarded after the check below rather than re-rendered. Codex has no mod to raise the denial dialog, so the hook passes `--codex-ask`: a conflict ends the turn with `{"continue":false,"stopReason":…}`, which lists the conflicts and the two answers (reply to revise, or type `actual override …`). The CLI keeps the conflicts for `turn-start.sh` to hand to the agent with the next message. A stop outranks a block from the other `Stop` hooks. Under `ACTUAL_UNATTENDED=on` or `ACTUAL_OVERRIDE_DIALOG=off` the flag is left out, and a conflict is a `{"decision":"block"}` that sends the agent back at once. The hook also passes `--codex-picker` unless `ACTUAL_CODEX_PICKER=off`. The CLI then reads the rollout's tool list: when `request_user_input` works in the turn's mode (Plan always, Default with Codex's `default_mode_request_user_input` feature), the conflict is instead a `{"decision":"block"}` telling the agent to show the user a picker. `gate-answer.sh` reads the answer. A picker that goes unanswered over the same diff or plan ends the turn with the text stop at the next check, without judging again. On a CLI without `codex-hook` it stands down with a one-line notice |
| `gate-answer.sh` | `PostToolUse` on `request_user_input` | Codex only. With the picker (below), the gates send the agent back with the exact `request_user_input` call to make, and this hook hands the result to `impl-check --codex-hook`. The CLI accepts only answers to question ids it issued (`actual_choice_<nonce>`, `actual_reason_<nonce>`), never with `CODEX_THREAD_ID` or `CODEX_SESSION_ID` set. It replies with the agent's next step as PostToolUse `additionalContext`: the conflicts to fix (Revise), the "why" picker to show (Override), or, after the why answer, that the rules were overridden (source `session_dialog`) and the turn should end. An envelope with no gate question id spawns no CLI |
| `session-summary.sh` | `Stop` | Codex only. `actual session summary --codex-hook` prints the summary line as `{"systemMessage":…}` when it changed since it was last shown; Codex shows it to the user and never to the model. `ACTUAL_RULES_BRIEF=off` silences it |

There is no `SessionEnd` registration, no transcript row and no `/rules-brief`
pane: Codex gives a hook no way to write either (the brief's `systemMessage` line
stands in for the row), and its session-end event is not covered yet. Settings are environment variables only, since Codex has no
per-plugin `userConfig`.

**Codex hook contract.** Codex parses hook output strictly: a key it does not know
fails the hook run, which is why Claude Code's notice shape, with its nested
`hookSpecificOutput.systemMessage`, is never sent there. The CLI's `--codex-hook`
replies are flat, so `forward_codex_reply` in `bootstrap.sh` pins each one whole —
the exact opening bytes, the exact closing `"}` and a single JSON string between —
and forwards only `{"decision":"block","reason":"…"}` (the gates without
`--codex-ask`), `{"continue":false,"stopReason":"…"}` (the gates with it, and
`turn-start.sh` for a typed override), `{"systemMessage":"…"}` (the gates'
notices and the summary), or `turn-start.sh`'s
`{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"…"}}`,
or `gate-answer.sh`'s same shape with `"PostToolUse"`.
Each caller names the shapes it accepts. A stop or context with an empty string
is dropped. A brief keeps Claude
Code's `{"hookSpecificOutput":{"hookEventName","additionalContext"}}`, which Codex
accepts, optionally preceded by a top-level `"systemMessage":"…"`. `rules-brief.sh`
splits that line off at the first `","hookSpecificOutput":` (a JSON string cannot
contain one unescaped), requires it to be a single JSON string with no unpaired
trailing backslash, and runs the brief's own checks on what is left; under Claude
Code a reply carrying the line is dropped. A reply with a `\uXXXX` escape is refused with a notice, as the Claude Code
gates refuse one; a block with an empty reason blocks with a fixed reason. Exit 2
still blocks, with stderr as the reason.

Codex runs the three `Stop` hooks at once. Only one gate touches the session's
governance state on a given turn, because `plan-check` returns before reading it
outside Plan mode and `impl-check` returns before reading it in Plan mode. A block
starts a continuation in the same turn, on which every `Stop` hook runs again.

Codex records hook trust against the plugin's whole content, so each release asks
the user to review the hooks again (see CONTRIBUTING.md).

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
  can type `/actual-cli:override` in the session (`actual override` in Codex, or
  run `actual check-override` from a terminal) to wave a specific rule through
  outright.
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

All hooks are silent no-ops (no output, exit 0) unless the resolved rules directory has at least one `*.md` file. By default that directory is `.actual/rules/`; `ACTUAL_RULES_DIR` can select another. Installing the plugin therefore has no effect on repositories that are not governed by Actual.

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
The plugin's one approval is `plan-approval.sh`'s, given only once the user turns on
unattended mode. It answers Claude Code's `PermissionRequest` for `ExitPlanMode`, after
the gate has run, with allow plus `updatedInput` set to the request's own `tool_input`:
the form Claude Code's hooks guide documents for this dialog, which ignores an allow
without `updatedInput`. Measured on 2.1.287 and 2.1.322, it approves with no dialog and
the session returns to the permission mode it had before planning.

### ADR header v2 rule files

A file in `.actual/rules/` may open with a YAML header (`---` on its first line)
carrying `adr_id`, `root`, `paths` and the like. The plugin never parses it. It counts
`*.md` files exactly as before, and the CLI reads the header to decide which decisions
govern a file. Files without a header are still the original format, and a repository
can hold both.

The CLI must be 0.9.0 or later to read the header. `rules brief --help` names the
capability marker `adr-header-v2` on a CLI that does, and the hooks probe for that
literal rather than comparing versions. A repository with a headed rule file and a CLI
without the marker is the one state that changes anything:

- `preflight.sh` emits an upgrade message (an instruction to the agent, escalated like
  the `plan-check` and `impl-check` ones) instead of the success message.
- `plan-gate.sh` and `impl-gate.sh` fail open with a one-line notice naming the
  upgrade, and run no check.
- `rules-brief.sh`, `turn-start.sh` and the mod's briefing stand down silently (the mod
  logs one `OLD CLI` row a session), because a brief built from the wrong scope would
  mislead and a notice on every read would be noise.

v1 repositories, and every CLI that names the marker, behave exactly as before. The
override syntax `<doc-slug>::<rule-id>` is unchanged.

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
| `ACTUAL_PLAN_GATE=off` | Disable all of this plugin's governance hooks (`plan-gate.sh`, `plan-approval.sh`, `impl-gate.sh`, `turn-start.sh`, `rules-brief.sh`, `session-end.sh`, `session-summary.sh` and `preflight.sh`, including its minimum-version check) |
| `ACTUAL_RULES_DIR` | Govern against a different rules directory (e.g. a subproject in a monorepo). The governance checks and briefing forward the resolved path to the CLI as `--rules-dir`; `session-end.sh` uses it only to check applicability. `plan-check`/`impl-check` must honor that flag rather than rediscovering rules from cwd |
| `ACTUAL_PLAN_CHECK_MAX_ROUNDS` | Override `plan-check --claude-hook`'s round limit (default 3). Independent of the variable below — the two commands' revision loops are budgeted separately, even though they share session state |
| `ACTUAL_TURN_START_LOG` | Path of a file `turn-start.sh` appends the CLI's output and exit status to, for diagnosing a turn-start record that is never written, or a `skipped` line when the CLI has no `UserPromptSubmit` dispatch. Unset by default, which keeps the hook fully silent; set, the hook is still silent on stdout and stderr |
| `ACTUAL_IMPL_CHECK_MAX_ROUNDS` | Override `impl-check --claude-hook`'s round limit (default 3) |
| `ACTUAL_OVERRIDE_DIALOG=off` | Stop the mod asking the user how to handle a `plan-check` or `impl-check` denial: the agent reads the denial as the CLI wrote it and revises on its own. A typed `/actual-cli:override` still works. In Codex, it stops the gates passing `--codex-ask`, so a conflict sends the agent back instead of ending the turn; a typed `actual override` still works. On by default; `=on` forces it on over the `overrideDialog` row, except in unattended mode, which always turns it off |
| `ACTUAL_CODEX_PICKER=off` | Codex only: keep the gates from passing `--codex-picker`, so a conflict always ends the turn with the typed choices, even where the agent could show a picker |
| `ACTUAL_UNATTENDED=on` | Unattended mode, for an agent nobody is watching: `plan-approval.sh` approves every plan that reaches Claude Code's plan dialog, which is a plan `plan-gate.sh` passed or could not check, in any repository; the mod's denial dialog is off whatever `ACTUAL_OVERRIDE_DIALOG` says. In Codex it leaves out `--codex-ask` the same way, so a conflict sends the agent back rather than waiting for someone. Off by default; `=off` forces it off over the `unattended` row. Never set it where a person reviews plans |
| `ACTUAL_RULES_BRIEF=off` | Disable briefing alone — both the `Read` hook and the mod, and in Codex the briefing hook and the summary line — while `plan-gate.sh` and `impl-gate.sh` keep running. Briefing is the only path that fires on every read, so it is the only one whose cost is worth dropping on its own |
| `ACTUAL_CLI_SUBPROCESS=1` | Set by actual-cli on the nested `claude -p` it runs as its conformance judge. Every hook and the mod exit silently when it is set: without it the judge's own `Stop` hook reruns `impl-check` and recurses, and briefing would inject rules into the judge's prompt that it was never asked to weigh |
| `ACTUAL_HOOK_DEBUG=1` | Report what briefing did, on stderr for the hook and in the transcript plus the model's context for the mod, which also adds a note when it does not brief: the resolved rules directory, the CLI's exit status and stderr, the reason a reply was dropped, and the characters injected so far against the session cap. Diagnostic only — it never changes a forwarding decision |
| `ACTUAL_RULES_BRIEF_MAX_SESSION_CHARS` | Characters of rule context briefing may inject in one session before it stops and says so (default 48000). Measured basis: 40 governed files against a 425-rule repository injected 18,751 characters with dedup active, so the default is ~2.5x an ordinary session. `0` disables briefing where the mod loads; `rules-brief.sh` enforces no cap under Claude Code, and under Codex passes it to the CLI as `--max-session-chars`, which enforces it |
| `ACTUAL_RULES_BRIEF_LIMIT`, `_RULES_PER_DECISION`, `_MAX_CHARS`, `_MIN_SCORE` | Forwarded by the mod to `actual rules brief` as `--limit`, `--rules-per-decision`, `--max-chars`, `--min-score`, and only when set (`rules-brief.sh` forwards them only under Codex, and only when each is a plain number), so the CLI keeps owning its own defaults. `_MIN_SCORE` especially: unset it defers to the repository's `rules_min_score`, and a score measures how narrowly a rule's `verify` glob is written rather than how relevant the rule is, so no cross-repository default is correct |

The briefing limits (`ACTUAL_RULES_BRIEF_MAX_SESSION_CHARS`, `_LIMIT`,
`_RULES_PER_DECISION`, `_MAX_CHARS`, `_MIN_SCORE`), `ACTUAL_OVERRIDE_DIALOG`
(as `overrideDialog`), `ACTUAL_UNATTENDED` (as `unattended`) and `debug` also
appear as labelled `userConfig` rows under `/plugin`; the other variables have
none. The mod reads all of the rows, and `plan-approval.sh` also reads
`unattended`, from the `CLAUDE_PLUGIN_OPTION_UNATTENDED` that Claude Code
exports to every hook once the row has a value. An environment variable wins over its
row: the row is the durable preference, the variable is the override for one
session. The exception is `debug`, which is ORed with `ACTUAL_HOOK_DEBUG`
rather than overridden by it.

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

### Briefing: two paths, one dedup store

Briefing is delivered by `hooks/rules-brief.sh` on `Read` and `Edit|Write` where
no mod loads, and by the mod on `Bash`, `Read`, `Edit` and `Write` where one
does, with the hook standing down for the events the mod owns. Both call `actual rules brief --claude-hook` rather than the simpler
`--file` direct mode, because only `--claude-hook` consults brief memory —
direct mode is stateless and returns the full brief every time. That is what
keeps a file read with the Read tool and then `cat` from being briefed twice.

The CLI names why it stayed quiet on **stderr**, as `no-brief=<token>`, with
tokens `ungoverned`, `already-briefed`, `outside-root`, `no-rules` and
`nothing-to-show`. That is the second interface between the two repositories,
and it exists because hook-mode stdout cannot explain itself: stdout carries
the brief the model reads, so any explanation printed there would be read as
governance. stderr reaches neither the model nor the user — the shell hook
keeps it for `--debug`, and the mod parses it.

Without it the two silences are indistinguishable, and the mod spent several
versions asserting whichever one it had guessed: `package.json,
pnpm-lock.yaml governed, already briefed this session`, for a lockfile nothing
governs. A mod reading a CLI too old to send a token falls back to naming both
possibilities rather than picking one.

Brief memory is keyed on **`(session_id, agent_id, rules_dir)`**, which makes
that key an interface between the two paths rather than an implementation
detail. Any component the two compute differently splits the key, and the
symptom is always the same: one read briefs twice, silently, and in a monorepo
the second brief is against the wrong rule set.

Two instances of that have already been fixed, both invisible at runtime:

- The mod did not forward `--rules-dir` at all. On a fixture whose root and
  subproject rule sets both match one file, the hook briefed the subproject's
  rule and the mod, same session, briefed the root's.
- The mod derived the rules directory from `$.session.root()`. No single mods
  API call matches `resolve_repo_root`: `$.session.root()` tracks the session's
  working directory, so it is right inside a worktree and wrong one directory
  below the repo root; `$.session.repo().root` is the main checkout, so it is
  wrong in exactly the opposite cases. A mod also cannot read
  `CLAUDE_PROJECT_DIR`, which Claude Code sets for hook processes only. The mod
  now runs `git rev-parse --show-toplevel` and applies the same deeper-of-the-two
  rule as `bootstrap.sh`, with the first `$.session.root()` it resolves, the
  directory the session was launched in, standing in for the variable. Claude
  Code keeps `CLAUDE_PROJECT_DIR` there through `/cd`, a worktree move and
  `/clear`, so a moved root decides only the cache key and where git runs. The
  answer is cached per session and `$.session.root()`, so a `/cd` or a worktree
  move resolves it again and a shell `cd` does not.

- The mod did not forward `agent_id`, the third component of the key. The Read
  hook's envelope carries it inside a subagent and the mod's event carries the
  same value as `e.agentId`, so the mod filed a subagent's reads under the
  parent's slot. This one causes *missed* briefs rather than duplicates: the
  subagent is denied a brief the parent already saw — which is precisely what
  keying on `agent_id` exists to prevent — and the parent's record is polluted
  with reads it never made.

A fourth divergence is not about the key but about the same question — which
directory a relative path belongs to. The Bash tool runs every command in one
persistent shell, so a `cd` in any call changes where every later call runs, and
on Claude Code 2.1.296 `$.session.cwd()` follows it. Session 9dc24b52 did `cd <repo>/apps/actual && ls lib/oauth/` and then
read `lib/oauth/verify-token.ts` twice; resolved against the session cwd those
became `<repo>/lib/oauth/...`, which does not exist, so the existence filter
dropped them and two briefs were lost. The mod keeps no copy of the shell's
directory: it reads `$.session.cwd()` before the call and joins a stated `cd`
onto that, since by the time the call returns the cwd already includes the `cd`.
Where no `cd` states a base it tries the live cwd, the session cwd and the repo
root in that order, letting the filesystem decide.
A `cd` the command *does* state is authoritative and gets no fallback, or
`cd /elsewhere && cat a.ts` would brief a same-named file inside the repository.

So when changing either path, change both. Check all four repository layouts —
a worktree with and without `CLAUDE_PROJECT_DIR`, a monorepo subproject named
by `CLAUDE_PROJECT_DIR`, and a session launched in a subdirectory — and the
`/cd` moves `hooks/register.test.ts` lists, since a `/cd` leaves
`CLAUDE_PROJECT_DIR` where the session started. Check both inside and outside a
subagent.

### `--claude-hook` diff resolution

Unlike plan text, there is no envelope field carrying the material to check — no
tool call injects a diff the way `ExitPlanMode` injects a plan. `actual impl-check
--claude-hook` always resolves the diff from the working tree in the resolved
repository root: tracked changes plus untracked files that are not gitignored,
against the commit the turn started from. `hooks/turn-start.sh` records that commit
on `UserPromptSubmit`, so work the agent committed, or committed and pushed, during
the turn is still checked at `Stop`. When no commit was recorded, or it is no longer
an ancestor of `HEAD` (an amend, rebase or branch switch during the turn), the diff
is against `HEAD`. A file the agent has written but not `git add`ed is part of that diff.
Gitignored files stay out. The hook envelope
(`hooks/tests/fixtures/stop-turn.json` is the recorded shape) is forwarded unparsed
purely to key the revision-loop session off `session_id`, the same way
`plan-check`'s envelope is. An empty diff (nothing changed since that commit and there
are no untracked, non-ignored files) is not an error — it is the ordinary "nothing
changed this turn" case — and degrades to a non-blocking notice, never a deny.

The hook always invokes `actual impl-check --claude-hook --rules-dir <dir>`, same
`<dir>` resolution as `plan-check`'s.

### Requirements

The hooks need the `actual` CLI at the version `MIN_CLI_VERSION` names in
`hooks/lib/bootstrap.sh`, or newer. In a repository with rules, `preflight.sh`
compares `actual --version` with it at `SessionStart` and on an older CLI asks the
agent to offer the upgrade. The command comes from `actual version --json`, which
names the one for the channel that installed the CLI without making a network
request. The agent runs it on a yes, so it is passed on only when it is one of the
two actual-cli uses, compared whole: `brew upgrade actual-software/actual/actual`, or
`npm install -g @actualai/actual` with or without `@latest`. Any other answer, and a
CLI older than that subcommand, gets both the npm and Homebrew commands, with a way
to tell which one installed it, since running the other would leave a second copy on
`PATH`. A CLI installed some other way gets the actual-releases page.

Under Codex the requirement is the `codex-hook` capability instead, first shipped in
actual-cli `CODEX_HOOK_MIN_CLI` (0.15.0). `preflight.sh` probes for the marker in
`actual plan-check --help` rather than comparing versions, so a build that has it
passes whatever its version reads, and one without it gets the same upgrade offer,
with the same command selection, while every other Codex hook stands down.

The offer interrupts the task only on a CLI older than `GATES_MIN_CLI_VERSION`, the
oldest release every check runs in full on, and only when a session starts. On a CLI
older than 0.7.0, the `Stop` check misses work committed during a turn, because
`turn-start.sh` needs that release's `UserPromptSubmit` dispatch. SessionStart fires
again on resume, clear, compact and fork, and each of those repeats the news with the
offer at a pause, asking the agent not to repeat it once the user has declined. A CLI
between that floor and `MIN_CLI_VERSION` runs every check, so the agent is told
governance is active and offers the upgrade at a pause.

A CLI that is on `PATH` but fails `actual --version` runs no check at all, which is
how npm's launcher behaves when its platform package is missing. Where rules are
committed, `preflight.sh` interrupts with the reinstall commands for both channels,
`npm install -g @actualai/actual` and `brew reinstall actual-software/actual/actual`,
and a way to tell which one installed it. Like the install offer for a CLI missing
from `PATH`, it interrupts at every SessionStart and asks the agent not to repeat it
once the user has declined. A `--version` that succeeds but names no
version prompts nothing, and neither does one still running after `CLI_CALL_TIMEOUT`
seconds, since a slow machine is not a broken install. `version --json` has the same
bound, and the two commands stand in for an answer that does not arrive.

A CLI too old for `plan-check` or `impl-check` is also caught where those run: the
relevant gate emits an upgrade message instead of a flag error. In `impl-gate.sh`
that is a one-line warning, because Stop's `systemMessage` is shown to the user and
does not reach Claude; the instruction to the agent is the SessionStart text above.

| Feature | Minimum `actual` | Probe |
|---------|------------------|-------|
| `plan-check` (plan gate) | earlier releases; any current CLI has it | `actual plan-check --help` |
| `impl-check` (Stop gate) | earlier releases; any current CLI has it | `actual impl-check --help` |
| Turn-start marker | 0.7.0 | `actual impl-check --help` names `UserPromptSubmit` |
| `rules brief` (briefing) | earlier releases; any current CLI has it | `actual rules brief --help` |
| Rule files with a YAML header (ADR header v2) | 0.9.0 | `actual rules brief --help` names `adr-header-v2` |

A repository with headed rule files and a CLI below 0.9.0 gets an upgrade instruction at `SessionStart`,
and each gate prints this instead of running a check:

> Actual governance stood down: .actual/rules/ uses the ADR header v2 format, which the installed `actual` CLI is too old to read (needs 0.9.0+), so this plan was not checked against them. Upgrade with `npm install -g @actualai/actual@latest` or `brew upgrade actual-software/actual/actual`.

(`impl-gate.sh` says "this turn's diff was not checked against them".)

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
- **An explicit, recorded override.** A human — never the agent — clears a rule.
  When a gate denies, the plugin's mod (`hooks/override-dialog.js`, wired in
  `hooks/register.js`) asks the user in Claude Code's own select dialog:
  revise to conform (first, and recommended), or override all the blocking
  rules (single rules are overridden by typing the command). After an
  override, a second question asks why, and the choice becomes the override's
  code: the check misread the change (`misread`), the ADR doesn't apply here
  (`not-here`), the ADR is wrong (`adr-wrong`), or it is out of date
  (`adr-outdated`). The user types `accepted` under Other when the block is
  right and they are going ahead anyway; anything else typed there is kept as
  the reason, which actual 0.14.0 or later stores with the code `other` and
  may send to Actual with anything that looks like a secret removed, so the
  user shouldn't type one there. Dismissing either question overrides
  nothing. The answers go to the mod, not to the agent.
  What reaches the agent says what the user chose:
  - **"The user chose to revise …"**: revise the plan or the code to satisfy
    every rule in the denial. Do not suggest an override.
  - **"The user overrode … in the override dialog"**: those rules no longer
    block this session. If others still block, revise for those.
  - **"The user answered the override dialog: …"**: act on their words.
  - A denial still naming `/actual-cli:override` means the dialog was dismissed
    or could not be shown: relay the denial, revise if you can, and tell the
    user they can type the command.

  The user can also type `/actual-cli:override <rule-id|all> [code] [reason]`
  as a message at any time. The code is one of the five above, and both it and
  the reason are optional; a reason that starts with no code is stored as
  `other`. Always give the user that full
  name: Claude Code registers plugin commands only under their namespaced
  name, so a bare `/override` is rejected as an unknown command. The mod
  records it from the prompt, which Claude Code stamps as typed, and adds a
  context line naming what was overridden, or why nothing was. Both paths go
  through `actual check-override --claude-hook`, which refuses any process
  carrying `CLAUDECODE` — every agent shell command and every settings hook —
  so only the mod's own spawn records. **If the user asks to override a rule,
  tell them to pick it in the dialog or type `/actual-cli:override` themselves;
  never type it or run `actual check-override` on their behalf, and do not
  suggest an override as a way past a denial you could fix by revising.** The
  same override can still be
  issued from an ordinary terminal with `actual check-override --session <id>
  --rule <doc-slug>::<rule-id> --reason-code <code> --reason "<why>"`
  (`--reason-code` needs actual 0.14.0 or later, and a `--reason` without it is
  stored as `other`; `--reason` is required through v0.12.0; it refuses to run non-interactively; `plan-check-override` is a backward-compatible alias;
  pass `--repo`/`--rules-dir` if you are not in the repo the denial came from).
  An overridden rule is excluded from judging from then on regardless of plan
  or diff text — by both commands, since they share session state — and every
  subsequent round says so in a non-blocking notice — an override is visible,
  never a silent bypass. Each override is recorded with `source`
  (`session_dialog`, `session_prompt` or `terminal`) and `gate` (`plan`,
  `impl`, or `both`).
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
against recorded hook payloads and a fake CLI, for `plan-gate.sh`, `plan-approval.sh`
and `impl-gate.sh`, under Claude Code and, from `hooks/tests/codex.sh`, under Codex with
the envelopes captured from Codex CLI 0.167.0. No network and no real `actual`
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

## adr-bot and the Advisor (on request)

Run `actual adr-bot` only when the user asks for it, or for ADR guidance written into `CLAUDE.md`, `AGENTS.md` or Cursor rules, and `actual advisor` only when the user asks for the Advisor. Neither is part of governance. Their full reference is in the actual-cli docs: https://github.com/actual-software/actual-cli/blob/main/docs/ADR_BOT_AND_ADVISOR.md. The adr-bot workflow follows in Non-Interactive Environments, Sync Quick Reference and Operational Workflow: Running Sync, with its files in Output Formats.

**Endpoint config** — `advisor` reads `--api-url <url>`, then `ACTUAL_API_URL`, then defaults to `https://api-service.api.prod.actual.ai`.

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
| 1 | General / runtime | RunnerFailed, RunnerOutputParse, ConfigError, RunnerTimeout, AnalysisEmpty, TailoringValidationError, InternalError, TerminalIOError, AdrInvalid, AdrCheckFailed, AdrDuplicate |
| 2 | Auth / setup | ClaudeNotFound, ClaudeNotAuthenticated, CodexNotFound, CodexNotAuthenticated, CursorNotFound, ApiKeyMissing, CodexCliModelRequiresApiKey, NotLoggedIn, AdrAccessDenied, AdrRepoRequired |
| 3 | Billing / API | CreditBalanceTooLow, ApiError, ApiResponseError, AdrCreateUnconfirmed, AdrNotFound, AdrNotAllowed, AdrNotSaved |
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

For anything not covered by this skill or its reference files, fetch the CLI documentation:

- **Full docs (Markdown)**: https://cli.actual.ai/docs.md — the command reference for the checks, `rules`, `check-override` and sign-in, with flags, runners, config keys, and troubleshooting
- **LLM summary**: https://cli.actual.ai/llms.txt — concise machine-readable overview
- **adr-bot and the Advisor**: https://github.com/actual-software/actual-cli/blob/main/docs/ADR_BOT_AND_ADVISOR.md — their full reference
