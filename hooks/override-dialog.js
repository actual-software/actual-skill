// override-dialog.js - what to ask the user when plan-check or impl-check
// denies, and what the answer means. Pure: register.js asks ($.ui.ask), runs
// the CLI ($.process.run) and applies the result, because a hooks module's `$`
// may not cross an import.
//
// The question comes with the denial itself:
//
//   Plan blocked by 3 rules: R-API-AUTH-001, R-AUTH-001, R-SRB-001.
//   1. Revise the plan to conform (Recommended)
//   2. Override all 3 rules
//
// The rules it lists are the denying gate's blocking rules as the CLI holds
// them (`check-override --claude-hook --gate <gate> --list-blocking`), not ids
// read from the deny text: that text quotes the plan or diff, which the agent
// writes, so a rule-shaped line in it could add or hide a rule. "Override all"
// records `all` with the same `--gate`, so what it turns off is exactly what
// was listed, and never a rule only the other gate is denying.
//
// "Revise" hands the agent the denial with the user's choice and no override
// commands in it. An override is recorded at once and, when it covers every
// blocking rule, the call goes on: ExitPlanMode reaches its approval, or the turn
// ends. Anything typed under "Other" reaches the agent as the user's answer.
// Dismissed, or where no dialog can be shown (`claude -p`), the denial is left
// exactly as the CLI wrote it.
//
// Why the mod asks rather than the agent. The agent's own AskUserQuestion would
// depend on the agent choosing to ask, and its answer would come back to the
// agent as a tool result, which an agent could forge. $.ui.ask's answer comes
// back to the mod, which the agent cannot reach.
//
// Why the mod records overrides, typed ones included. `actual check-override
// --claude-hook` records from a UserPromptSubmit envelope on stdin, and an
// envelope is only JSON: an agent could pipe one in from its shell. So the CLI
// refuses that flag when its environment carries Claude Code's CLAUDECODE
// marker, which every agent shell command and every settings hook inherits and
// the mod's own spawns do not (probed on 2.1.287). A settings hook therefore
// cannot record one any more; the mod does, from a dialog answer or from a
// prompt Claude Code stamps as typed at the prompt box.

// The in-session command as the user must type it: Claude Code registers a
// plugin's commands only under `/<plugin>:<command>`. The CLI's deny text names
// it too, which is how a deny from a CLI that can record it is recognised.
export const OVERRIDE_COMMAND = '/actual-cli:override';

// A prompt that is this plugin's override command, namespaced or bare, as the
// CLI's parse_override_prompt accepts it. Another plugin's `/<name>:override`
// is that plugin's command: the CLI answers it with silence, which would read
// here as a CLI too old to record it.
const OVERRIDE_PROMPT = /^\s*\/(?:actual-cli:)?override(?:\s|$)/;

