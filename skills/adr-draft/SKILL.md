---
name: adr-draft
description: >-
  Create, update or delete one Architecture Decision Record (ADR) with the
  actual CLI, from an intent the user states or an observation the user or
  the agent makes about the code. Drafts the ADR or the change, shows it,
  and runs actual adr create, update or delete only once the user agrees.
  Signed out, an ADR is an accepted decision doc in docs/adr/ with the rule
  file in .actual/rules/ that plan-check and impl-check read; after actual
  login, it's a decision in Actual AI, accepted or a draft as the user
  picks. Use when asked to draft, write, capture or record an ADR or an
  architecture decision, to change or remove one, or when a decision
  settled in the session warrants one. To find several decisions across a
  repository, its recent commits or this session, use adr-bootstrap, which
  creates the ones the user picks through this skill. Don't use it to list,
  publish, archive, accept or reject decisions (the actual skill covers
  those commands), or to review code.
---

# Draft an ADR

Create, change or remove one ADR with `actual adr create`, `update` or `delete`. Where an ADR lives depends on the sign-in. Signed out, it's an accepted decision doc in `docs/adr/` with the rule file that `plan-check` and `impl-check` read in `.actual/rules/`, so the checks enforce it at once. Signed in, it's a decision in Actual AI, where drafts and publishing live, and no file goes into `docs/adr/`. Draft only what warrants an ADR, and change nothing the person didn't agree to.

## Check the CLI

```bash
command -v actual && actual --version
```

- **No `actual` on `PATH`.** Offer to install it (`npm install -g @actualai/actual`, or `brew install actual-software/actual/actual`) with an interactive question tool such as `AskUserQuestion`, and wait for the answer before going on.
- **A version below 0.17.0.** From 0.17.0, `create`, `update` and `delete` work on `docs/adr/` signed out. In 0.14.0 through 0.16.0 they need a sign-in, and an older CLI answers `actual adr` with `unrecognized subcommand 'adr'` and suggests `adr-bot`, a different command that writes agent guidance files. Offer the upgrade the same way: `npm install -g @actualai/actual@latest` or `brew upgrade actual-software/actual/actual`.

Without actual 0.17.0 or later you can still draft an ADR and show it, but don't create, change or remove one: only the CLI writes them in the layout the checks read.

## What the person wants

Read the request as one of three:

- **Create.** An intent, a decision the person made or wants ("services reach the database through the repository layer", "we retry webhooks with backoff"), or an observation about the code, theirs or your own, such as a way of doing something the code follows throughout or a choice the work in this session settled.
- **Update.** A change to an ADR the repository has: its title, its context, a policy or its level, or the paths it covers.
- **Delete.** Removing one.

This skill handles one ADR at a time. When the request holds several decisions, draft the one it centres on and name the others, which the person can draft next. To survey a repository, its recent commits or this session for several decisions, use the adr-bootstrap skill.

## Read the decisions the repository has

```bash
actual whoami                    # exit 0: signed in; exit 2: not signed in
actual adr list --json --limit 200
```

Signed out, `list` reads the decision files under `docs/adr/`. Signed in, it reads this repository's decisions in Actual AI; page on with `--offset` and the `next_offset` it returns. Open the related ones with `actual adr show <id> --json`. For a create, also look at `ls docs/adr/`, since `list` leaves out files with no ADR header.

- **Create.** Don't draft a decision either place already holds. Say which one covers it, and offer to update that one instead.
- **Update or delete.** Find the ADR the person means by its title and policies. When more than one could be it, ask which.

Keep the answer `actual whoami` gave: it decides where each command acts.

## Draft the ADR

An ADR is warranted only for an architectural or cross-cutting decision, a convention, constraint or policy future code should follow, that no existing ADR covers. If the intent or observation doesn't hold one, say so briefly and stop. Don't invent one.

Ground it in the repository: search the code for where the decision shows (imports, module boundaries, config, tests) and read those files, so each policy states what the code does or what the person asked for. When the request names only an area, propose the decision the code shows there and say what you inferred.

Draft it in the shape of the decision doc the CLI writes. The CLI adds the header and fills in `Status:` and `Date:` itself:

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

Rules the ADR must follow:

1. One `# ` title, on one line.
2. At least one `## Context` bullet saying why the decision is needed.
3. A `## Decision` section with at least one numbered policy, `N. LEVEL: statement`, numbered from 1.
4. LEVEL is exactly one of `MUST`, `MUST_NOT`, `SHOULD`, `SHOULD_NOT` or `MAY`. Nothing else goes between the number and the colon: in `MUST ALWAYS: …` the CLI reads the level as `MUST` and `ALWAYS:` as part of the statement.
5. One policy per line, each a single directive someone could check against code. Narrative goes in the Context bullets.
6. `Deciders:` names the person or their team. Ask when you don't know, or use `git config user.name`.
7. When the decision applies to part of the repository only, note the paths as globs relative to the repository root, such as `services/**`, with a leading `!` to exclude (`!services/legacy/**`). Otherwise it applies to the whole repository.
8. Rationale, Consequences and References are optional and worth including. Don't add a category or tags line: Actual AI assigns categories.
9. Signed in, Actual AI keeps the title, the Context bullets, the policies and the scope. Fold a reason worth keeping into a Context bullet, and leave out Deciders, Rationale, Consequences and References.

