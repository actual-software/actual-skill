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
    // Collects every $.ui.log line, so a test can assert the mod writes
    // nothing to the user's transcript except what it means to.
    logs?: string[];
    // A Read result carries its text at result.file.content, not result.stdout.
    readShaped?: boolean;
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
  on('ui.log', async (_$: any, e: any) => {
    opts.logs?.push(typeof e === 'string' ? e : (e?.text ?? JSON.stringify(e)));
    return { value: undefined };
  });
  on('fs.exists', async (_$: any, e: any) => {
    const existing = typeof opts.existing === 'function' ? opts.existing() : opts.existing;
    return { value: existing ? existing.includes(e.path) : true };
  });
  // Shaped like a real Bash tool result, probed from a live session: `text`
  // is the string Claude reads, `result` is a structured object, and
  // `isReadOnly` is Claude Code's own read/write verdict.
  on('tool.call', async () =>
    opts.tool ??
    (opts.readShaped
      ? {
          ref: 1,
          result: { type: 'text', file: { filePath: '/repo/src/a.ts', content: 'TOOL OUTPUT' } },
          text: 'TOOL OUTPUT',
          isReadOnly: true,
        }
      : {
          ref: 1,
          result: { stdout: 'TOOL OUTPUT', stderr: '', interrupted: false, isImage: false },
          text: 'TOOL OUTPUT',
          isReadOnly: true,
        }));
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
  on('ui.log', async (_$: any, e: any) => {
    opts.logs?.push(typeof e === 'string' ? e : (e?.text ?? JSON.stringify(e)));
    return { value: undefined };
  });
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

// --- From session 9dc24b52, the first real session to run the mod ----------

test('a path relative to a cd from an EARLIER call still resolves', async (fire: any, on: any) => {
  // The Bash tool runs one persistent shell, so a `cd` changes where every
  // later call runs -- while $.session.cwd() keeps reporting the session's own
  // directory. In 9dc24b52 one call did `cd <repo>/apps/actual && ...` and two
  // later calls read `lib/oauth/verify-token.ts`, a governed file. Resolved
  // against the session cwd those became <repo>/lib/oauth/..., which does not
  // exist, so the existence filter dropped them and two briefs were lost.
  const runs = harness(on, {
    existing: ['/repo/apps/actual/lib/oauth/verify-token.ts'],
  });

  await fire.tool.call({ tool: 'Bash', command: 'cd /repo/apps/actual && ls lib/oauth/' });
  await fire.tool.call({ tool: 'Bash', command: 'grep -n logger lib/oauth/verify-token.ts' });

  expect(runs.length).toBe(1);
  expect(JSON.parse(runs[0].init.stdin).tool_input.file_path).toBe(
    '/repo/apps/actual/lib/oauth/verify-token.ts'
  );
});

test('an explicit cd outside the repo does not fall back to inside it', async (fire: any, on: any) => {
  // The multi-base fallback must not override a base the command stated.
  const runs = harness(on);
  await fire.tool.call({ tool: 'Bash', command: 'cd /elsewhere && cat a.ts' });
  expect(runs.length).toBe(0);
});

test('reading the rule documents themselves briefs nothing', async (fire: any, on: any) => {
  // Agents read their own rules unprompted; 9dc24b52 did it in its second Bash
  // call. A rule document is not governed by itself, so this was two CLI
  // spawns for an empty answer.
  const runs = harness(on);
  await fire.tool.call({
    tool: 'Bash',
    command: 'cd /repo/.actual/rules && cat cross-cutting-a.md cross-cutting-b.md',
  });
  expect(runs.length).toBe(0);
});

// --- Phase 7: what the user sees ----------------------------------------
//
// A drawn tree never reaches Claude, so none of this spends the context
// budget. Nothing draws in `claude -p` either, which is why these are tested
// through the harness rather than a live headless session.

// drawn() resolves to the element tree, not a string, so flatten it to the
// text a person would read.
function textOf(node: any): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') return textOf(node.children);
  return String(node);
}

// Mount a site, read what it drew, and unmount -- an un-unmounted drawing
// rejects at the end of the file.
/**
 * The line this call reported to the transcript, or '' when it reported none.
 *
 * Replaces mounting a render site: the report goes through $.ui.log, because a
 * drawn line vanishes whenever Claude Code collapses the call.
 */
