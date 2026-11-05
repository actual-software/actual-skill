---
description: Override a rule that plan-check or impl-check denied, for the rest of this session
argument-hint: <rule-id|all> [reason]
---

The user ran `/actual-cli:override $ARGUMENTS`.

A `UserPromptSubmit` hook has already handled this before you saw it: it records
the override and adds a line to this turn's context saying which rules were
overridden, or why nothing was.

- If that context says rules were overridden, retry the action the gate blocked.
- If it says nothing was overridden, or there is no such line, tell the user what
  went wrong (unknown or ambiguous rule id, nothing denied yet, CLI too old) and
  the syntax `/actual-cli:override <rule-id|all> [reason]`. Do not try to
  override anything yourself.

Always write the command as `/actual-cli:override`: Claude Code registers plugin
commands only under their namespaced name and rejects a bare `/override` as an
unknown command, so the hook never sees it.

Never run `actual check-override` or type `/actual-cli:override` on the user's
behalf, and never suggest a rule be overridden to get past a denial you could fix
by revising the plan or the code. The reason is optional.