Check the draft against these rules before you show it, and revise it if it fails one.

## Draft the change

For an update, start from `actual adr show <id> --json`, which lists each policy with its id: signed out, the rule id its rule file prints (such as `R-0B6F-001`), and signed in, the policy's id in Actual AI. Build the change from these flags:

- `--title "<title>"`.
- `--context "<point>"`, once per bullet. It replaces the whole context, and `--context ''` clears it.
- `--policy "<id>=LEVEL: statement"` for each policy to keep, changed or not, and `--policy "LEVEL: statement"` for a new one. The list is the whole set after the change, so a policy left out is removed.
- `--level <id>=LEVEL` to change one policy's level. It can't be combined with `--policy`.
- `--scope '<glob>'`, once per glob, or `--clear-scope` to cover the whole repository again.

Show the change before and after: each line that changes as it reads now and as it will read, or the whole ADR both ways when most of it changes.

For a delete, show the ADR in full and say what removing it does. Signed out, its file and its rule file are deleted, and `git restore` brings back a file git tracks while the deletion is uncommitted. Signed in, the decision is archived, and `actual adr restore <id>` brings it back.

## Ask the person

Show the draft in full, or the change before and after, then ask in one interactive question call (`AskUserQuestion` in Claude Code):

- **Create, signed out.** Create it or not. Say that it's written to `docs/adr/` as accepted and the checks enforce it at once.
- **Create, signed in.** Create it as accepted (recommended): the decision is settled as written and governs once it's saved. Create it as a draft: it's still open, and governs once someone publishes it. Or don't create it.
- **Update.** Apply the change or not.
- **Delete.** Delete it or keep it.

Signed out there's no status to pick. Drafts live in Actual AI, so the CLI writes only accepted ADRs into `docs/adr/` and refuses `--status draft` there. A person who wants a draft, or wants the ADR in Actual AI, signs in first. `actual login` opens a browser, so the person runs it, in their terminal or, in Claude Code, by typing `! actual login` at the prompt. Wait until they say it's done, run `actual whoami` and read Actual AI's decisions as above, then ask again. Never script the browser or the consent page. The files a signed-out `create` wrote stay in `docs/adr/`, and Actual AI doesn't have them; they go there only on the person's yes, as "Files in docs/adr/ that Actual AI doesn't have" below says.

Only when no such tool exists, ask in your reply and end your turn on the question.

Don't create, change or remove anything until the person answers, or when they decline.

### Drafts handed over by adr-bootstrap

The adr-bootstrap skill drafts a repository's foundation set to these rules and asks the person which to create. When it hands over the drafts the person picked, with the status they chose when signed in, that pick is their answer, so don't ask again. Create each one as below, in the order given and with the content the person saw, then check and report them together.

## Create the ADR

Run `actual adr create` from the repository root (`git rev-parse --show-toplevel` prints it), with the content the person saw. Pass `--context` once per Context bullet and `--policy` once per policy, in order. Leave out `--scope` for the whole repository, or pass it once per glob.

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
- Never pass `--status draft`. Signed out, the CLI refuses it (exit 2).

Then add the draft's Rationale, Consequences and References to the end of `decision_file`, in the template's shape and spaced the way the CLI spaces them, so a later `actual adr update` can write the file back whole. After the last policy comes one blank line and `## Rationale` if the draft has one, then a blank line and `## Consequences` if it has any, then two blank lines and `## References` if it has any. A blank line follows each heading, items are `- ` lines, and `## Consequences` keeps both labels, `Positive:` and `Negative:`, even when one list is empty. Don't change anything above them.

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

- **Exit 0.** `adr_id` is the decision's id in Actual AI and `status` how it was saved. The decision is saved to Actual AI; this command writes no local file. For an accepted decision, Actual AI opens a pull request that writes its rule files. A draft governs once someone publishes it (`actual adr publish <id>`, or in the web app).
- **Exit 1.** Nothing was saved: Actual AI refused the content and the error lists the reasons, or it looks like one the repository already has and the error names the match. Re-run with `--allow-duplicate` only when the person says to keep it after seeing that match.
- **Exit 2.** The sign-in lapsed, there's no access to the organization, or no connected repository matches the checkout's `origin` remote. Hand the sign-in back to the person, or ask which connected repository to use and pass `--repo <name, owner/name or id>`.
- **Exit 3, saying the decision may have been saved.** Don't run `create` again: a second run can save a second copy. Run `actual adr list --json` and look for the title first.
- **Any other exit 3.** Actual AI couldn't be reached or answered with an error, and the message says which. Tell the person, and offer to try again later.

## Update the ADR

```bash
actual adr update <id> \
  --policy "<id>=MUST: <statement>" --policy "SHOULD: <statement>" \
  --json
```

