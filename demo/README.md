# Plan-stage governance — demo kit

A repeatable demonstration of the loop [AK-662](https://ravenai.atlassian.net/browse/AK-662)
exists to prove: **plan → block → feedback → revision → pass**, at the plan/implementation
boundary, before any code is written.

Self-contained and path-independent. Clone the repo and run it; nothing to edit.

## Two ways to run it

### `./demo/replay.sh` — deterministic (start here)

Drives the real hook with two recorded plans. No agent, no model, no network, so it
produces identical output every time and exits non-zero if the loop breaks.

Use it to rehearse, to show the loop when there is no time budget for a live session,
and as the on-stage fallback if the live demo does not cooperate.

### `./demo/run.sh` — live

Materializes a **fresh** scratch repo (new git init, empty round log, no leftovers
from the previous run), prints the prompt, copies it to the clipboard on macOS, and
launches Claude Code with the plugin loaded for that session only.

`./demo/run.sh --dry-run` sets everything up and reports what it would launch without
starting a session — good for verifying a teammate's checkout before the meeting.

## What the audience sees

1. Startup: governance active, 1 rule file.
2. Plan mode, then the prompt — which explicitly asks for SQL in the handler.
3. `ExitPlanMode` is called and **no approval dialog appears**. The plan is denied.
   The agent is handed R-001, the rule text, and the quoted lines of its own plan
   that conflict.
4. The agent revises, moving the query into a repository function.
5. `ExitPlanMode` again — this time the approval dialog appears normally.
6. `cat "$TMPDIR/actual-plan-gate-demo/rounds.log"` — round 1 conflicting, round 2
   conforming.

The point to make: nothing was written to disk. The correction happened while the
approach was still cheap to change.

## Contents

| Path | What it is |
|---|---|
| `repo/` | A small TS service. `src/db/pool.ts` is low-level, `src/repositories/` is the only place SQL is allowed, `src/handlers/getUser.ts` shows the correct pattern. |
| `repo/rules/` | The ADR. `run.sh`/`replay.sh` move it to `.actual/rules/` in the scratch copy, so this repo is never itself governed by it. |
| `bin/actual` | Content-aware stand-in for `actual plan-check` (AK-676). |
| `fixtures/` | The two recorded plans `replay.sh` drives. |
| `PROMPT.md` | The prompt to paste. `PROMPT-blunt.md` is the fallback. |

## The stand-in, honestly

`bin/actual` is a **keyword matcher**, not the real judge. It reads the plan, greps
for handler-level SQL, and quotes R-001 verbatim out of the ADR via `--rules-dir`.

It resolves plan text the way AK-676 must — injected `tool_input.plan`, then injected
`planFilePath`, then the transcript `plan_mode` attachment — so the envelope contract
is exercised for real.

What it does **not** demonstrate: rule selection quality. Picking the right ADRs out
of hundreds is [AK-674](https://ravenai.atlassian.net/browse/AK-674) /
[AK-675](https://ravenai.atlassian.net/browse/AK-675), and this scenario has exactly
one rule. Say so if anyone asks — it is the load-bearing unknown of the POC, and this
demo does not answer it.

## The live demo's failure mode

The agent can see `getUser.ts` and the repository layer, so it may reject the bad
approach on its own and never produce a violating plan. That is a good product
outcome and a useless demo. If it happens, paste `PROMPT-blunt.md`, which instructs
it to ignore the existing pattern.

This is exactly why `replay.sh` exists. Rehearse with it, and keep it one terminal
away.

## Negative controls, if asked to prove it is not staged

- `ACTUAL_PLAN_GATE=off ./demo/run.sh` → no gate, dialog appears first time.
- Delete the rule file from the scratch repo → gate disengages, completely silent.
- Run the same prompt in any repo without `.actual/rules/` → silent.