function reported(logs: string[]) {
  return logs.filter((l) => !l.includes('injected')).join('\n');
}

async function drawnText(fire: any, component: string, requestId: string, props: any = {}) {
  const view = await fire.ui.mount({
    plugin: 'actual-cli',
    surface: 'terminal',
    component,
    requestId,
    props,
  });
  try {
    return textOf(await view.drawn());
  } finally {
    await view.unmount();
  }
}

test('a delivered brief reports a line to the transcript', async (fire: any, on: any) => {
  const logs: string[] = [];
  harness(on, { logs });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'tu_1' });
  const drawn = reported(logs);

  expect(drawn).toContain('briefed');
  expect(drawn).toContain('a.ts');
});

test('the report states the decision and rule counts', async (fire: any, on: any) => {
  // Parsed out of the CLI's own text, which is not a contract -- hence a
  // summary that degrades rather than throws. This brief shows 2 of 35.
  const brief = [
    "This repository's own rules that apply to `src/a.ts`:",
    '',
    '## Adopt JWT with RS256 for OAuth Access Token Signing',
    '- [doc-a/R-JWT-001] MUST one.',
    '- [doc-a/R-JWT-002] MUST two.',
    '- (2 of 35 rules shown)',
  ].join('\n');
  const logs: string[] = [];
  harness(on, { logs, cli: { exitCode: 0, stdout: reply(brief), stderr: '' } });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'tu_2' });
  const drawn = reported(logs);

  expect(drawn).toContain('1 ADR');
  expect(drawn).toContain('2 of 35 rules');
});

test('a governed file already briefed says so rather than nothing', async (fire: any, on: any) => {
  // The one case where silence is correct, and therefore the one most worth
  // making visible: every bug in this mod looked exactly like this.
  const logs: string[] = [];
  harness(on, { logs, cli: { exitCode: 0, stdout: '', stderr: '' } });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'tu_3' });
  const drawn = reported(logs);

  expect(drawn).toContain('nothing new for');
});

test('a CLI failure is shown, not swallowed', async (fire: any, on: any) => {
  const logs: string[] = [];
  harness(on, { logs, cli: { exitCode: 2, stdout: '', stderr: 'boom' } });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'tu_4' });
  const drawn = reported(logs);

  expect(drawn).toContain('brief unavailable');
  expect(drawn).toContain('exit 2');
});

test('a command that read no governed file reports nothing', async (fire: any, on: any) => {
  // A line on every tool call would be noise. The engine's own drawing stands.
  const logs: string[] = [];
  harness(on, { logs });

  await fire.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit', tool_use_id: 'tu_5' });
  const drawn = reported(logs);

  expect(drawn).not.toContain('actual:');
});

test('a tool result from another call is left alone', async (fire: any, on: any) => {
  const logs: string[] = [];
  harness(on, { logs });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'tu_6' });
  const drawn = reported(logs);

  expect(drawn).not.toContain('actual:');
});

test('the drawing never reaches Claude', async (fire: any, on: any) => {
  // The whole reason this is free: the line is drawn, not injected.
  const runs = harness(on);
  on('ui.render', async () => ({ type: 'engine', ref: 1 }));

  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'tu_7' });
  expect(runs.length).toBe(1);
  expect(r.result.stdout).toBe(`TOOL OUTPUT\n\n${BRIEF}`);
  expect(r.result.stdout).not.toContain('actual: briefed');
});

test('/rules-brief lists what briefing did, including where it stayed quiet', async (fire: any, on: any) => {
  harness(on);
  on('ui.render', async () => ({ type: 'engine', ref: 1 }));

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'p_1' });
  await fire.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit', tool_use_id: 'p_2' });

  const drawn = await drawnText(fire, 'Pane', 'rules-brief', {
    title: 'Rule briefing',
    bodyColumns: 80,
  });

  expect(drawn).toContain('Rule briefing this session');
  expect(drawn).toContain('briefed');
  expect(drawn).toContain('a.ts');
  // The call that briefed nothing is listed too, with its reason.
  expect(drawn).toContain('no path');
});

