// Tests for the Bash-side rule brief (hooks/register.js).
//
// The harness supplies the bottom of the middleware chain: a test's
// on('tool.call', ...) stands in for Claude Code's own behaviour, so the mod's
// `await next(e)` resolves to whatever that handler returns. Every mods API
// method is also an event, so on('process.run', ...) intercepts the CLI call
// without ever spawning `actual`.
import { test, expect, mock } from 'claude-code/testing';

const BRIEF = 'R-001 MUST: all persistence goes through the repository layer.';

function reply(context: string) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context },
  });
}

// One harness per test. `env` seeds $.env.get, `cli` decides what the spawned
// CLI appears to return, and `tool` is the tool result the mod sees from next().
function harness(
  on: any,
  opts: { env?: Record<string, string>; cli?: any | (() => any); tool?: any } = {}
) {
  const runs: any[] = [];
  mock.env(on, opts.env ?? {});
  on('session.cwd', async () => ({ value: '/repo' }));
  on('session.id', async () => ({ value: 'sess-1' }));
  // Shaped like a real Bash tool result, probed from a live session: `text`
  // is the string Claude reads, `result` is a structured object, and
  // `isReadOnly` is Claude Code's own read/write verdict.
  on('tool.call', async () => opts.tool ?? {
    ref: 1,
    result: { stdout: 'TOOL OUTPUT', stderr: '', interrupted: false, isImage: false },
    text: 'TOOL OUTPUT',
    isReadOnly: true,
  });
  on('process.run', async (_$: any, e: any) => {
    runs.push(e);
    const cli = typeof opts.cli === 'function' ? opts.cli() : opts.cli;
    return { value: cli ?? { exitCode: 0, stdout: reply(BRIEF), stderr: '' } };
  });
  return runs;
}

test('a read-shaped Bash command gets the brief appended to its output', async (fire: any, on: any) => {
  const runs = harness(on);
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/persistence/user_store.ts' });

  expect(runs.length).toBe(1);
  expect(r.result.stdout).toBe(`TOOL OUTPUT\n\n${BRIEF}`);
});

test('the synthesized envelope carries the two load-bearing fields', async (fire: any, on: any) => {
  const runs = harness(on);
  await fire.tool.call({ tool: 'Bash', command: 'sed -n 1,40p src/persistence/user_store.ts' });

  expect(runs[0].argv).toEqual(['actual', 'rules', 'brief', '--claude-hook']);
  const sent = JSON.parse(runs[0].init.stdin);
  // Without hook_event_name the CLI returns nothing at all; without session_id
  // it still briefs but silently stops consulting brief memory, so every read
  // of a governed file would brief again.
  expect(sent.hook_event_name).toBe('PostToolUse');
  expect(sent.session_id).toBe('sess-1');
  expect(sent.tool_name).toBe('Read');
  expect(sent.tool_input.file_path).toBe('src/persistence/user_store.ts');
  // The CLI resolves a relative file_path against the envelope's cwd, so cwd
  // has to be right for an extracted path to resolve at all.
  expect(sent.cwd).toBe('/repo');
});

test('a command that is not read-shaped never spawns the CLI', async (fire: any, on: any) => {
  const runs = harness(on);
  for (const command of ['npx tsc --noEmit', 'pnpm test', 'ls apps/', 'git status']) {
    const r = await fire.tool.call({ tool: 'Bash', command });
    expect(r.result.stdout).toBe('TOOL OUTPUT');
  }
  expect(runs.length).toBe(0);
});

test('a write-shaped command is not briefed: Claude Code marks it not read-only', async (fire: any, on: any) => {
  // `echo written > b.txt` comes back with isReadOnly absent, verified against
  // a live session. Absent is also what an unclassifiable command yields, so
  // this is the fail-safe direction.
  const runs = harness(on, {
    tool: { ref: 1, result: { stdout: '', stderr: '' }, text: '', isReadOnly: undefined },
  });
  const r = await fire.tool.call({
    tool: 'Bash',
    command: "perl -0pi -e 's/a/b/' src/persistence/user_store.ts",
  });
  expect(runs.length).toBe(0);
  expect(r.result.stdout).toBe('');
});