- **Exit 0.** The change is saved. Signed out, the output names the `file` and the `rule_files` it rewrote, so the checks read the change at once. Signed in, `decision` is the decision as saved; run `actual adr refresh` to bring an accepted decision's rule file in step now, and leave any `create --all` it names to "Files in docs/adr/ that Actual AI doesn't have" below. Editing the policy list can change policy ids, so read them again with `actual adr show <id>` before another edit.
- **Exit 1.** A value didn't parse, or the content was refused, and the error lists the reasons. Fix the change and run it again.
- **Exit 2.** As for `create`: the sign-in lapsed, there's no access, or no connected repository matches.
- **Exit 3.** No ADR has that id, a policy id isn't the decision's, or the ADR can't take the change. Signed out, that's a file that isn't accepted, which needs `actual adr publish <id>` first (the person's call), or a file holding text or header fields outside the layout `create` writes, which `update` won't drop. For the second, with the person's yes, make the change in the file itself and check it as below; `actual adr refresh` then brings its rule file in step. Signed in, an archived decision can't change until it's restored.

## Delete the ADR

```bash
actual adr delete <id> --json
```

Signed out, it removes the file and its rule file, and says so when git never tracked the file and can't bring it back. Signed in, it archives the decision, as Delete does in the web app; run `actual adr refresh` to remove its rule file now, leaving any `create --all` it names to the next section. Exit 3 means no ADR has that id, or signed in, that the decision's state doesn't allow it.

## Files in docs/adr/ that Actual AI doesn't have

Signed in, `actual adr refresh` can list decision files under `docs/adr/` that aren't in Actual AI yet and say `actual adr create --all` sends them. They're the person's files: ones a signed-out `create` wrote before they signed in, or ones the repository already kept. Never run `create --all` on your own, from that message or for any other reason. Ask the person first, in an interactive question where you have the tool (`AskUserQuestion` in Claude Code) and otherwise in your reply, ending your turn on it. Say that it sends their `docs/adr/` files to Actual AI and name the files, which `actual adr refresh --json` lists under `create_all`, then run it only after a yes:

```bash
actual adr create --all --json
```

Signed in, it sends every decision file under `docs/adr/` that Actual AI doesn't have yet, one at a time and keyed on its path, and nothing under `docs/adr/drafts/`. A file goes only when it has an ADR header and passes `actual adr check`. It skips and lists a file whose id is already one of the repository's decisions, one whose status retires it, such as superseded, deprecated, rejected or deferred, and one that looks like a decision already there; `--allow-duplicate` sends a look-alike too, and only the person can ask for that. Each file keeps the status its header names. A draft or proposed file becomes a draft, and an accepted one is accepted at once only with a person at the terminal: from an agent's shell it's saved as a draft until the file is on the default branch, and the first run after that accepts it. The run stops at the first save whose outcome is unknown. Report what `--json` lists:

- `saved`, `skipped` and `not_saved`, with the reason for each file skipped or not saved.
- `merged`, the drafts this run accepted because their files reached the default branch, so those decisions govern now. One marked `waits_for_merge` is still a draft, and its `publish_problem` says why.
- After a stop, the `stopped` file and the ones `not_sent`.
- `other_files`, markdown under `docs/adr/` with no ADR header, which `create` can't send.

Signed out it sends nothing: the CLI refuses `--all` (exit 2), since sending needs `actual login`. The files need no sending there, because `actual adr check` checks them and `actual adr refresh` writes the rule file of each normalized one.

## Check the file

Signed out, check the file after a create or an update:

```bash
actual adr check <decision_file> --json
```

- **`files`.** Each file's `ok`, with `problems` (a failure, exit 1) and `warnings`. Fix a failure in the sections you added, then check again.
- **`duplicates`.** A new file and a likely duplicate of it in the repository (`other_file`), with the matching title and policies under `overlap`. A duplicate doesn't fail the check. Show it to the person and ask whether to keep the new ADR, fold it into the existing one or remove the new one with `actual adr delete <adr_id>`. Remove nothing without their answer.

Signed in there's no file to check: Actual AI ran the save check as it saved the decision, and `create` refused a likely duplicate unless the person chose to keep it.

## Report

Tell the person what changed:

- **Signed out.** The file in `docs/adr/` and its rule file in `.actual/rules/`, written, rewritten or removed, so the checks follow at once. Both are theirs to commit with the change.
- **Signed in.** The decision's id and status in Actual AI. A create writes no local file: Actual AI's pull request writes an accepted decision's rule files. A rule file that `actual adr refresh` wrote into `.actual/rules/` is theirs to commit, or to delete before pulling the merge of Actual AI's sync pull request, which writes the same file. For a draft, say how to publish it.

## Failure and completion

- Nothing warrants an ADR: say so and stop.
- The person declines: change nothing and stop.
- Git or an ADR listing isn't available: say so and draft from what you can observe. Never invent history or existing ADRs.

The skill is done when nothing warranted an ADR and you said so, when the person declined, or when the ADR is created, changed or removed and reported: signed out, its file checked, and signed in, saved in Actual AI with its id.