test('exhausting the budget toasts the user and still tells Claude', async (fire: any, on: any) => {
  // Two audiences, two channels. Claude needs to know briefing stopped or it
  // is back to not telling silence from an ungoverned file; the user needs to
  // know without it costing context.
  const toasts: string[] = [];
  const runs = harness(on, {
    cli: { exitCode: 0, stdout: reply(LONG), stderr: '' },
    config: { maxSessionChars: 4000 },
  });
  on('ui.toast', async (_$: any, e: any) => {
    toasts.push(typeof e === 'string' ? e : (e?.message ?? e?.text ?? JSON.stringify(e)));
    return { value: undefined };
  });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'b_1' });
  const crossing = await fire.tool.call({ tool: 'Bash', command: 'cat src/b.ts', tool_use_id: 'b_2' });

  expect(runs.length).toBe(2);
  expect(crossing.result.stdout).toContain('per-session context budget');
  expect(toasts.join(' ')).toContain('per-session context budget');
});

test('rule counts are summed per decision, not mixed across them', async (fire: any, on: any) => {
  // The CLI's truncation note is per decision. One decision truncated at 35
  // and one shown in full must report 9 of 36, not 9 of 35.
  const brief = [
    "This repository's own rules that apply to `src/a.ts`:",
    '',
    '## Truncated decision',
    ...Array.from({ length: 8 }, (_, i) => `- [doc-a/R-${i}] MUST x.`),
    '- (8 of 35 rules shown)',
    '',
    '## Complete decision',
    '- [doc-b/R-1] MUST y.',
  ].join('\n');
  const logs: string[] = [];
  harness(on, { logs, cli: { exitCode: 0, stdout: reply(brief), stderr: '' } });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'tu_sum' });
  const drawn = reported(logs);

  expect(drawn).toContain('2 ADRs');
  expect(drawn).toContain('9 of 36 rules');
});

test('the report names only the files that contributed a brief', async (fire: any, on: any) => {
  // Observed live: `briefed 2 ADRs, 16 of 33 rules — package.json,
  // pnpm-lock.yaml`, where package.json produced all 16 rules and the lockfile
  // produced nothing. A line that exists to make briefing legible must not
  // itself overstate what was briefed.
  let call = 0;
  const logs: string[] = [];
  const runs = harness(on, { logs,
    cli: () => (++call === 1 ? { exitCode: 0, stdout: reply(BRIEF), stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }),
  });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts src/b.ts', tool_use_id: 'tu_files' });
  const drawn = reported(logs);

  expect(runs.length).toBe(2);
  expect(drawn).toContain('a.ts');
  expect(drawn).not.toContain('b.ts');
});

test('the pane distinguishes a file that contributed from one that was quiet', async (fire: any, on: any) => {
  let call = 0;
  harness(on, {
    cli: () => (++call === 1 ? { exitCode: 0, stdout: reply(BRIEF), stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }),
  });
  on('ui.render', async () => ({ type: 'engine', ref: 1 }));

  await fire.tool.call({ tool: 'Bash', command: 'cat src/one.ts src/two.ts', tool_use_id: 'pq_1' });
  const drawn = await drawnText(fire, 'Pane', 'rules-brief', { bodyColumns: 90 });

  expect(drawn).toContain('one.ts');
  expect(drawn).toContain('nothing new for two.ts');
});

test('ACTUAL_HOOK_DEBUG explains a non-brief, not only a brief', async (fire: any, on: any) => {
  // The case the first version could not report. Three sessions were spent
  // unable to tell "mod not loaded" from "mod declined" because every early
  // exit returned before the debug line was reached.
  const cases: Array<[string, any, string]> = [
    ['npx tsc --noEmit', { isReadOnly: undefined }, 'did not mark this command read-only'],
    ['cat', {}, 'named no path-shaped token'],
  ];
  for (const [command, toolOverride, expected] of cases) {
    const runs = harness(on, {
      env: { ACTUAL_HOOK_DEBUG: '1' },
      tool: {
        ref: 1,
        result: { stdout: 'OUT', stderr: '' },
        text: 'OUT',
        isReadOnly: 'isReadOnly' in toolOverride ? toolOverride.isReadOnly : true,
      },
    });
    const r = await fire.tool.call({ tool: 'Bash', command });
    expect(runs.length).toBe(0);
    expect(r.result.stdout).toContain('actual rules brief [debug]: not briefed');
    expect(r.result.stdout).toContain(expected);
    break; // one harness per test; the second shape is covered below
  }
});

