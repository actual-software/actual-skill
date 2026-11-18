---
name: adr-draft
description: >-
  Draft Architecture Decision Records (ADRs) in a repository with the actual
  CLI, from a topic the user names, the work in this session or the last N
  commits. The user picks which drafts to write and whether each is accepted
  or a draft. Each one is written only to docs/adr/, the folder ADRs are
  published from, as the decision doc actual adr new lays out, and never into
  .actual/rules/. actual adr check checks the format and lists likely
  duplicates, and after actual login the skill offers actual adr create --file
  to save each one to Actual AI. Use when asked to draft, propose, write,
  capture or record an ADR or an architecture decision, or to check whether
  recent work warrants one. Do not use to list, edit, publish, archive, accept
  or reject decisions already in Actual AI (the actual skill covers those
  commands), or to review code.
---

# Draft ADRs

Turn an architectural decision into an ADR in `docs/adr/`, the folder ADRs are published from. Write there and nowhere else: `.actual/rules/` holds the rule files `plan-check` and `impl-check` read, and those arrive through Actual AI's sync pull request once a decision is published. Draft only what warrants an ADR, and write only what the person picks.

## Check the CLI

```bash
command -v actual && actual adr --help
```

- **No `actual` on `PATH`.** Offer to install it (`npm install -g @actualai/actual`, or `brew install actual-software/actual/actual`) with an interactive question tool such as `AskUserQuestion`, and wait for the answer before going on.
- **`actual adr --help` fails.** The CLI predates the ADR commands, which arrived in 0.14.0: it answers `unrecognized subcommand 'adr'` and suggests `adr-bot`, a different command that writes agent guidance files. Offer the upgrade the same way: `npm install -g @actualai/actual@latest` or `brew upgrade actual-software/actual/actual`.

Without a CLI that has `actual adr` (0.14.0 or later) you can still draft ADRs and show them, but write nothing: only the CLI writes them in the layout the checks read.

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

## Judge whether an ADR is warranted

An ADR is warranted only for an architectural or cross-cutting decision, a convention, constraint or policy future code should follow, that no existing ADR covers.

The scope may hold several decisions. Draft one ADR per decision that clearly warrants one, each covering a single decision, and at most three; when more qualify, pick the three most significant. If nothing in scope warrants an ADR, say so briefly and stop. Don't invent one.

## Draft each ADR

Draft each ADR in the shape of the decision doc the CLI writes. The CLI adds the header and fills in `Status:` and `Date:` itself:

````
# <Decision title>

Status: <accepted or proposed, written by the CLI>
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

Check every draft against these rules before you show it, and revise any that fails.

## Let the person choose

Show every draft in full, then ask two questions in one interactive question call (`AskUserQuestion` in Claude Code):

1. **Which drafts to write.** A real multi-select (`multiSelect: true`), one option per draft labelled with its title, so the person can pick all, some or none. Never a lettered menu or a "reply with the numbers" prompt.
2. **Their status.** Accepted (recommended): the decision is settled as written. Draft: it's still open. Either way, `plan-check` and `impl-check` read it only once it's published in Actual AI and the sync pull request writes its rule file. One answer covers every ADR written, and the person can set them one by one under Other.

Only when no such tool exists, fall back to a literal checkbox list, one `- [ ]` per draft, and ask for the status in the same message.

Write nothing until the person answers, and nothing when they pick none.

## Write each picked ADR

Write each picked ADR into `docs/adr/` and nowhere else. `actual adr new` lays it out, but it also writes a rule file into `.actual/rules/`, so point it at a scratch directory instead of the repository: once per picked draft, run `mktemp -d` and pass the directory it prints to `--root`, with the status the person chose. Always pass `--status`: an agent's shell has no terminal, and without one the CLI writes a draft.

```bash
mktemp -d    # prints the scratch directory, such as /tmp/tmp.k3J9x0aB1c
actual adr new "<title>" \
  --context "<point>" --context "<point>" \
  --policy "MUST: <statement>" --policy "SHOULD_NOT: <statement>" \
  --deciders "<name or team>" \
  --scope 'services/**' \
  --status accepted \
  --root "<scratch directory>" \
  --json
```

- Pass `--context` once per Context bullet and `--policy` once per policy, in order. Leave out `--scope` for the whole repository, or pass it once per glob.
- `--json` prints `adr_id`, `status`, `decision_file` and `rule_file`, and both files sit in the scratch directory.
- The CLI runs Actual AI's save check first. When the decision would be refused it writes nothing, lists each reason and exits 1: fix the draft and run it again.

