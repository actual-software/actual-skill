---
name: adr-draft
description: >-
  Draft Architecture Decision Records (ADRs) in a repository with the actual
  CLI, from a topic the user names, the work in this session or the last N
  commits. The user picks which drafts to create, and actual adr create
  makes each one: signed out, an accepted decision doc in docs/adr/ with the
  rule file in .actual/rules/ that plan-check and impl-check read; after
  actual login, a decision in Actual AI, accepted or a draft as the user
  picks, with no file in docs/adr/. actual adr check checks each file that's
  written and lists likely duplicates. Use when asked to draft, propose,
  write, capture or record an ADR or an architecture decision, or to check
  whether recent work warrants one. Don't use it to list, edit, publish,
  archive, accept or reject existing decisions (the actual skill covers
  those commands), or to review code.
---

# Draft ADRs

Turn an architectural decision into an ADR with `actual adr create`. Where it goes depends on the sign-in. Signed out, it writes an accepted decision doc into `docs/adr/` and the rule file that `plan-check` and `impl-check` read into `.actual/rules/`, so the checks enforce it at once. Signed in, it saves the decision to Actual AI, where drafts and publishing live, and doesn't write a file into `docs/adr/`. Draft only what warrants an ADR, and don't create anything the person didn't pick.

## Check the CLI

```bash
command -v actual && actual --version
```

- **No `actual` on `PATH`.** Offer to install it (`npm install -g @actualai/actual`, or `brew install actual-software/actual/actual`) with an interactive question tool such as `AskUserQuestion`, and wait for the answer before going on.
- **A version below 0.16.0.** `create` writes into `docs/adr/` signed out from 0.16.0. In 0.14.0 and 0.15.0 it needs a sign-in, and an older CLI answers `actual adr` with `unrecognized subcommand 'adr'` and suggests `adr-bot`, a different command that writes agent guidance files. Offer the upgrade the same way: `npm install -g @actualai/actual@latest` or `brew upgrade actual-software/actual/actual`.

Without actual 0.16.0 or later you can still draft ADRs and show them, but don't create any: only the CLI writes them in the layout the checks read.

## Scope

Decide the scope from the invocation argument:

- **A topic**, meaning any text that isn't only a number, such as "how services reach the database" or "we retry webhooks with backoff". Draft ADRs about it, grounded in the repository: search the code for where the decision shows (imports, module boundaries, config, tests) and read those files, so each policy states what the code does or what the person asked for. When the text names only an area, propose the decision the code shows and say what you inferred.
- **A number `N`**, or "the last N commits". Examine the most recent `N` commits:

  ```bash
  git log -N --stat        # replace N with the argument
  git diff HEAD~N..HEAD
  ```

  With fewer than `N` commits, use as many as exist.
- **No argument.** Examine what changed in this session: the files edited and the decisions behind them. `git status` and `git diff` help.

## Read the decisions the repository has

```bash
ls docs/adr/ .actual/rules/ 2>/dev/null
actual whoami        # exit 0: signed in; exit 2: not signed in
```

Read every file whose title looks related. When `actual whoami` exits 0, also read this repository's decisions in Actual AI with `actual adr list --json --limit 200` (page on with `--offset` and the `next_offset` it returns), and open the related ones. Don't draft a decision either place already holds. Say which one covers it instead, and that the actual skill can change it with `actual adr update`.

Keep the answer `actual whoami` gave: it decides where `create` puts each ADR.

## Judge whether an ADR is warranted

An ADR is warranted only for an architectural or cross-cutting decision, a convention, constraint or policy future code should follow, that no existing ADR covers.

The scope may hold several decisions. Draft one ADR per decision that clearly warrants one, each covering a single decision, and at most three; when more qualify, pick the three most significant. If nothing in scope warrants an ADR, say so briefly and stop. Don't invent one.

## Draft each ADR

Draft each ADR in the shape of the decision doc the CLI writes. The CLI adds the header and fills in `Status:` and `Date:` itself:

````
# <Decision title>

Status: <written by the CLI>
Date: <today, written by the CLI>
Deciders: <name or team>

## Context

- <why this decision exists, the forces at play>
- <one bullet per point>

## Decision

1. <LEVEL>: <policy statement>
2. <LEVEL>: <policy statement>

## Rationale

- <why this choice over the alternatives>

## Consequences

Positive:
- <upside>

Negative:
- <cost or tradeoff>

## References

- <link or citation>
````

Rules each ADR must follow:

1. One `# ` title, on one line.
2. At least one `## Context` bullet saying why the decision is needed.
3. A `## Decision` section with at least one numbered policy, `N. LEVEL: statement`, numbered from 1.
4. LEVEL is exactly one of `MUST`, `MUST_NOT`, `SHOULD`, `SHOULD_NOT` or `MAY`. Nothing else goes between the number and the colon: in `MUST ALWAYS: …` the CLI reads the level as `MUST` and `ALWAYS:` as part of the statement.
5. One policy per line, each a single directive someone could check against code. Narrative goes in the Context bullets.
6. `Deciders:` names the person or their team. Ask when you don't know, or use `git config user.name`.
7. When the decision applies to part of the repository only, note the paths as globs relative to the repository root, such as `services/**`, with a leading `!` to exclude (`!services/legacy/**`). Otherwise it applies to the whole repository.
8. Rationale, Consequences and References are optional and worth including. Don't add a category or tags line: Actual AI assigns categories.
9. Signed in, Actual AI keeps the title, the Context bullets, the policies and the scope. Fold a reason worth keeping into a Context bullet, and leave out Deciders, Rationale, Consequences and References.