test('a path that resolves to nothing says which tokens were tried', async (fire: any, on: any) => {
  const runs = harness(on, { env: { ACTUAL_HOOK_DEBUG: '1' }, existing: [] });
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/missing.ts' });

  expect(runs.length).toBe(0);
  expect(r.result.stdout).toContain('no token resolved to a governed file');
  expect(r.result.stdout).toContain('src/missing.ts');
});

test('nothing is appended when the debug switch is off', async (fire: any, on: any) => {
  const runs = harness(on, { existing: [] });
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/missing.ts' });
  expect(runs.length).toBe(0);
  expect(r.result.stdout).toBe('TOOL OUTPUT');
});

test('a briefed call reports exactly one line to the transcript', async (fire: any, on: any) => {
  // Reported deliberately, because a drawn line depends on the render site
  // Claude Code picks and it hides the line when it collapses a call.
  //
  // The earlier rule here was that the mod logs nothing unless debugging. That
  // was about leftover debug noise -- a real session once saw
  // `EX=true type=boolean` -- and that is still forbidden. One intentional
  // line per brief is the report itself, which is different.
  const logs: string[] = [];
  harness(on, { logs });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(logs.length).toBe(1);
  // No prefix of our own: $.ui.log attributes the line to the plugin, and
  // carrying one as well read as `actual-cli: actual: briefed 2 ADRs...`.
  expect(logs[0]).toMatch(/^briefed /);
  expect(logs[0]).toContain('a.ts');
});

test('a call that briefs nothing reports nothing', async (fire: any, on: any) => {
  const logs: string[] = [];
  harness(on, { logs });

  await fire.tool.call({ tool: 'Bash', command: 'npx tsc --noEmit' });
  expect(logs).toEqual([]);
});

test('a brief whose text does not parse still reports its size', async (fire: any, on: any) => {
  // "briefed 0 ADRs, 0 rules" reads as a failure when a brief was delivered.
  const logs: string[] = [];
  harness(on, { cli: { exitCode: 0, stdout: reply('a line with no heading'), stderr: '' }, logs });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(logs[0]).toMatch(/briefed \d+ chars/);
});

test('with the debug switch on, the only logged line is the budget', async (fire: any, on: any) => {
  const logs: string[] = [];
  harness(on, { env: { ACTUAL_HOOK_DEBUG: '1' }, logs });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  // The report, plus the budget line the debug switch adds.
  expect(logs.length).toBe(2);
  expect(logs.some((l) => l.includes('injected'))).toBe(true);
  expect(logs.some((l) => l.startsWith('briefed'))).toBe(true);
});

// --- The Read tool, through the same path ---------------------------------

test('a Read is briefed, into the field a Read result carries', async (fire: any, on: any) => {
  // Probed in a live session: Bash results carry result.stdout, Read results
  // carry result.file.content, and the `text` field on both reaches the model
  // on neither. Appending to the wrong one is silent -- the brief simply never
  // arrives -- which is why each is pinned.
  const runs = harness(on, { readShaped: true });
  const r = await fire.tool.call({
    tool: 'Read',
    file_path: '/repo/src/a.ts',
    tool_use_id: 'r_1',
  });

  expect(runs.length).toBe(1);
  expect(r.result.file.content).toBe(`TOOL OUTPUT\n\n${BRIEF}`);
  // The rest of the result is passed through untouched.
  expect(r.result.type).toBe('text');
  expect(r.result.file.filePath).toBe('/repo/src/a.ts');
});

test('a Read takes its path from the event, not from parsing', async (fire: any, on: any) => {
  const runs = harness(on, { readShaped: true });
  await fire.tool.call({ tool: 'Read', file_path: '/repo/pkg/api/src/deep.ts' });

  expect(runs.length).toBe(1);
  expect(JSON.parse(runs[0].init.stdin).tool_input.file_path).toBe('/repo/pkg/api/src/deep.ts');
});

