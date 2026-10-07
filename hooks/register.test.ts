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
  opts: {
    env?: Record<string, string>;
    cli?: any | (() => any);
    tool?: any;
    cwd?: string;
    root?: string;
    // Paths $.fs.exists should answer true for. Default: everything under the
    // root, so a test only opts in to the stricter behaviour when it needs it.
    existing?: string[] | null | (() => string[] | null);
    config?: Record<string, number>;
    gitRoot?: string;
  } = {}
) {
  const runs: any[] = [];
  // Tunables are read from ACTUAL_RULES_BRIEF_* so a test can set them; see
  // SETTINGS in register.js for why they are not userConfig alone.
  const cfgEnv: Record<string, string> = {};
  const envName: Record<string, string> = {
    maxSessionChars: 'ACTUAL_RULES_BRIEF_MAX_SESSION_CHARS',
    limit: 'ACTUAL_RULES_BRIEF_LIMIT',
    rulesPerDecision: 'ACTUAL_RULES_BRIEF_RULES_PER_DECISION',
    maxChars: 'ACTUAL_RULES_BRIEF_MAX_CHARS',
    minScore: 'ACTUAL_RULES_BRIEF_MIN_SCORE',
  };
  for (const [k, v] of Object.entries(opts.config ?? {})) cfgEnv[envName[k]] = String(v);
  mock.env(on, { ...cfgEnv, ...(opts.env ?? {}) });
  on('session.cwd', async () => ({ value: opts.cwd ?? '/repo' }));
  on('session.root', async () => ({ value: opts.root ?? '/repo' }));
  on('session.id', async () => ({ value: 'sess-1' }));
  on('session.usage', async () => ({
    value: { context: { tokens: 1000, window: 200000, percent: 1 } },
  }));
  on('ui.log', async () => ({ value: undefined }));
  on('fs.exists', async (_$: any, e: any) => {
    const existing = typeof opts.existing === 'function' ? opts.existing() : opts.existing;
    return { value: existing ? existing.includes(e.path) : true };
  });
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
    // The repo-root probe is not a brief; answer it without recording a run.
    if (e.argv?.[0] === 'git') {
      return { value: { exitCode: 0, stdout: `${opts.gitRoot ?? opts.root ?? '/repo'}\n`, stderr: '' } };
    }
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

  expect(runs[0].argv.slice(0, 6)).toEqual([
    'actual', 'rules', 'brief', '--claude-hook', '--rules-dir', '/repo/.actual/rules',
  ]);
  const sent = JSON.parse(runs[0].init.stdin);
  // Without hook_event_name the CLI returns nothing at all; without session_id
  // it still briefs but silently stops consulting brief memory, so every read
  // of a governed file would brief again.
  expect(sent.hook_event_name).toBe('PostToolUse');
  expect(sent.session_id).toBe('sess-1');
  expect(sent.tool_name).toBe('Read');
  // Resolved to an absolute path: a relative token is only meaningful next to
  // the directory the command actually ran in, which a `cd` prefix can change.
  expect(sent.tool_input.file_path).toBe('/repo/src/persistence/user_store.ts');
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

// --- Phase 2: path extraction -------------------------------------------
//
// Every shape below was taken from a live isReadOnly probe or from the 35 Bash
// calls of sprintreview session fb5061e2, not invented.

test('a command reading two files briefs both', async (fire: any, on: any) => {
  // `cat a.ts b.ts` comes back isReadOnly, verified live.
  const runs = harness(on);
  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts src/b.ts' });

  expect(runs.length).toBe(2);
  const sent = runs.map((r: any) => JSON.parse(r.init.stdin).tool_input.file_path);
  expect(sent).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
});

test('a pipeline briefs the file, not the downstream tool name', async (fire: any, on: any) => {
  const runs = harness(on);
  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts | head -3' });

  expect(runs.length).toBe(1);
  expect(JSON.parse(runs[0].init.stdin).tool_input.file_path).toBe('/repo/src/a.ts');
});

test('a leading `cd` sets the base a relative path resolves against', async (fire: any, on: any) => {
  // 11 of 35 real Bash calls began with `cd <abs dir> &&`, and the targets
  // were not all the repo root. Resolving against cwd instead would name a
  // file that does not exist -- or one that does, and is the wrong file.
  const runs = harness(on, { existing: ['/repo/apps/web/src/a.ts'] });
  await fire.tool.call({ tool: 'Bash', command: 'cd /repo/apps/web && cat src/a.ts' });

  expect(runs.length).toBe(1);
  expect(JSON.parse(runs[0].init.stdin).tool_input.file_path).toBe('/repo/apps/web/src/a.ts');
});

test('a `cd` partway through the command is declined, not guessed', async (fire: any, on: any) => {
  const runs = harness(on);
  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts && cd apps && cat src/b.ts' });
  expect(runs.length).toBe(0);
});

test('a path outside the session root is never briefed', async (fire: any, on: any) => {
  const runs = harness(on);
  for (const command of [
    'cat /etc/hosts',
    'cat /tmp/scratch/jwk-roundtrip.cjs',
    'cat ../outside/secrets.ts',
    'cd /elsewhere && cat a.ts',
  ]) {
    await fire.tool.call({ tool: 'Bash', command });
  }
  expect(runs.length).toBe(0);
});

test('a token that is not a file on disk is never briefed', async (fire: any, on: any) => {
  // Existence is checked before spawning. Leaving it to the CLI to answer
  // "no rules" would still cost a spawn, on every Bash call, forever.
  const runs = harness(on, { existing: [] });
  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(runs.length).toBe(0);
});

test('globs and sed line ranges are not mistaken for paths', async (fire: any, on: any) => {
  const runs = harness(on);
  await fire.tool.call({ tool: 'Bash', command: "sed -n '188,350p' src/a.ts" });
  await fire.tool.call({ tool: 'Bash', command: 'grep -rn warn packages/logger/src/*.ts' });

  // The quoted range is skipped, so only the real file briefs; the glob names
  // no single file and is skipped entirely.
  expect(runs.length).toBe(1);
  expect(JSON.parse(runs[0].init.stdin).tool_input.file_path).toBe('/repo/src/a.ts');
});

test('the same file named twice in one command briefs once', async (fire: any, on: any) => {
  const runs = harness(on);
  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts | grep -n class src/a.ts' });
  expect(runs.length).toBe(1);
});

test('a command naming many files is capped', async (fire: any, on: any) => {
  const runs = harness(on);
  await fire.tool.call({ tool: 'Bash', command: 'cat a.ts b.ts c.ts d.ts e.ts' });
  expect(runs.length).toBe(2);
});

test('two briefs from one command are joined, with the output kept', async (fire: any, on: any) => {
  const runs = harness(on);
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts src/b.ts' });
  expect(runs.length).toBe(2);
  expect(r.result.stdout).toBe(`TOOL OUTPUT\n\n${BRIEF}\n\n${BRIEF}`);
});

// Commands lifted verbatim from sprintreview session fb5061e2, which
// implemented a feature in 35 Bash calls and was never briefed once. Frozen
// here so the extractor keeps answering them the same way. Run against the
// whole 35, the extractor names a real repo file for 22 and nothing for the
// rest -- heredocs, `ls`, `find`, in-place edits and a scratchpad write.
const CORPUS: Array<[string, string[]]> = [
  ['cat apps/actual/lib/oauth/tokens.ts', ['/repo/apps/actual/lib/oauth/tokens.ts']],
  ["sed -n '595,605p;236,245p' pnpm-lock.yaml && echo '=== resolved'", ['/repo/pnpm-lock.yaml']],
  ['grep -n "revok" apps/actual/lib/oauth/verify-token.ts', ['/repo/apps/actual/lib/oauth/verify-token.ts']],
  [
    'cd /repo/apps/actual && npx tsc --noEmit -p tsconfig.json',
    ['/repo/apps/actual/tsconfig.json'],
  ],
  // A version string in an echo matched a digits-allowed extension pattern and
  // became a candidate path. The extension must now begin with a letter.
  ['echo "=== jwt 9.0.3 API evidence ===" && grep -n keyid apps/actual/lib/jwks.ts', ['/repo/apps/actual/lib/jwks.ts']],
  // Heredoc bodies hold dotted property accessors that look like paths.
  ["python3 - <<'PY'\np = 'apps/actual/lib/oauth/tokens.ts'\nprint(jwk.kid, claims.jti)\nPY", []],
  // Directories, no extension.
  ['ls .actual/rules/ | wc -l && ls .actual/rules/', []],
];

test('the frozen real-session corpus extracts the same paths', async (fire: any, on: any) => {
  // One harness per test: a mod registers its hooks before the first $ call,
  // so `existing` has to vary through a closure rather than a second harness.
  let expected: string[] = [];
  const runs = harness(on, { existing: () => expected });

  for (const [command, want] of CORPUS) {
    expected = want;
    const before = runs.length;
    await fire.tool.call({ tool: 'Bash', command });
    const got = runs.slice(before).map((r: any) => JSON.parse(r.init.stdin).tool_input.file_path);
    expect(got).toEqual(want);
  }
});

// --- Phase 3: the per-session budget ------------------------------------

const LONG = 'R-001 MUST: '.padEnd(3400, 'x');

test('a brief that does not fit the remaining budget is dropped whole', async (fire: any, on: any) => {
  // Not truncated: the CLI's own --max-chars drops whole rules from one brief,
  // and a brief cut mid-rule is worse than none -- a half-printed MUST can
  // read as permission.
  const runs = harness(on, {
    cli: { exitCode: 0, stdout: reply(LONG), stderr: '' },
    config: { maxSessionChars: 4000 },
  });

  const first = await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(first.result.stdout).toContain(LONG);

  const second = await fire.tool.call({ tool: 'Bash', command: 'cat src/b.ts' });
  expect(second.result.stdout).not.toContain(LONG);
  // Two spawns: the budget is spent on what came back, not guessed beforehand.
  expect(runs.length).toBe(2);
});

test('exhausting the budget says so once, not on every later read', async (fire: any, on: any) => {
  // Briefing that merely stops is the silent-degradation failure this plugin
  // already has one of too many.
  const runs = harness(on, {
    cli: { exitCode: 0, stdout: reply(LONG), stderr: '' },
    config: { maxSessionChars: 4000 },
  });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  const crossing = await fire.tool.call({ tool: 'Bash', command: 'cat src/b.ts' });
  expect(crossing.result.stdout).toContain('per-session context budget');

  const after = await fire.tool.call({ tool: 'Bash', command: 'cat src/c.ts' });
  expect(after.result.stdout).toBe('TOOL OUTPUT');
  // And no further spawns once the budget is gone.
  expect(runs.length).toBe(2);
});

test('maxSessionChars: 0 turns briefing off without touching the gates', async (fire: any, on: any) => {
  const runs = harness(on, { config: { maxSessionChars: 0 } });
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(runs.length).toBe(0);
  expect(r.result.stdout).toBe('TOOL OUTPUT');
});

test('the default budget leaves an ordinary brief untouched', async (fire: any, on: any) => {
  const runs = harness(on);
  for (const f of ['a', 'b', 'c', 'd']) {
    const r = await fire.tool.call({ tool: 'Bash', command: `cat src/${f}.ts` });
    expect(r.result.stdout).toBe(`TOOL OUTPUT\n\n${BRIEF}`);
  }
  expect(runs.length).toBe(4);
});

test('only the limits an operator set are passed to the CLI', async (fire: any, on: any) => {
  // The CLI owns its own defaults. --min-score especially: unset, it defers to
  // the repository's own rules_min_score, which restating here would override.
  const bare = harness(on);
  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(bare[0].argv).toEqual([
    'actual', 'rules', 'brief', '--claude-hook',
    '--rules-dir', '/repo/.actual/rules',
  ]);
});

test('configured limits reach the CLI as flags', async (fire: any, on: any) => {
  const runs = harness(on, {
    config: { limit: 1, rulesPerDecision: 3, maxChars: 1500, minScore: 2.25 },
  });
  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(runs[0].argv).toEqual([
    'actual', 'rules', 'brief', '--claude-hook',
    '--rules-dir', '/repo/.actual/rules',
    '--limit', '1',
    '--rules-per-decision', '3',
    '--max-chars', '1500',
    '--min-score', '2.25',
  ]);
});

test('ACTUAL_HOOK_DEBUG reports the budget where a headless run can see it', async (fire: any, on: any) => {
  // $.ui.log alone was unmeasurable: it writes a transcript line that never
  // reaches `claude -p` stdout, so the first measurement run produced nothing.
  const runs = harness(on, { env: { ACTUAL_HOOK_DEBUG: '1' } });
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });

  expect(runs.length).toBe(1);
  expect(r.result.stdout).toContain(BRIEF);
  expect(r.result.stdout).toMatch(/injected \d+\/\d+ chars this session/);
  expect(r.result.stdout).toContain('context 1000/200000 (1%)');
});