Check every draft against these rules before you show it, and revise any that fails.

## Let the person choose

Show every draft in full, then ask in one interactive question call (`AskUserQuestion` in Claude Code):

1. **Which drafts to create.** A real multi-select (`multiSelect: true`), one option per draft labelled with its title, so the person can pick all, some or none. Never a lettered menu or a "reply with the numbers" prompt. Signed out, the question says that each one picked is written to `docs/adr/` as accepted and the checks enforce it at once.
2. **Their status, signed in only.** Accepted (recommended): the decision is settled as written and governs once it's saved. Draft: it's still open, and governs once someone publishes it. One answer covers every ADR created, and the person can set them one by one under Other.

Signed out there's no status to pick: drafts live in Actual AI, so the ADRs written to `docs/adr/` are accepted. A person who wants a draft, or wants the ADRs in Actual AI, signs in first. `actual login` opens a browser, so the person runs it, in their terminal or, in Claude Code, by typing `! actual login` at the prompt. Wait until they say it's done, run `actual whoami` and read Actual AI's decisions as above, then ask again with both questions. Never script the browser or the consent page.

Only when no such tool exists, fall back to a literal checkbox list, one `- [ ]` per draft, and when signed in ask for the status in the same message.

Don't create anything until the person answers, or when they pick none.

## Create each picked ADR

Run `actual adr create` once per picked draft, from the repository root (`git rev-parse --show-toplevel` prints it), with the content the person saw. Pass `--context` once per Context bullet and `--policy` once per policy, in order. Leave out `--scope` for the whole repository, or pass it once per glob.

### Signed out

```bash
actual adr create "<title>" \
  --context "<point>" --context "<point>" \
  --policy "MUST: <statement>" --policy "SHOULD_NOT: <statement>" \
  --deciders "<name or team>" \
  --scope 'services/**' \
  --json
```

- `--json` prints `adr_id`, `status`, `decision_file`, the new file under `docs/adr/`, and `rule_file`, its rule file under `.actual/rules/`.
- The CLI runs Actual AI's save check first. When the decision would be refused it writes nothing, lists each reason and exits 1: fix the draft and run it again.
- The file's name starts with the decision's new id, so `create` can't replace a file the repository has.

Then add the draft's Rationale, Consequences and References to the end of `decision_file`, after a blank line, in the template's shape. Don't change anything above them.

To change an ADR before you're done, such as dropping a policy, remove it with `actual adr delete <adr_id>`, which removes its rule file too, and create it again with the new content.

### Signed in

```bash
actual adr create "<title>" \
  --context "<point>" --context "<point>" \
  --policy "MUST: <statement>" --policy "SHOULD_NOT: <statement>" \
  --scope 'services/**' \
  --status accepted \
  --json
```

Pass `--status accepted` only for an ADR the person chose to accept. Without it, the CLI saves a draft from an agent's shell. Never add it on your own. Leave out `--deciders`, which only a signed-out `create` takes.

Create one ADR per command, and read each result before the next:

- **Exit 0.** `adr_id` is the decision's id in Actual AI and `status` how it was saved. An accepted save also writes its rule file into `.actual/rules/` (`rule_file`), so the checks enforce it at once; when that write fails, the save still stands and `files_problem` says why. A draft governs once someone publishes it (`actual adr publish <id>`, or in the web app).
- **Exit 1.** Nothing was saved: Actual AI refused the content and the error lists the reasons, or it looks like one the repository already has and the error names the match. Re-run with `--allow-duplicate` only when the person says to keep it after seeing that match.
- **Exit 2.** The sign-in lapsed, there's no access to the organization, or no connected repository matches the checkout's `origin` remote. Hand the sign-in back to the person, or ask which connected repository to use and pass `--repo <name, owner/name or id>`.
- **Exit 3, saying the decision may have been saved.** Don't run `create` again: a second run can save a second copy. Run `actual adr list --json` and look for the title first.
- **Any other exit 3.** Actual AI couldn't be reached or answered with an error, and the message says which. Tell the person, and offer to try again later.

## Check the files

Signed out, check every file you wrote:

```bash
actual adr check <decision_file>... --json
```

- **`files`.** Each file's `ok`, with `problems` (a failure, exit 1) and `warnings`. Fix a failure in the sections you added, then check again.
- **`duplicates`.** A new file and a likely duplicate of it in the repository (`other_file`), with the matching title and policies under `overlap`. A duplicate doesn't fail the check. Show each one to the person and ask whether to keep the new ADR, fold it into the existing one or remove the new one with `actual adr delete <adr_id>`. Remove nothing without their answer.

Signed in there's no file to check: Actual AI ran the save check as it saved each decision, and `create` refused a likely duplicate unless the person chose to keep it.

## Report

Tell the person what was created:

- **Signed out.** Each file in `docs/adr/` and its rule file in `.actual/rules/`, accepted, so the checks enforce it now. Both are theirs to commit with the change.
- **Signed in.** Each decision's id and status in Actual AI. An accepted one's rule file in `.actual/rules/` is theirs to commit, or to delete before pulling the merge of Actual AI's sync pull request, which writes the same file. For a draft, say how to publish it.

## Failure and completion

- Nothing in scope warrants an ADR: say so and stop.
- The person picks no draft: create nothing and stop.
- Git or an ADR listing isn't available: say so and draft from what you can observe. Never invent history or existing ADRs.

The skill is done when nothing warranted an ADR and you said so, or when every picked ADR is created and reported: signed out, written to `docs/adr/` with its rule file and checked, and signed in, saved in Actual AI with its id.