test('a Read and a cat of one file share the budget and the dedup record', async (fire: any, on: any) => {
  // The whole reason for one code path: before this, the Read hook and the mod
  // kept separate books, and a file read both ways was briefed twice.
  let call = 0;
  const runs = harness(on, {
    readShaped: true,
    cli: () => (++call === 1 ? { exitCode: 0, stdout: reply(BRIEF), stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }),
  });

  const first = await fire.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' });
  expect(first.result.file.content).toContain(BRIEF);

  // The CLI now reports nothing new, as it would for a decision already briefed.
  const second = await fire.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' });
  expect(second.result.file.content).toBe('TOOL OUTPUT');
  expect(runs.length).toBe(2);
});

test('a Read draws the same line a Bash read draws', async (fire: any, on: any) => {
  const logs: string[] = [];
  harness(on, { logs, readShaped: true });

  await fire.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', tool_use_id: 'r_draw' });
  const drawn = reported(logs);

  expect(drawn).toContain('briefed');
  expect(drawn).toContain('a.ts');
});

test('a result whose readable field is missing is left alone', async (fire: any, on: any) => {
  // A tool shape this mod does not know. Guessing where the text lives could
  // overwrite a result rather than annotate it, so it declines.
  const runs = harness(on, {
    tool: { ref: 1, result: { type: 'image', file: {} }, text: 'x', isReadOnly: true },
  });
  const r = await fire.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' });

  expect(runs.length).toBe(0);
  expect(r.result.type).toBe('image');
});

test('a suppressed brief reports its reason, not silence', async (fire: any, on: any) => {
  // The report sat after `if (!appended) return result`, so it only fired when
  // something had actually been injected. Every dedup -- the commonest reason
  // a read says nothing, and the one most worth seeing -- returned before it.
  const logs: string[] = [];
  harness(on, { cli: { exitCode: 0, stdout: '', stderr: '' }, logs });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain('nothing new for');
});

test('the pane lists calls in the order they happened', async (fire: any, on: any) => {
  // Session order, because the rows explain each other: a `no new` row means
  // nothing until the delivered row it refers to has been read.
  //
  // Relative positions, not absolute, so the assertion says what it means --
  // that one row precedes the other -- rather than pinning row indices.
  //
  // An earlier version of this comment claimed the pane also holds rows from
  // earlier tests. It does not: the plugin module is re-instantiated per test,
  // and a pane mounted in a later test shows "No reads yet". That wrong claim
  // was also the stated reason for withdrawing two tests in fa5fbf8, and it
  // was never checked.
  harness(on);
  on('ui.render', async () => ({ type: 'engine', ref: 1 }));

  await fire.tool.call({ tool: 'Bash', command: 'cat src/first-call.ts', tool_use_id: 'ord_1' });
  await fire.tool.call({ tool: 'Bash', command: 'cat src/second-call.ts', tool_use_id: 'ord_2' });

  const drawn = await drawnText(fire, 'Pane', 'rules-brief', { bodyColumns: 90 });
  expect(drawn.indexOf('first-call.ts')).toBeGreaterThan(-1);
  expect(drawn.indexOf('first-call.ts')).toBeLessThan(drawn.indexOf('second-call.ts'));
});

test('a suppressed row says no rules are left, not that the file was briefed', async (fire: any, on: any) => {
  // `already database.types.ts` was read as a claim about that file, and the
  // reader went looking for it among the delivered rows. Dedup is per
  // decision: the file itself may never have been briefed by name.
  harness(on, { cli: { exitCode: 0, stdout: '', stderr: '' } });
  on('ui.render', async () => ({ type: 'engine', ref: 1 }));

  await fire.tool.call({ tool: 'Bash', command: 'cat src/suppressed.ts', tool_use_id: 'sup_1' });

  const drawn = await drawnText(fire, 'Pane', 'rules-brief', { bodyColumns: 90 });
  expect(drawn).toContain('no new');
  expect(drawn).not.toContain('already');
});

