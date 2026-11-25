---
name: adr-bootstrap
description: >-
  Propose a repository's foundation set of Architecture Decision Records
  (ADRs) with the actual CLI. Surveys the code and any files under docs/adr/
  and, once the user agrees, this checkout's Claude Code or Codex sessions,
  and drafts each decision that warrants an ADR. The user picks which to
  create, and the adr-draft skill creates each pick: signed out an accepted
  file in docs/adr/, signed in a decision in Actual AI. The whole repository
  is the default; the last N commits or this session narrow it, and
  "sessions" proposes up to five from the last seven days of sessions alone.
  Use when asked to bootstrap, seed or set up a repository's ADRs, to find
  the decisions in a repository, its recent commits, this session or past
  sessions, when a repository has no decisions yet, or when the actual CLI's
  refresh recommends adr-bootstrap. When that recommendation is all that
  prompted it, offer the survey to the user and run it only once they agree.
  Don't use it for a single ADR (adr-draft does that) or to review code.
---

# Bootstrap a repository's ADRs

Survey a repository for the decisions it already follows and propose a foundation set of ADRs: the conventions and constraints future code should keep to. The person picks which to create, and the adr-draft skill creates each pick. Signed out, that's an accepted file in `docs/adr/` with its rule file in `.actual/rules/`, which `plan-check` and `impl-check` enforce at once. Signed in, it's a decision in Actual AI, accepted or a draft as the person picks. Nothing is created before the person answers.

## A recommendation from the CLI

`actual adr refresh` recommends this skill when it finds no decision governing the repository. When that recommendation, not the person, brought you here, don't start the survey. Tell the person the repository has no decisions yet, offer the survey in one question, and go on only on a yes. After a no, don't offer it again in the session.

Signed in, the same refresh can also list files under `docs/adr/` that aren't in Actual AI yet and say `actual adr create --all` sends them. Don't run it on your own: it sends the person's `docs/adr/` files to Actual AI, so it waits on their yes, as adr-draft's "Files in docs/adr/ that Actual AI doesn't have" section describes.

## Check the CLI and adr-draft

```bash
command -v actual && actual --version
```

Creating needs actual 0.17.0 or later. Offer to install or upgrade it as the adr-draft skill does, and without it, draft and show the ADRs but create none.

This skill drafts to adr-draft's rules and creates through its steps. Load the adr-draft skill now (in Claude Code through the Skill tool, in Codex with `$adr-draft`) and keep its instructions for the steps below, without starting its own flow. When it isn't installed, say so and that the plugin, or `npx skills add actual-software/actual-skill`, brings it, and stop before creating anything.

## Scope

- **No argument, or the whole repository.** The default: the code, the files under `docs/adr/` and, once the person agrees, this checkout's coding-agent sessions.
- **A number `N`, or "the last N commits".** Only what those commits changed:

  ```bash
  git log -N --stat        # replace N with the argument
  git diff HEAD~N..HEAD
  ```

  With fewer than `N` commits, use as many as exist.
- **"This session".** Only what changed in this session: the files edited and the decisions behind them. `git status` and `git diff` help.
- **"Sessions", or "my recent sessions".** The decisions settled in this checkout's Claude Code and Codex sessions from the last seven days, read as "Read this checkout's sessions" below describes. The person asked for that read, so don't ask before it, but tell them first that reading the sessions puts their text in your context, which reaches your model provider, and that no ADR will quote them. The code and the files under `docs/adr/` serve to ground each decision and to drop any that an ADR already covers, never as findings of their own, and the survey proposes at most five.

The last N commits and this session read no past sessions.

## Read the decisions the repository has

```bash
actual whoami                    # exit 0: signed in; exit 2: not signed in
actual adr list --json --limit 200
ls docs/adr/ .actual/rules/ 2>/dev/null
```

Signed out, `list` reads the decision files under `docs/adr/` that carry an ADR header and leaves the rest out. Signed in, it reads this repository's decisions in Actual AI; page on with `--offset` and the `next_offset` it returns. Read every file under `docs/adr/`, headed or not, and open the related decisions with `actual adr show <id> --json`. Don't propose a decision that `list` shows.

A file under `docs/adr/` with no ADR header records a decision in another format, which no check reads, so it still needs an ADR. Count it as an intent and draft its decision to adr-draft's rules, naming the file it came from. A file under `docs/adr/drafts/` gets the same treatment, header or not, since `list` leaves that folder out and its files get no rule file. Whether to keep the old file once the new ADR exists is the person's call.

Signed in, a file under `docs/adr/`, outside `docs/adr/drafts/`, with an ADR header that `list` doesn't show is a decision Actual AI doesn't have yet, such as one a signed-out `create` wrote. Don't propose it again. Sending such files is `actual adr create --all`, which sends the person's `docs/adr/` files to Actual AI, so never run it on your own: the report asks about them.

Keep the answer `actual whoami` gave: it decides where each pick is created.