test('without the debug switch no budget line is injected', async (fire: any, on: any) => {
  const runs = harness(on);
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(runs.length).toBe(1);
  expect(r.result.stdout).toBe(`TOOL OUTPUT\n\n${BRIEF}`);
});

// --- Phase 4: coexistence with the Read hook ----------------------------

test('ACTUAL_RULES_DIR is honoured, as the Read hook honours it', async (fire: any, on: any) => {
  // The hook forwards --rules-dir from bootstrap.sh's rules_dir(). A mod that
  // omitted it governed against <repo>/.actual/rules instead: on a fixture
  // with root and subproject rule sets both matching one file, the hook
  // briefed the subproject's R-API-001 and the mod briefed the root's
  // R-ROOT-001 -- the wrong rules, and a second brief for one read.
  const runs = harness(on, { env: { ACTUAL_RULES_DIR: '/repo/pkg/api/.actual/rules' } });
  await fire.tool.call({ tool: 'Bash', command: 'cat pkg/api/src/a.ts' });

  expect(runs.length).toBe(1);
  expect(runs[0].argv).toEqual([
    'actual', 'rules', 'brief', '--claude-hook',
    '--rules-dir', '/repo/pkg/api/.actual/rules',
  ]);
});

test('launched in a subdirectory, the rules dir is the git root', async (fire: any, on: any) => {
  // The case that caught this: $.session.root() tracks the session's working
  // directory, so one directory down it named a .actual/rules that does not
  // exist and briefing went silently dead, while the hook -- which falls back
  // to the git toplevel -- kept working.
  const runs = harness(on, {
    cwd: '/repo/pkg/api/src',
    root: '/repo/pkg/api/src',
    gitRoot: '/repo',
  });
  await fire.tool.call({ tool: 'Bash', command: 'cat a.ts' });

  expect(runs.length).toBe(1);
  expect(runs[0].argv).toContain('/repo/.actual/rules');
  // The file still resolves against the directory the command ran in.
  expect(JSON.parse(runs[0].init.stdin).tool_input.file_path).toBe('/repo/pkg/api/src/a.ts');
});

