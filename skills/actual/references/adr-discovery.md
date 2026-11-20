# ADR Discovery and Normalization

Load this when the user wants ADRs under `docs/adr/` that Actual didn't write (written by hand, by a coding agent, or by another tool) brought under governance, or asks why an ADR there isn't enforced, or which ADRs Actual manages.

Both commands work signed out. A user without an Actual AI account gets the whole workflow; a signed-in user also gets a comparison with Actual AI and `--push`. Verify they exist first: `actual adr --help` must list `discover` and `normalize`. If it doesn't, offer the CLI upgrade.

## Why it matters

The checks (`plan-check`, `impl-check`, `rules`) read only `.actual/rules/`. An ADR in `docs/adr/` governs nothing until it has a rule file there. Writing the rule file is all "indexing" takes: the scope index rebuilds itself the next time a command runs.

## States

`actual adr discover --json` returns `entries` (each with `path`, `state`, `action`, `reason` and, where known, `adr_id`, `title`, `rule_file`, `duplicate_of`, `legacy_files`), `counts` and `cloud`.

| State | Meaning | What to do |
|-------|---------|------------|
| `synced` | Written by Actual AI's sync | Nothing |
| `synced-edited` | A synced doc changed here (uncommitted, or, when signed in, it differs from Actual AI). The next sync overwrites the change | Tell the user. Offer `actual adr update <id> …` to save the change in Actual AI, or reverting it. Never normalize it |
| `managed` | Written by the CLI, and its rule file is up to date | Nothing |
| `stale` | Written by the CLI, and the doc's title, status, scope or policies changed | `normalize` re-indexes it |
| `missing-rule` | Has a decision header but no rule file | `normalize` writes one |
| `broken` | Had a decision header but no longer reads as a decision | `normalize` converts it again, keeping its id |
| `unmanaged` | An ADR in another format | `normalize` converts it |
| `possible-duplicate` | Looks like a decision the repository already has (`duplicate_of`) | Ask the user before converting |
| `legacy` | Written by `actual adr-bot` (with a `.claude/rules/` file beside it) | Leave it by default. adr-bot writes it again on its next run, and Actual AI's sync replaces it. Convert it only if the user asks (`--legacy`) |
| `orphan-rule` | A rule file whose decision has no doc | Report it |
| `ignored` | An index, a template, or marked `<!-- actual:ignore -->` | Nothing |

## Workflow

1. **Discover.** Run `actual adr discover --json`, add `--no-cloud` to skip the Actual AI comparison, and summarize the counts and anything to act on.
2. **Preview.** Run `actual adr normalize --all --dry-run --json` (or name files instead of `--all`). Each result has an `outcome` (`would-write`, `would-reindex`, `needs-input`, `skipped`, `unchanged`) and, for a conversion, a `diff`. Show the user what would change and get their go-ahead before you run it without `--dry-run`: it rewrites the docs in place.
3. **Extract prose decisions yourself.** A doc whose decision is prose (no RFC-2119 keyword lines and no `## Policies` list) needs extraction. Rather than letting the CLI start a model of its own, read each such doc and write `extracted.json` outside the repository (your scratchpad or a temp directory, so it is never committed), keyed by the doc's path from the repository root:

   ```json
   {
     "docs/adr/0007-use-postgres.md": {
       "is_adr": true,
       "title": "Use Postgres for storage",
       "status": "accepted",
       "context": ["Each service picked its own database."],
       "policies": ["MUST: Services store relational data in Postgres."],
       "scope": ["services/**"],
       "uncertain": ["scope"]
     }
   }
   ```

   Write policies as checkable rules about the code, each `LEVEL: statement` with LEVEL one of MUST, MUST NOT, SHOULD, SHOULD NOT or MAY. Never invent a requirement the ADR doesn't state. Leave `scope` empty for the whole repository, and only name paths the ADR names. List every field you had to guess in `uncertain`, so the user is asked about it. Leave out a field the file already states clearly (title, status, context): the CLI reads those itself. Pass the file with `--extracted extracted.json`, and add `--no-model` so a prose doc you didn't extract is left as a question instead of starting a model. The CLI notes only the docs a model wrote, so tell the user which policies you extracted and ask them to review the wording.
4. **Ask the user what's still open.** Results with `outcome: "needs-input"` carry `questions`, each with a `field`, `question`, `options` and `suggested`. Ask the user with your question tool, one question per item, using the options and showing `suggested`. Never answer for them. Write the answers to `answers.json`, also outside the repository, keyed by each doc's path and then by the `field` the question names: `keep_duplicate` and `is_adr` are booleans, `status` is `accepted` or `draft`, and `policies` and `scope` are lists.

   ```json
   {
     "docs/adr/0007-use-postgres.md": {
       "status": "accepted",
       "scope": ["services/**"]
     }
   }
   ```

   Then run `actual adr normalize <files> --extracted extracted.json --answers answers.json --no-model --json`.
5. **Confirm.** Run `actual adr discover` again (everything handled should be `managed`) and `actual rules ls`.

Don't pass `--yes` unless the user asks for an unattended run. It writes every undecided decision as a draft, which no check reads, and skips any file with no policy.

`normalize` keeps each doc's file name, so links still work. `--rename` instead gives the doc the file name Actual AI's sync would use for its id and title; pass it only if the user asks. Sections the format has no place for are carried over word for word after it, and a prose Decision section is kept as `Original Decision`. Mention that the file was rewritten in place, and that git has the original.

## Status and governance

An `accepted` decision governs at once; a `draft` waits. The status comes from the ADR itself (Accepted→accepted, Proposed→draft, Superseded, Deprecated and Rejected→inactive). When the ADR doesn't say, the user is asked. A decision whose policies the CLI's own model extracted carries a follow-up note: point the user at it so they review the wording. Policies you wrote into `--extracted` carry none, so flag those yourself.

## Actual AI users

- ADRs merged into the repository through the context file sync show as `synced`. The CLI never rewrites them; changes belong in Actual AI.
- Once an unmanaged ADR is normalized, `actual adr normalize <file> --push` (signed in) saves it to Actual AI, as `actual adr create --file` does. The pair is renamed to the sync's names, and the sync owns it from then on. Ask before pushing: it publishes to the user's organization.

## Provenance

A rule file the CLI writes, `adr new`'s included, records its source under `metadata.actual.source` (`origin: local`, `path`, `digest`). The digest covers only the title, status, scope and policies, so rewording context or rationale doesn't make a decision stale. A rule file without that record was written by Actual AI's sync. Don't edit the record by hand.