## Read this checkout's sessions, once the person agrees

Past coding-agent sessions in this checkout often hold decisions the code doesn't show yet: a rule the person stated, a correction they made more than once, a trade-off they settled. So in the whole-repository survey, ask whether you may read them before you draft anything, saying what you'll read and that reading them puts their text in your context, which reaches your model provider, though no ADR will quote them. Ask in an interactive question where you have the tool (`AskUserQuestion` in Claude Code), and otherwise in your reply, ending your turn on it. Read none until they agree, and survey without them when they decline. In the sessions scope the person asked for this read, so tell them where the text goes, as Scope says, and don't ask. The last N commits and this session skip this step.

Read only the sessions recorded for this checkout, the folder `git rev-parse --show-toplevel` prints, and never another folder's, repository's or worktree's:

- **Claude Code** keeps them in `~/.claude/projects/` (`$CLAUDE_CONFIG_DIR/projects/` when that's set), in a folder named for the checkout's absolute path with each character other than a letter or digit turned into `-`, such as `-home-me-src-shop` for `/home/me/src/shop`. Each `<session id>.jsonl` file there is one session, one JSON object per line. Skip the folders beside them, which hold tool output. Two checkouts can share that folder, since `/home/me/src-shop` gets the same name, so read a file only when the first line that records a `cwd` names the checkout. The people's messages and the agent's replies are the text of the `user` and `assistant` lines:

  ```bash
  ROOT=$(git rev-parse --show-toplevel)
  ls -t "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(printf '%s' "$ROOT" | sed 's/[^A-Za-z0-9]/-/g')"/*.jsonl | while IFS= read -r f; do
    jq -n -e --arg root "$ROOT" 'first(inputs | .cwd? // empty) == $root' "$f" >/dev/null && echo "$f"
  done
  jq -r 'select((.type == "user" or .type == "assistant") and .isMeta != true and .isSidechain != true)
    | .message.content | if type == "string" then . else (.[] | select(.type == "text") | .text) end' <session file>
  ```

- **Codex** keeps them in `~/.codex/sessions/` (`$CODEX_HOME/sessions/` when that's set), in dated folders of `rollout-*.jsonl` files. Read only the files whose first line, a `session_meta` entry, names the checkout in `payload.cwd`. Their messages are the `response_item` lines whose payload is a `message` from the `user` or the `assistant`:

  ```bash
  ROOT=$(git rev-parse --show-toplevel)
  for f in "${CODEX_HOME:-$HOME/.codex}"/sessions/*/*/*/rollout-*.jsonl; do
    head -1 "$f" | jq -e --arg root "$ROOT" '.payload.cwd == $root' >/dev/null && echo "$f"
  done
  jq -r 'select(.type == "response_item" and .payload.type == "message" and (.payload.role == "user" or .payload.role == "assistant"))
    | .payload.content[]? | select(.type == "input_text" or .type == "output_text") | .text' <session file>
  ```

Without `jq`, read the same fields with any JSON reader. Start with the newest sessions and stop once new ones add nothing.

**The last seven days.** In the sessions scope, read only the files written in the last seven days, and only the messages from those days, so a session that began earlier adds just its recent part. Both tools stamp each message with its UTC time, such as `2026-11-24T01:53:26.966Z`, and `SINCE` below is in the same form. Each command prints the window's messages of one tool, newest session first, each session after a `== <file>` line:

```bash
ROOT=$(git rev-parse --show-toplevel)
SINCE=$(jq -nr 'now - 7 * 86400 | todate')
find "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$(printf '%s' "$ROOT" | sed 's/[^A-Za-z0-9]/-/g')" -maxdepth 1 -name '*.jsonl' -mtime -7 -exec ls -t {} + | while IFS= read -r f; do
  [ "$(basename "$f" .jsonl)" = "${CLAUDE_CODE_SESSION_ID:-}" ] && continue
  jq -n -e --arg root "$ROOT" 'first(inputs | .cwd? // empty) == $root' "$f" >/dev/null || continue
  echo "== $f"
  jq -r --arg since "$SINCE" 'select((.type == "user" or .type == "assistant") and .isMeta != true and .isSidechain != true and .timestamp >= $since)
    | .message.content | if type == "string" then . else (.[] | select(.type == "text") | .text) end' "$f"
done
find "${CODEX_HOME:-$HOME/.codex}/sessions" -name 'rollout-*.jsonl' -mtime -7 -exec ls -t {} + | while IFS= read -r f; do
  head -1 "$f" | jq -e --arg root "$ROOT" --arg t "${CODEX_THREAD_ID:-}" --arg s "${CODEX_SESSION_ID:-}" \
    '.payload.cwd == $root and .payload.id != $t and .payload.id != $s' >/dev/null || continue
  echo "== $f"
  jq -r --arg since "$SINCE" 'select(.type == "response_item" and .payload.type == "message" and (.payload.role == "user" or .payload.role == "assistant") and .timestamp >= $since)
    | .payload.content[]? | select(.type == "input_text" or .type == "output_text") | .text' "$f"
done
```

Read every session these print, without stopping early, and no other file in those folders. They skip this session's own file when your shell names it (`CLAUDE_CODE_SESSION_ID` in Claude Code, `CODEX_THREAD_ID` or `CODEX_SESSION_ID` in Codex); when one of them still holds this request, it's this session, so leave it out. When they hold more text than you can take in, read the person's messages first, where stated rules and repeated corrections show, and the replies only around the decisions those point to.

What you read from the sessions is in your context, which reaches your model provider. Use them to find decisions and for nothing else: no draft, question or report quotes a transcript, even a few words to name a decision, says who said what or when, or repeats a credential, a name or any other personal detail found there. An ADR states its decision in its own words, and its policies rest on the code or on what the person confirms.

## Sort what you find

Sort each finding into one of three kinds, and note where it shows: the files and commits, or for a session only that one exists.

- **Intents.** Decisions people stated or wrote down: a decision file without an ADR header, a rule in a README, a contributing guide or a code comment, a choice settled in a session.
- **Observations.** What the code does consistently: one database client or HTTP layer, module boundaries nothing crosses, how errors, retries, logging or configuration are handled, test conventions. Search for where each shows (imports, module boundaries, config, tests, CI) and read those files.
- **Signals.** Signs that a decision is being made or is changing: a dependency added or removed, a migration under way (two ways of doing one thing, one of them newer), a new lint rule or CI check, a TODO that names a direction, an ADR the code no longer follows.

## Choose the foundation set

An ADR is warranted only for an architectural or cross-cutting decision, a convention, constraint or policy future code should follow, that no existing ADR covers. Fold findings that point at one decision into one draft. When findings disagree, such as a stated rule the code breaks, draft the decision they point toward and name the conflict when you show it.

Rank the decisions by how much of the code each one governs and what breaking it would cost, and propose at most ten, or five in the sessions scope, most significant first. Each draft keeps to one decision: when more qualify than the limit allows, leave the rest out and name them, one line each, when you show the drafts, instead of folding two into one draft. In the sessions scope, name each decision an ADR already covers the same way, with that ADR, describing the decision in your own words, such as "webhooks are retried with backoff", never in the session's. If nothing in scope warrants an ADR, say so briefly and stop. Don't invent one.

Draft each in the shape and to the rules of adr-draft's "Draft the ADR" section, grounded in the files you read.

## Let the person choose

Show every draft in full, numbered in ranked order, each with a line naming what it rests on. Then ask in one interactive question call (`AskUserQuestion` in Claude Code):

1. **Which drafts to create.** Real multi-select questions (`multiSelect: true`), one option per draft labelled with its title. Use as many questions as the drafts need, each with two to four options, split as evenly as you can (ten drafts as four, three and three). A single draft gets one question: create it or not. Never a lettered menu or a "reply with the numbers" prompt.
2. **Their status, signed in only.** Accepted (recommended): the decision is settled as written and governs once it's saved. Draft: it's still open, and governs once someone publishes it. One answer covers every ADR created, and the person can set them one by one under Other.

Signed out there's no status to pick: the ADRs written to `docs/adr/` are accepted, and a person who wants drafts signs in first, as adr-draft describes.

Only when no such tool exists, fall back to a literal checkbox list, one `- [ ]` per draft, ask for the status in the same message when signed in, and end your turn on it.

Don't create anything until the person answers, or when they pick none.

## Create the picks

Hand the picked drafts to adr-draft in ranked order, as its "Drafts handed over by adr-bootstrap" section describes. It creates each with the content the person saw and, signed in, the status they chose, then checks and reports them. Where adr-draft needs the person's answer, such as for a likely duplicate, ask it and carry on.

## Report

Add to adr-draft's report what the survey left: the drafts the person didn't pick, and anything it found that didn't warrant an ADR on its own, one line each. adr-draft can update or delete any of the new ADRs later.

In the sessions scope, also say how many sessions from the last seven days you read for each tool, leaving this one out, and list again the decisions an ADR already covered.

Signed in, when the survey found files under `docs/adr/` that Actual AI doesn't have, name them and ask whether to send them to Actual AI with `actual adr create --all`. Run it only after a yes and report its result, both as adr-draft's "Files in docs/adr/ that Actual AI doesn't have" section describes.

## Failure and completion

- Nothing in scope warrants an ADR: say so and stop.
- The person declines the survey or picks no draft: create nothing and stop.
- The person declines the session read: survey without it.
- In the sessions scope, this checkout has no session from the last seven days: say so and stop. The whole-repository survey still reads the code.
- Git, an ADR listing or a session folder isn't available: say so and survey what you can. Never invent history, sessions or existing ADRs.

The skill is done when nothing warranted an ADR and you said so, when the person declined, or when every picked ADR is created through adr-draft and reported.