test('a worktree nested under CLAUDE_PROJECT_DIR wins over it', async (fire: any, on: any) => {
  // Claude Code puts worktrees under the project root and CLAUDE_PROJECT_DIR
  // keeps naming the original checkout, so the deeper path is the active one.
  const runs = harness(on, {
    cwd: '/repo/.claude/worktrees/x',
    gitRoot: '/repo/.claude/worktrees/x',
    env: { CLAUDE_PROJECT_DIR: '/repo' },
  });
  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });

  expect(runs.length).toBe(1);
  expect(runs[0].argv).toContain('/repo/.claude/worktrees/x/.actual/rules');
});

test('a subproject named by CLAUDE_PROJECT_DIR wins over the outer repo', async (fire: any, on: any) => {
  const runs = harness(on, {
    cwd: '/repo/pkg/api',
    gitRoot: '/repo',
    env: { CLAUDE_PROJECT_DIR: '/repo/pkg/api' },
  });
  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });

  expect(runs.length).toBe(1);
  expect(runs[0].argv).toContain('/repo/pkg/api/.actual/rules');
});

test('the repo root is probed once per session, not once per command', async (fire: any, on: any) => {
  let gitCalls = 0;
  mock.env(on, {});
  on('session.cwd', async () => ({ value: '/repo' }));
  on('session.root', async () => ({ value: '/repo' }));
  on('session.id', async () => ({ value: 'sess-1' }));
  on('session.usage', async () => ({ value: { context: { tokens: 1, window: 2, percent: 1 } } }));
  on('ui.log', async () => ({ value: undefined }));
  on('fs.exists', async () => ({ value: true }));
  on('tool.call', async () => ({
    ref: 1, result: { stdout: 'OUT', stderr: '' }, text: 'OUT', isReadOnly: true,
  }));
  on('process.run', async (_$: any, e: any) => {
    if (e.argv?.[0] === 'git') {
      gitCalls += 1;
      return { value: { exitCode: 0, stdout: '/repo\n', stderr: '' } };
    }
    return { value: { exitCode: 0, stdout: reply(BRIEF), stderr: '' } };
  });

  for (const f of ['a', 'b', 'c']) {
    await fire.tool.call({ tool: 'Bash', command: `cat src/${f}.ts` });
  }
  expect(gitCalls).toBe(1);
});

test('the mod never fires for a Read tool call: that is the hook’s job', async (fire: any, on: any) => {
  // The two paths are split by matcher, which is what makes the double-brief
  // suppression Phase 4 was originally scoped around unnecessary.
  const runs = harness(on);
  await fire.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' });
  expect(runs.length).toBe(0);
});

test('a subagent read is filed under its own agent id', async (fire: any, on: any) => {
  // Brief memory's third key component. Probed in a real subagent: the Read
  // hook's envelope carries agent_id and this mod's event carries the same
  // value as e.agentId. Omitting it filed the subagent's reads under the
  // parent's slot, which both suppresses briefs the subagent never saw and
  // pollutes the parent's record -- missed briefs, not just duplicates.
  const runs = harness(on);
  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', agentId: 'sub-1' });

  expect(runs.length).toBe(1);
  expect(JSON.parse(runs[0].init.stdin).agent_id).toBe('sub-1');
});

test('a main-agent read carries no agent id, as the hook envelope does not', async (fire: any, on: any) => {
  const runs = harness(on);
  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });

  expect(runs.length).toBe(1);
  expect('agent_id' in JSON.parse(runs[0].init.stdin)).toBe(false);
});