// The sentence of the deny text that hands the user commands to type, from the
// CLI's hook_deny_reason. Replaced once the user has answered the dialog.
const INSTRUCTIONS = /Tell the user they can type `\/actual-cli:override[\s\S]*?`actual check-override --help`\)\./;

const GATE = {
  plan: {
    header: 'Plan blocked',
    blocked: 'Plan blocked by',
    revise: 'Revise the plan to conform (Recommended)',
    revised:
      'The user chose to revise the plan so it conforms to these rules. Revise it to satisfy every rule above, then call ExitPlanMode again. Do not suggest an override.',
    rest: 'Revise the plan for the rules still blocking, then call ExitPlanMode again.',
  },
  impl: {
    // The dialog clips a header past 12 characters.
    header: 'Code blocked',
    blocked: 'Changes blocked by',
    revise: 'Revise the changes to conform (Recommended)',
    revised:
      'The user chose to revise the changes so they conform to these rules. Change the code to satisfy every rule above. Do not suggest an override.',
    rest: 'Revise the changes for the rules still blocking.',
  },
};

const TOO_OLD =
  'The user typed an override, but the installed actual CLI could not record it from the session (it may be too old). Nothing was overridden. Tell them to update the CLI, or to run `actual check-override` from an ordinary terminal. Do not run it yourself.';

/** Whether a deny names the in-session command, so a dialog may be worth raising. */
export function offersOverride(reason) {
  return typeof reason === 'string' && reason.includes(OVERRIDE_COMMAND);
}

/**
 * The `check-override --claude-hook --list-blocking` call for `ctx`: the rules
 * `gate` is blocking now, recording nothing.
 */
export function blockingCall(ctx, gate) {
  return {
    argv: ['actual', 'check-override', '--claude-hook', '--rules-dir', ctx.rulesDir, '--gate', gate, '--list-blocking'],
    init: {
      cwd: ctx.repoRoot ?? ctx.cwd,
      stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: ctx.sessionId }),
      timeoutMs: 10000,
    },
  };
}

/**
 * The full rule keys from a finished `blockingCall` spawn, or null when the CLI
 * gave none: a build without `--list-blocking` exits non-zero on the flag.
 */
export function parseBlocking(run) {
  const out = parseOverrideRun(run);
  if (!Array.isArray(out?.blocking)) return null;
  const keys = out.blocking.filter((k) => typeof k === 'string' && k);
  return keys.length === out.blocking.length ? keys : null;
}

// How a key reads in the question: its bare rule id, or the whole key where
// two blocking rules share that id.
function displayNames(keys) {
  const bare = keys.map((k) => k.split('::').pop());
  return keys.map((k, i) => (bare.indexOf(bare[i]) === bare.lastIndexOf(bare[i]) ? bare[i] : k));
}

/**
 * The dialog to raise for a denial from `gate` ('plan' or 'impl'), given the
 * rules the CLI says that gate is blocking (`keys`), or null when there is
 * nothing to ask: a deny that does not name the command (another gate, or a CLI
 * too old to record an in-session override), or no blocking rules to list.
 */
export function denialQuestion(gate, reason, keys) {
  if (!offersOverride(reason) || !Array.isArray(keys) || keys.length === 0) return null;
  const copy = GATE[gate];
  const names = displayNames(keys);
  const what = keys.length === 1 ? '1 rule' : `${keys.length} rules`;
  const overrideAll = keys.length === 1 ? `Override ${names[0]}` : `Override all ${keys.length} rules`;
  // Overriding single rules is left to a typed /actual-cli:override: a
  // "Choose rules" step here read as confusing.
  const options = [copy.revise, overrideAll];
  return {
    gate,
    reason,
    keys,
    overrideAll,
    question: `${copy.blocked} ${what}: ${names.join(', ')}. What should happen?`,
    header: copy.header,
    options,
  };
}

// What the deny text says once the user has answered: the commands for them to
// type replaced with what they chose.
function withNote(reason, note) {
  return INSTRUCTIONS.test(reason) ? reason.replace(INSTRUCTIONS, note) : `${reason}\n${note}`;
}

/**
 * What the answer means: `{ targets }` to record, or `{ text }`, the denial
 * the agent should read.
 */
export function readAnswer(q, answer) {
  const copy = GATE[q.gate];
  if (answer === copy.revise) return { text: withNote(q.reason, copy.revised) };
  // `all` with the gate's --gate: the CLI resolves it to the keys listed.
  if (answer === q.overrideAll) return { targets: ['all'] };
  // Typed under "Other": the user's own words, for the agent to act on.
  return {
    text: withNote(
      q.reason,
      `The user answered the override dialog: "${answer}". No rule was overridden. Act on their answer; do not suggest an override.`,
    ),
  };
}

/** The prompt check-override reads for one dialog target, `all` or a bare id. */
export function overridePrompt(target) {
  return `${OVERRIDE_COMMAND} ${target}`;
}

/**
 * The `check-override --claude-hook` call for `ctx` ({ sessionId, cwd,
 * repoRoot, rulesDir }): its argv and spawn options. `via` is 'dialog' or
 * 'prompt'; a typed prompt passes no `--via` or `--gate`, so a CLI from before
 * those flags still records it. A dialog passes the denying `gate`, which
 * scopes `all` to the rules it listed.
 */
export function overrideCall(ctx, prompt, via, gate) {
  const argv = ['actual', 'check-override', '--claude-hook', '--rules-dir', ctx.rulesDir];
  if (via === 'dialog') argv.push('--via', 'dialog');
  if (via === 'dialog' && gate) argv.push('--gate', gate);
  return {
    argv,
    init: {
      cwd: ctx.repoRoot ?? ctx.cwd,
      stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: ctx.sessionId, prompt }),
      timeoutMs: 10000,
    },
  };
}

/** The CLI's JSON answer from a finished spawn, or null when it recorded nothing. */
export function parseOverrideRun(run) {
  if (!run || run.exitCode !== 0 || !String(run.stdout ?? '').trim()) return null;
  try {
    return JSON.parse(run.stdout);
  } catch {
    return null;
  }
}

/**
 * What recording the targets came to. `answers` holds the CLI's parsed answer
 * (or null) for each target in turn. Resolves to `{ pass: true, note }` when
 * the keys the CLI recorded cover every rule the dialog listed, so the call
 * should go on, or `{ text }`, the denial the agent should read.
 */
export function overrideOutcome(q, targets, answers) {
  const overridden = [];
  const failures = [];
  targets.forEach((target, i) => {
    const keys = Array.isArray(answers[i]?.overridden) ? answers[i].overridden : [];
    if (keys.length) overridden.push(...keys);
    else failures.push(answers[i]?.hookSpecificOutput?.additionalContext ?? `${target}: the actual CLI did not record it.`);
  });
  const done = overridden.length ? `The user overrode ${overridden.join(', ')} in the override dialog.` : '';
  const covered = q.keys.every((k) => overridden.includes(k));
  if (failures.length === 0 && covered) return { pass: true, note: done };
  const failed = failures.length ? ` Not recorded: ${failures.join(' ')}` : '';
  return { text: withNote(q.reason, `${done}${failed} ${GATE[q.gate].rest}`.trim()) };
}

/**
 * Whether a submitted prompt is the user's own override command: a prompt
 * Claude Code stamps as typed (the prompt box, or Remote Control), never one a
 * plugin or a task submitted.
 */
export function isTypedOverride(e) {
  const kind = e?.origin?.kind;
  return (kind === 'composer' || kind === 'bridge') && OVERRIDE_PROMPT.test(e?.text ?? '');
}

/** The line the agent reads with a typed override: what the CLI said, or why nothing was recorded. */
export function typedOverrideLine(answer) {
  return answer?.hookSpecificOutput?.additionalContext ?? TOO_OLD;
}