test('the brief lands in result.stdout and the rest of the result survives', async (fire: any, on: any) => {
  // result.stdout is the only field that reaches the model -- a marker in the
  // sibling `text` field never arrived in a live session. Assigning a string
  // to `result` itself would render "[object Object]" over the output.
  const runs = harness(on);
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/persistence/user_store.ts' });
  expect(runs.length).toBe(1);
  expect(r.result.stdout).toBe(`TOOL OUTPUT\n\n${BRIEF}`);
  expect(r.result.stderr).toBe('');
  expect(r.result.interrupted).toBe(false);
  expect(r.ref).toBe(1);
});

test('only additionalContext is read, so no other field can act', async (fire: any, on: any) => {
  // The shape finding #1 was about: a reply that also carries decision
  // control. A byte-matching allowlist had to be pinned with five guards to
  // refuse this; reading one property ignores it by construction.
  const hostile = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: BRIEF },
    continue: false,
    stopReason: 'halt',
    decision: 'block',
    reason: 'r',
  });
  const runs = harness(on, { cli: { exitCode: 0, stdout: hostile, stderr: '' } });
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/persistence/user_store.ts' });

  expect(runs.length).toBe(1);
  expect(r.result.stdout).toBe(`TOOL OUTPUT\n\n${BRIEF}`);
  expect(r.continue).toBe(undefined);
  expect(r.decision).toBe(undefined);
  expect(r.stopReason).toBe(undefined);
});

test('a CLI that fails, crashes or prints junk leaves the result untouched', async (fire: any, on: any) => {
  // Every one of these is silence in the shell hook too. The point here is
  // that silence means "result unchanged", not "result replaced by nothing".
  const shapes = [
    { exitCode: 2, stdout: '', stderr: "error: unrecognized subcommand 'brief'" },
    { exitCode: 101, stdout: '', stderr: 'thread panicked at rules_brief.rs:1' },
    { exitCode: 0, stdout: 'not json at all', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: {} }), stderr: '' },
    { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: 42 } }), stderr: '' },
  ];
  let i = 0;
  harness(on, { cli: () => shapes[i] });

  for (; i < shapes.length; i++) {
    const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/persistence/user_store.ts' });
    expect(r.result.stdout).toBe('TOOL OUTPUT');
  }
});

test('ACTUAL_PLAN_GATE=off disables the brief', async (fire: any, on: any) => {
  const runs = harness(on, { env: { ACTUAL_PLAN_GATE: 'off' } });
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/persistence/user_store.ts' });
  expect(runs.length).toBe(0);
  expect(r.result.stdout).toBe('TOOL OUTPUT');
});

test('ACTUAL_RULES_BRIEF=off disables the brief on its own', async (fire: any, on: any) => {
  const runs = harness(on, { env: { ACTUAL_RULES_BRIEF: 'off' } });
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/persistence/user_store.ts' });
  expect(runs.length).toBe(0);
  expect(r.result.stdout).toBe('TOOL OUTPUT');
});

test('ACTUAL_CLI_SUBPROCESS=1 keeps a judge from being briefed into its own verdict', async (fire: any, on: any) => {
  const runs = harness(on, { env: { ACTUAL_CLI_SUBPROCESS: '1' } });
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/persistence/user_store.ts' });
  expect(runs.length).toBe(0);
  expect(r.result.stdout).toBe('TOOL OUTPUT');
});

test('a denied or failed Bash call is not briefed', async (fire: any, on: any) => {
  const denied = harness(on, { tool: { deny: 'nope' } });
  await fire.tool.call({ tool: 'Bash', command: 'cat src/persistence/user_store.ts' });
  expect(denied.length).toBe(0);
});

test('a mods API that throws fails open: the tool result is unchanged', async (fire: any, on: any) => {
  // Deliberately no .catch handler on the registration -- a .catch makes a
  // hook fail closed, which is right for a gate and wrong for an advisory
  // brief. So a throw must surface as "no brief", never as a changed result.
  mock.env(on, {});
  on('session.cwd', async () => {
    throw new Error('boom');
  });
  on('session.id', async () => ({ value: 'sess-1' }));
  on('tool.call', async () => ({ ref: 1, result: { stdout: 'TOOL OUTPUT' }, text: 'TOOL OUTPUT', isReadOnly: true }));
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/persistence/user_store.ts' });
  expect(r.result.stdout).toBe('TOOL OUTPUT');
});