Move `decision_file` into the repository's `docs/adr/` under its own name, then delete the scratch directory with the rule file in it. Remove only the path `mktemp -d` printed, never one inside the repository:

```bash
mkdir -p docs/adr && mv "<decision_file>" docs/adr/ && rm -r "<scratch directory>"
```

The name starts with the decision's new id, so the move can't replace a file the repository has. From here on, `decision_file` means the moved file.

Then add the draft's Rationale, Consequences and References to the end of it, in the template's shape. The file ends without a newline, so start with a blank line. Change nothing above them.

To change an ADR that's written but not yet pushed, such as dropping a policy, remove its file and write it again the same way with the new content.

## Check the files

```bash
actual adr check <decision_file>... --json
```

- **`files`.** Each file's `ok`, with `problems` (a failure, exit 1) and `warnings`. Fix a failure in the sections you added, then check again.
- **`duplicates`.** A new file and a likely duplicate of it: `other_file` in the repository or `other_decision` in Actual AI, with the matching title and policies under `overlap`. A duplicate doesn't fail the check. Show each one to the person and ask whether to keep the new ADR, fold it into the existing one or remove the new file. Remove nothing without their answer.
- **`cloud`.** Whether the comparison with Actual AI ran (`compared`) and for which repository (`scope`). When it didn't, `note` says why, such as nobody being signed in.

Tell the person which files were written, with each one's status, and that the checks read an ADR only once it's published in Actual AI and the sync pull request writes its rule file.

## Sign in before pushing

Saving an ADR to Actual AI needs a sign-in. Check it, with no network call:

```bash
actual whoami
```

- **Exit 0.** Signed in. If the check above didn't compare with Actual AI, run it again now that it can.
- **Exit 2, "Not signed in to Actual AI".** `actual login` opens a browser, so the person runs it, in their terminal or, in Claude Code, by typing `! actual login` at the prompt. Ask them to, wait until they say it's done, then run `actual whoami` and the check again. Never script the browser or the consent page.

If the person would rather not sign in, stop here. The ADRs stay in `docs/adr/`, ready to save later.

## Offer the push

Offer `actual adr create --file <decision_file>` for each new ADR, as a multi-select like the one for the drafts. Tell the person two things before they answer:

- From an agent's shell the CLI saves each ADR to Actual AI as a draft and marks its file draft too. It governs once someone publishes it (`actual adr publish <id>`, or in the web app) and Actual AI's sync pull request writes its rule file.
- To save one as accepted, they can ask you to, or run the command themselves in a terminal.

Pass `--status accepted` only when the person asks for it in answer to this offer. Never add it on your own.

```bash
actual adr create --file <decision_file> --json
```

Push one file per command, and read each result before the next:

- **Exit 0.** `adr_id` is the decision's id in Actual AI and `status` how it was saved. `files.renamed` gives the file's new name, the one the sync uses, so the next sync pull request updates it instead of adding a copy. `files.problems` notes that no rule file was renamed, which is expected: the skill writes none. `local_status_was` appears when the local status changed. When setting the scope in the file's header or publishing an accepted save failed, the decision stays a saved draft, `status` reads `draft`, and `scope_problem` or `publish_problem` gives the command that finishes the job: show it to the person.
- **Exit 1.** Nothing was saved: the file didn't parse, Actual AI refused its content and the error lists the reasons, or it looks like one the repository already has and the error names the match. Re-run with `--allow-duplicate` only when the person says to, or when they already chose to keep this ADR after seeing that same match in the check. Show any other match and ask.
- **Exit 2.** Signed out, no access to the organization, or no connected repository for the checkout's `origin` remote. Hand the sign-in back to the person, or ask which connected repository to use and pass `--repo <name, owner/name or id>`.
- **Exit 3, saying the decision may have been saved.** Don't run `create` again: a second run can save a second copy. Run `actual adr list --json` and look for the title first.
- **Any other exit 3.** Actual AI couldn't be reached or answered with an error, and the message says which. Tell the person, and offer to try again later.

Report each pushed ADR's id, its status and its file's new path, and for a draft, how to publish it.

## Failure and completion

- Nothing in scope warrants an ADR: say so and stop.
- The person picks no draft: write nothing and stop.
- Git or an ADR listing isn't available: say so and draft from what you can observe. Never invent history or existing ADRs.

The skill is done when nothing warranted an ADR and you said so, or when the picked ADRs are written to `docs/adr/` and checked and every one the person chose to push is saved, with its id and file reported.