test('a suppressed brief does not claim the file is governed', async (fire: any, on: any) => {
  // In --claude-hook mode the CLI returns empty stdout both for a file whose
  // decisions were already briefed and for a file nothing governs, so neither
  // can be asserted. A real session reported
  // `package.json, pnpm-lock.yaml governed, already briefed this session`
  // where the lockfile is governed by nothing.
  const logs: string[] = [];
  harness(on, { cli: { exitCode: 0, stdout: '', stderr: '' }, logs });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  const line = reported(logs);

  expect(line).toContain('nothing new for');
  expect(line).not.toContain('governed');
  expect(line).not.toMatch(/already briefed this session/);
});

test('the reason the CLI names on stderr is what the line says', async (fire: any, on: any) => {
  // Hook-mode stdout carries the brief the model reads, so it cannot explain
  // itself. The CLI names the reason on stderr as `no-brief=<token>`.
  const logs: string[] = [];
  harness(on, {
    cli: { exitCode: 0, stdout: '', stderr: 'actual rules brief: no-brief=already-briefed src/a.ts' },
    logs,
  });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(reported(logs)).toContain('a.ts — already briefed this session');
  expect(reported(logs)).not.toContain('or nothing governs');
});

test('a read of files nothing governs reports nothing', async (fire: any, on: any) => {
  // Most files in a repo are ungoverned, so a line on each would bury the
  // reads that matter. The pane still lists it.
  const logs: string[] = [];
  harness(on, {
    cli: { exitCode: 0, stdout: '', stderr: 'actual rules brief: no-brief=ungoverned src/a.ts' },
    logs,
  });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'ung_1' });
  expect(logs).toEqual([]);

  const drawn = await drawnText(fire, 'Pane', 'rules-brief', { bodyColumns: 90 });
  expect(drawn).toContain('no rules');
});

test('a CLI too old to name a reason degrades to the hedge', async (fire: any, on: any) => {
  // Not to a guess: picking one of the two meanings would be wrong about half
  // the files in a repo.
  const logs: string[] = [];
  harness(on, { cli: { exitCode: 0, stdout: '', stderr: '' }, logs });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(reported(logs)).toContain('already briefed, or nothing governs them');
});

test('each quiet reason gets its own pane row', async (fire: any, on: any) => {
  // `nothing-to-show` is a real case in a real repo: a lockfile claimed by a
  // Storybook ADR at the score floor, which renders no rule text. Calling that
  // a dedup would say its rules had been stated when it has none to state.
  const tokens = ['nothing-to-show', 'outside-root', 'no-rules'];
  let call = 0;
  const logs: string[] = [];
  harness(on, {
    cli: () => ({
      exitCode: 0,
      stdout: '',
      stderr: `actual rules brief: no-brief=${tokens[call++]} src/a.ts`,
    }),
    logs,
  });
  on('ui.render', async () => ({ type: 'engine', ref: 1 }));

  for (const token of tokens) {
    await fire.tool.call({ tool: 'Bash', command: `cat src/${token}.ts` });
  }
  // None of the three is about this read, so none is reported.
  expect(logs).toEqual([]);

  const drawn = await drawnText(fire, 'Pane', 'rules-brief', { bodyColumns: 90 });
  for (const label of ['no text', 'off-root', 'no set']) {
    expect(drawn).toContain(label);
  }
});

test('the band adds up what the session briefed', async (fire: any, on: any) => {
  harness(on);
  on('ui.render', async () => ({ type: 'engine', ref: 1 }));

  await fire.tool.call({ tool: 'Bash', command: 'cat src/band-a.ts', tool_use_id: 'bd_1' });

  const drawn = await drawnText(fire, 'AbovePrompt', 'prompt', {});
  expect(drawn).toContain('actual');
  expect(drawn).toMatch(/ADRs? briefed/);
  expect(drawn).toMatch(/files? governed/);
});

test('no band before briefing has done anything', async (fire: any, on: any) => {
  // A band in every session, including repositories with no rules, would be
  // furniture rather than information.
  harness(on, { cli: { exitCode: 0, stdout: '', stderr: 'actual rules brief: no-brief=ungoverned src/a.ts' } });
  on('ui.render', async () => ({ type: 'engine', ref: 1 }));

  await fire.tool.call({ tool: 'Bash', command: 'cat src/band-b.ts', tool_use_id: 'bd_2' });

  expect(await drawnText(fire, 'AbovePrompt', 'prompt', {})).not.toContain('actual');
});
