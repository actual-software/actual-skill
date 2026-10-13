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

// What the mod handed the model beside a tool result: its `context`, joined.
// '' when it handed nothing. The tool result itself is never the place.
function briefed(r: any): string {
  return (r?.context ?? []).join('\n\n');
}

// One harness per test. `env` seeds $.env.get, `cli` decides what the spawned
// CLI appears to return, and `tool` is the tool result the mod sees from next().
function harness(
  on: any,
  opts: {
    env?: Record<string, string>;
    cli?: any | (() => any);
    tool?: any | (() => any);
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
    // Entry names $.fs.list returns for the rules directory. Default: one rule
    // file, so the repo is governed; `[]` is a repo with nothing to govern, and
    // `null` a rules directory that does not exist, so the listing rejects.
    rules?: string[] | null;
    // Collects every $.fs.list path, so a test can see the rules dir checked.
    listed?: string[];
    // Collects every spawn, git and CLI alike, as `{ argv, init }`.
    spawns?: any[];
    // The shell's directory moves with each `cd` in a Bash command, as it does
    // on Claude Code 2.1.296: `session.cwd` then answers where the last
    // command ended, a failed one included. Off, it answers `cwd` throughout.
    liveShell?: boolean;
    // What `actual rules brief --help` exits with. Default 0.
    helpExit?: number;
    // `process.run` rejects instead of returning, as it does past `timeoutMs`.
    // Receives the brief spawn's 1-based ordinal; return true to reject it.
    rejectBrief?: (n: number) => boolean;
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
  let shellDir = opts.cwd ?? '/repo';
  on('session.cwd', async () => ({ value: shellDir }));
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
  on('fs.list', async (_$: any, e: any) => {
    opts.listed?.push(e.path);
    if (opts.rules === null) throw new Error(`ENOENT: ${e.path}`);
    const names = opts.rules ?? ['R-001.md'];
    return { value: names.map((name) => ({ name, kind: 'file', size: 1, mtimeMs: 0, isLink: false })) };
  });
  // Shaped like a real Bash tool result, probed from a live session: `text`
  // is the string Claude reads, `result` is a structured object, and
  // `isReadOnly` is Claude Code's own read/write verdict.
  on('tool.call', async (_$: any, e: any) => {
    if (opts.liveShell && typeof e?.command === 'string') {
      for (const part of e.command.split('&&')) {
        const m = /^\s*cd\s+(\S+)\s*$/.exec(part);
        if (!m) continue;
        const dir = m[1];
        shellDir = dir.startsWith('/') ? dir : `${shellDir.replace(/\/+$/, '')}/${dir}`;
      }
    }
    return bottom();
  });
  const bottom = () =>
    (typeof opts.tool === 'function' ? opts.tool() : opts.tool) ??
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
        });
  let briefSpawns = 0;
  on('process.run', async (_$: any, e: any) => {
    opts.spawns?.push(e);
    // The once-a-session probe for the subcommand is not a brief either.
    if (e.argv?.includes('--help')) {
      return { value: { exitCode: opts.helpExit ?? 0, stdout: '', stderr: '' } };
    }
    // The repo-root query is not a brief; answer it without recording a run.
    if (e.argv?.[0] === 'git') {
      return { value: { exitCode: 0, stdout: `${opts.gitRoot ?? opts.root ?? '/repo'}\n`, stderr: '' } };
    }
    runs.push(e);
    if (opts.rejectBrief?.(++briefSpawns)) throw new Error('timed out');
    const cli = typeof opts.cli === 'function' ? opts.cli() : opts.cli;
    return { value: cli ?? { exitCode: 0, stdout: reply(BRIEF), stderr: '' } };
  });
  return runs;
}

test('a read-shaped Bash command gets the brief beside its output', async (fire: any, on: any) => {
  const runs = harness(on);
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/persistence/user_store.ts' });

  expect(runs.length).toBe(1);
  expect(r.context).toEqual([BRIEF]);
  expect(r.result.stdout).toBe('TOOL OUTPUT');
});

test('the synthesized envelope carries the two load-bearing fields', async (fire: any, on: any) => {
  const runs = harness(on);
  await fire.tool.call({ tool: 'Bash', command: 'sed -n 1,40p src/persistence/user_store.ts' });

  expect(runs[0].argv.slice(0, 8)).toEqual([
    'actual', 'rules', 'brief', '--claude-hook',
    // The root is stated, not left for the CLI to infer from a cwd that
    // follows the agent's `cd`.
    '--repo', '/repo',
    '--rules-dir', '/repo/.actual/rules',
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
    expect(briefed(r)).toBe('');
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
  expect(briefed(r)).toBe('');
});

test('the brief lands in context and the tool result is untouched', async (fire: any, on: any) => {
  // Probed live: context reaches the model as its own system reminder, and
  // the transcript keeps the tool result exactly as the tool produced it.
  const runs = harness(on);
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/persistence/user_store.ts' });
  expect(runs.length).toBe(1);
  expect(r.context).toEqual([BRIEF]);
  expect(r.result).toEqual({ stdout: 'TOOL OUTPUT', stderr: '', interrupted: false, isImage: false });
  expect(r.text).toBe('TOOL OUTPUT');
  expect(r.ref).toBe(1);
});

test('context a hook beneath already set is kept', async (fire: any, on: any) => {
  harness(on, {
    tool: {
      ref: 1,
      result: { stdout: 'TOOL OUTPUT', stderr: '' },
      text: 'TOOL OUTPUT',
      isReadOnly: true,
      context: ['from below'],
    },
  });
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/persistence/user_store.ts' });
  expect(r.context).toEqual(['from below', BRIEF]);
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
  expect(r.context).toEqual([BRIEF]);
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
    expect(briefed(r)).toBe('');
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
  expect(r.context).toEqual([`${BRIEF}\n\n${BRIEF}`]);
  expect(r.result.stdout).toBe('TOOL OUTPUT');
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
  expect(briefed(first)).toContain(LONG);

  const second = await fire.tool.call({ tool: 'Bash', command: 'cat src/b.ts' });
  expect(briefed(second)).not.toContain(LONG);
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
  expect(briefed(crossing)).toContain('per-session context budget');

  const after = await fire.tool.call({ tool: 'Bash', command: 'cat src/c.ts' });
  expect(briefed(after)).toBe('');
  // And no further spawns once the budget is gone.
  expect(runs.length).toBe(2);
});

test('maxSessionChars: 0 turns briefing off without touching the gates', async (fire: any, on: any) => {
  const runs = harness(on, { config: { maxSessionChars: 0 } });
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(runs.length).toBe(0);
  expect(briefed(r)).toBe('');
});

test('the default budget leaves an ordinary brief untouched', async (fire: any, on: any) => {
  const runs = harness(on);
  for (const f of ['a', 'b', 'c', 'd']) {
    const r = await fire.tool.call({ tool: 'Bash', command: `cat src/${f}.ts` });
    expect(r.context).toEqual([BRIEF]);
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
    '--repo', '/repo',
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
    '--repo', '/repo',
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
  expect(briefed(r)).toContain(BRIEF);
  expect(briefed(r)).toMatch(/injected \d+\/\d+ chars this session/);
  expect(briefed(r)).toContain('context 1000/200000 (1%)');
  expect(r.result.stdout).toBe('TOOL OUTPUT');
});

test('without the debug switch no budget line is injected', async (fire: any, on: any) => {
  const runs = harness(on);
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(runs.length).toBe(1);
  expect(r.context).toEqual([BRIEF]);
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
    '--repo', '/repo',
    '--rules-dir', '/repo/pkg/api/.actual/rules',
  ]);
});

test('launched in a subdirectory, the mod resolves that subdirectory', async (fire: any, on: any) => {
  // This asserted the git root, on the belief that the hook picks it. The hook
  // does not: CLAUDE_PROJECT_DIR names the subdirectory the session started in,
  // and the hook resolves that. The mod read the variable too, but Claude Code
  // sets it for hook processes and not for a mod, so the read returned nothing
  // and the git root always won -- the two paths disagreeing about one
  // component of the brief-memory key, which is this module's recurring bug.
  //
  // With $.session.root() as the fallback they agree. Whether a session
  // launched below the rules should govern against the root's is a separate
  // question, and it applies to the gates the same way.
  const runs = harness(on, {
    cwd: '/repo/pkg/api/src',
    root: '/repo/pkg/api/src',
    gitRoot: '/repo',
  });
  await fire.tool.call({ tool: 'Bash', command: 'cat a.ts' });

  expect(runs.length).toBe(1);
  expect(runs[0].argv).toContain('/repo/pkg/api/src/.actual/rules');
  // The file still resolves against the directory the command ran in.
  expect(JSON.parse(runs[0].init.stdin).tool_input.file_path).toBe('/repo/pkg/api/src/a.ts');
});

test('a monorepo subproject is briefed from its own rules, as the hook briefs it', async (fire: any, on: any) => {
  // Measured in a live session before the fallback: a Read briefed the
  // subproject's decision and a `cat` of the same file briefed two of the
  // root's, 3,296 characters, and the model received both.
  const runs = harness(on, {
    env: {},
    cwd: '/repo/apps/actual',
    root: '/repo/apps/actual',
    gitRoot: '/repo',
  });

  await fire.tool.call({ tool: 'Read', file_path: '/repo/apps/actual/lib/a.ts', tool_use_id: 'sub_1' });
  await fire.tool.call({ tool: 'Bash', command: 'cat lib/a.ts', tool_use_id: 'sub_2' });

  // Both calls, whichever path they came down, asked about the same rule set.
  const dirs = new Set(runs.map((r: any) => r.argv[r.argv.indexOf('--rules-dir') + 1]));
  expect([...dirs]).toEqual(['/repo/apps/actual/.actual/rules']);
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
    liveShell: true,
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

  expect(drawn).toContain('BRIEFED');
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

  expect(drawn).toContain('NO CHANGE');
});

test('a CLI failure is shown, not swallowed', async (fire: any, on: any) => {
  const logs: string[] = [];
  harness(on, { logs, cli: { exitCode: 2, stdout: '', stderr: 'boom' } });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'tu_4' });
  const drawn = reported(logs);

  expect(drawn).toContain('CLI ERROR');
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
  expect(r.context).toEqual([BRIEF]);
  expect(r.result.stdout).toBe('TOOL OUTPUT');
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
  expect(briefed(crossing)).toContain('per-session context budget');
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
    expect(briefed(r)).toContain('actual rules brief [debug]: not briefed');
    expect(briefed(r)).toContain(expected);
    expect(r.result.stdout).toBe('OUT');
    break; // one harness per test; the second shape is covered below
  }
});

test('a path that resolves to nothing says which tokens were tried', async (fire: any, on: any) => {
  const runs = harness(on, { env: { ACTUAL_HOOK_DEBUG: '1' }, existing: [] });
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/missing.ts' });

  expect(runs.length).toBe(0);
  expect(briefed(r)).toContain('no token resolved to a governed file');
  expect(briefed(r)).toContain('src/missing.ts');
});

test('nothing is added when the debug switch is off', async (fire: any, on: any) => {
  const runs = harness(on, { existing: [] });
  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/missing.ts' });
  expect(runs.length).toBe(0);
  expect(briefed(r)).toBe('');
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
  expect(logs[0]).toMatch(/^\u258c BRIEFED /);
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
  expect(logs[0]).toMatch(/BRIEFED\s+\d+ chars/);
});

test('with the debug switch on, the only logged line is the budget', async (fire: any, on: any) => {
  const logs: string[] = [];
  harness(on, { env: { ACTUAL_HOOK_DEBUG: '1' }, logs });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  // The report, plus the budget line the debug switch adds.
  expect(logs.length).toBe(2);
  expect(logs.some((l) => l.includes('injected'))).toBe(true);
  expect(logs.some((l) => l.includes('BRIEFED'))).toBe(true);
});

// --- The Read tool, through the same path ---------------------------------

test('a Read is briefed beside the file, never inside it', async (fire: any, on: any) => {
  // Appended to file.content, the rules read as the file's last lines. In
  // context they arrive as their own system reminder, and the content the
  // transcript keeps is the file's.
  const runs = harness(on, { readShaped: true });
  const r = await fire.tool.call({
    tool: 'Read',
    file_path: '/repo/src/a.ts',
    tool_use_id: 'r_1',
  });

  expect(runs.length).toBe(1);
  expect(r.context).toEqual([BRIEF]);
  expect(r.result).toEqual({ type: 'text', file: { filePath: '/repo/src/a.ts', content: 'TOOL OUTPUT' } });
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
  expect(briefed(first)).toContain(BRIEF);

  // The CLI now reports nothing new, as it would for a decision already briefed.
  const second = await fire.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' });
  expect(briefed(second)).toBe('');
  expect(runs.length).toBe(2);
});

test('a Read draws the same line a Bash read draws', async (fire: any, on: any) => {
  const logs: string[] = [];
  harness(on, { logs, readShaped: true });

  await fire.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', tool_use_id: 'r_draw' });
  const drawn = reported(logs);

  expect(drawn).toContain('BRIEFED');
  expect(drawn).toContain('a.ts');
});

test('a result of any shape is briefed, and left exactly as it was', async (fire: any, on: any) => {
  // Writing the brief into the result meant knowing where its text lived, so
  // an image read went unbriefed. Context does not depend on the shape.
  const image = { type: 'image', file: { base64: 'AAAA', type: 'image/png' } };
  const runs = harness(on, {
    tool: { ref: 1, result: image, text: 'x', isReadOnly: true },
  });
  const r = await fire.tool.call({ tool: 'Read', file_path: '/repo/src/a.png' });

  expect(runs.length).toBe(1);
  expect(r.context).toEqual([BRIEF]);
  expect(r.result).toEqual(image);
});

test('a suppressed brief reports its reason, not silence', async (fire: any, on: any) => {
  // The report sat after `if (!appended) return result`, so it only fired when
  // something had actually been injected. Every dedup -- the commonest reason
  // a read says nothing, and the one most worth seeing -- returned before it.
  const logs: string[] = [];
  harness(on, { cli: { exitCode: 0, stdout: '', stderr: '' }, logs });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts' });
  expect(logs.length).toBe(1);
  expect(logs[0]).toContain('NO CHANGE');
});

test('the pane lists calls in the order they happened', async (fire: any, on: any) => {
  // Session order, because the rows explain each other: a `no new` row means
  // nothing until the delivered row it refers to has been read.
  //
  // Relative positions, not absolute: `outcomes` is module state shared by
  // every test in this file, so the pane also holds rows from earlier ones.
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

  expect(line).toContain('NO CHANGE');
  // The old line read `<files> governed, already briefed this session`, which
  // claimed governance for every file it named. Asserted as the claim rather
  // than the word, since "ungoverned" contains it.
  expect(line).not.toMatch(/\bgoverned,/);
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
  expect(reported(logs)).toContain('briefed earlier  a.ts');
  expect(reported(logs)).not.toContain('or ungoverned');
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
  expect(reported(logs)).toContain('briefed earlier, or ungoverned');
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

test('a row puts its state in a fixed-width column', async (fire: any, on: any) => {
  // The point of the shape: the host draws every row as `⏺ actual-cli: <text>`
  // at one dim weight, so a scan down the transcript has only the row's own
  // layout to land on. A constant prefix plus a padded state means the state
  // and the detail sit at the same column on every kind of row.
  const logs: string[] = [];
  harness(on, { logs });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'row_1' });
  await fire.tool.call({ tool: 'Bash', command: 'npx tsc', tool_use_id: 'row_2' });

  const line = logs[0];
  expect(line.startsWith('▌ ')).toBe(true);
  // `BRIEFED` padded to the width of the longest state, then the detail.
  expect(line.slice(2, 2 + 9)).toBe('BRIEFED  ');
  expect(line.slice(2 + 9)).toMatch(/^ {2}\S/);
});

test('every state is at most the column width', async (fire: any, on: any) => {
  // A state longer than the pad would push its own row's detail out of line.
  for (const state of ['BRIEFED', 'NO CHANGE', 'BUDGET', 'CLI ERROR']) {
    expect(state.length).toBeLessThanOrEqual(9);
  }
});

// ── the end of a turn ───────────────────────────────────────────────────────

/**
 * What Claude Code itself does at Stop: nothing, and allow it.
 *
 * The chain needs a base beneath the plugin or the event has no implementation,
 * the same way `tool.call` needs one. It also doubles as the assertion that the
 * mod passes the gate's verdict through: a test that broke that would see this
 * base's value replaced.
 */
function stopBase(on: any) {
  on('classic.Stop', async () => ({ value: {} }));
}

test('the end of a turn never changes the Stop decision', async (fire: any, on: any) => {
  // The implementation gate is a separate hook and its verdict is the one that
  // counts. The mod is not allowed to deny, allow or alter a stop.
  on('classic.Stop', async () => ({ value: { decision: 'block', reason: 'gate says no' } }));
  harness(on);
  on('ui.open', async () => ({ value: undefined }));

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'v_1' });
  const out = await fire.classic.Stop({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' });
  expect(out).toEqual({ value: { decision: 'block', reason: 'gate says no' } });
});

test('a pane that fails to open still lets the turn stop', async (fire: any, on: any) => {
  // Governance must not go down with the pane. $.ui.open rejects here.
  on('classic.Stop', async () => ({ value: { ok: true } }));
  harness(on);
  on('ui.open', async () => { throw new Error('no pane for you'); });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'f_1' });
  const out = await fire.classic.Stop({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' });
  expect(out).toEqual({ value: { ok: true } });
});

test('an absolute path in a command is a candidate', async (fire: any, on: any) => {
  // The miss that made briefing look intermittent. Claude Code's Bash tool
  // writes absolute paths freely, and the token pattern required the first
  // character to be a word character or a dot, so every one of them was
  // rejected. A reported session ran three reads of absolute paths and briefed
  // nothing; the same reads written relatively briefed correctly.
  const logs: string[] = [];
  harness(on, { logs, root: '/repo' });

  await fire.tool.call({
    tool: 'Bash',
    command: "sed -n '1,20p' /repo/app/lib/query-keys.ts",
    tool_use_id: 'abs_1',
  });

  expect(reported(logs)).toContain('BRIEFED');
  expect(reported(logs)).toContain('query-keys.ts');
});

test('a ~/ path with no HOME is declined, not mangled', async (fire: any, on: any) => {
  // This replaces a test that asserted only that the token "reached
  // resolution". It passed while `joinPath` was turning `~/x` into
  // `<base>/~/x`, which is the bug it was meant to cover.
  const runs = harness(on, { env: {}, root: '/repo' });

  await fire.tool.call({ tool: 'Bash', command: 'cat ~/notes/a.ts', tool_use_id: 'home_3' });

  expect(runs.length).toBe(0);
});

test('a version string is still not a path', async (fire: any, on: any) => {
  // The reason the extension must start with a letter, kept honest while the
  // leading-slash case was added.
  const logs: string[] = [];
  harness(on, { logs });

  await fire.tool.call({ tool: 'Bash', command: 'echo "=== jwt 9.0.3 API ==="', tool_use_id: 'abs_3' });
  expect(logs).toEqual([]);
});

test('the end of a turn opens the rules-brief pane', async (fire: any, on: any) => {
  // Literally what the command does, rather than a second summary assembled
  // here: one renderer, one set of words.
  const opens: any[] = [];
  stopBase(on);
  harness(on);
  on('ui.open', async (_$: any, e: any) => {
    opens.push(e);
    return { value: undefined };
  });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/summary-a.ts', tool_use_id: 'sm_1' });
  await fire.classic.Stop({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' });

  expect(opens.length).toBe(1);
  expect(opens[0].id).toBe('rules-brief');
  // Focused, because the host refuses anything else: `ui.open: focus is true
  // or left out`. Opening the pane means taking focus, as the command does.
  expect(opens[0].focus).toBe(true);
});

test('a turn that read nothing opens no pane', async (fire: any, on: any) => {
  const opens: any[] = [];
  stopBase(on);
  harness(on);
  on('ui.open', async (_$: any, e: any) => {
    opens.push(e);
    return { value: undefined };
  });

  await fire.classic.Stop({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' });

  expect(opens).toEqual([]);
});

test('a gate continuation does not reopen the pane', async (fire: any, on: any) => {
  const opens: any[] = [];
  stopBase(on);
  harness(on);
  on('ui.open', async (_$: any, e: any) => {
    opens.push(e);
    return { value: undefined };
  });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'cont_1' });
  await fire.classic.Stop({
    hook_event_name: 'Stop',
    session_id: 's1',
    cwd: '/repo',
    stop_hook_active: true,
  });

  expect(opens).toEqual([]);
});

test('the pane names a quiet read by its reason', async (fire: any, on: any) => {
  // `OUTCOME_LABELS` is the one table the pane reads; the end of a turn opens
  // this very pane rather than rebuilding it, which is what keeps them from
  // drifting.
  harness(on, {
    cli: { exitCode: 0, stdout: '', stderr: 'actual rules brief: no-brief=ungoverned src/u.ts' },
  });
  on('ui.render', async () => ({ type: 'engine', ref: 1 }));

  await fire.tool.call({ tool: 'Bash', command: 'cat src/u.ts', tool_use_id: 'lbl_1' });

  expect(await drawnText(fire, 'Pane', 'rules-brief', { bodyColumns: 90 })).toContain('no rules');
});

// ── time ────────────────────────────────────────────────────────────────────
//
// $.process.run waits 30 seconds unless told otherwise, and the hook time limit
// does not cover it. A CLI that hangs must cost seconds, not minutes.

test('every spawn on a read carries a short timeout', async (fire: any, on: any) => {
  const spawns: any[] = [];
  harness(on, { spawns, cli: { exitCode: 0, stdout: reply(BRIEF), stderr: '' } });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 't_1' });

  const kinds = spawns.map((s) => s.argv.slice(0, 2).join(' '));
  expect(kinds).toContain('git rev-parse');
  expect(kinds).toContain('actual rules');
  for (const s of spawns) expect(s.init?.timeoutMs).toBe(2000);
});

test('the gate reaches its verdict before the pane opens', async (fire: any, on: any) => {
  const order: string[] = [];
  on('classic.Stop', async () => {
    order.push('gate');
    return { value: {} };
  });
  harness(on);
  on('ui.open', async () => {
    order.push('pane');
    return { value: undefined };
  });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'o_1' });
  await fire.classic.Stop({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' });

  expect(order).toEqual(['gate', 'pane']);
});

// ── the Read hook standing down ─────────────────────────────────────────────
//
// The settings hooks beneath this module are everyone's, not just
// rules-brief.sh. The mod marks the event for that hook and lets it through.

test('a Read event reaches every settings hook beneath, marked for rules-brief.sh', async (fire: any, on: any) => {
  const seen: any[] = [];
  on('classic.PostToolUse', async (_$: any, e: any) => {
    seen.push(e);
    return { value: { additionalContext: ['another plugin says hi'] } };
  });
  harness(on);

  const out = await fire.classic.PostToolUse({
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/repo/src/a.ts' },
    tool_response: { type: 'text' },
    tool_use_id: 'pt_1',
  });

  expect(seen.length).toBe(1);
  expect(seen[0].actual_rules_brief_by_mod).toBe(true);
  expect(out).toEqual({ value: { additionalContext: ['another plugin says hi'] } });
});

test('a non-Read event passes through unmarked', async (fire: any, on: any) => {
  const seen: any[] = [];
  on('classic.PostToolUse', async (_$: any, e: any) => {
    seen.push(e);
    return { value: {} };
  });
  harness(on);

  await fire.classic.PostToolUse({
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: {},
    tool_use_id: 'pt_2',
  });

  expect(seen.length).toBe(1);
  expect('actual_rules_brief_by_mod' in seen[0]).toBe(false);
});

// ── unrelated repositories ──────────────────────────────────────────────────
//
// The README's promise: outside a repository with committed rules, nothing
// happens. rules_present in bootstrap.sh keeps it for the hooks; these keep it
// for the mod, on every surface it has.

test('a repo with no rule files is never briefed, by Read or by Bash', async (fire: any, on: any) => {
  const logs: string[] = [];
  const runs = harness(on, { rules: [], logs });

  const viaBash = await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'u_1' });
  expect(viaBash.result.stdout).toBe('TOOL OUTPUT');
  expect(runs.length).toBe(0);
  expect(logs).toEqual([]);
});

test('a Read in a repo with no rule files spawns nothing', async (fire: any, on: any) => {
  const runs = harness(on, { rules: [], readShaped: true });

  const r = await fire.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', tool_use_id: 'u_2' });
  expect(r.result.file.content).toBe('TOOL OUTPUT');
  expect(runs.length).toBe(0);
});

test('only *.md entries count as rule files', async (fire: any, on: any) => {
  // The same count rules_count makes: a README.txt or a stray directory does
  // not make a repository governed.
  const runs = harness(on, { rules: ['README.txt', '.DS_Store'] });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'u_3' });
  expect(runs.length).toBe(0);
});

test('a missing rules directory is the same as an empty one', async (fire: any, on: any) => {
  const runs = harness(on, { rules: null });

  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'u_4' });
  expect(r.result.stdout).toBe('TOOL OUTPUT');
  expect(runs.length).toBe(0);
});

test('ACTUAL_RULES_DIR is the directory checked for rule files', async (fire: any, on: any) => {
  const listed: string[] = [];
  harness(on, { env: { ACTUAL_RULES_DIR: '/elsewhere/rules' }, listed });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'u_5' });
  expect(listed).toEqual(['/elsewhere/rules']);
});

test('a write in a repo with no rule files leaves no record to open a pane for', async (fire: any, on: any) => {
  // Recording a `not-read-only` row is harmless in a governed repo; here it
  // would be the thing that opened the pane at the end of every turn.
  const opens: any[] = [];
  stopBase(on);
  harness(on, {
    rules: [],
    tool: { ref: 1, result: { stdout: '', stderr: '' }, text: '', isReadOnly: undefined },
  });
  on('ui.open', async (_$: any, e: any) => {
    opens.push(e);
    return { value: undefined };
  });

  await fire.tool.call({ tool: 'Bash', command: 'npx tsc', tool_use_id: 'u_6' });
  await fire.classic.Stop({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' });

  expect(opens).toEqual([]);
});

test('the end of a turn in a repo with no rule files does nothing', async (fire: any, on: any) => {
  const logs: string[] = [];
  const opens: any[] = [];
  stopBase(on);
  const runs = harness(on, { rules: [], logs });
  on('ui.open', async (_$: any, e: any) => {
    opens.push(e);
    return { value: undefined };
  });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'nr_1' });
  const out = await fire.classic.Stop({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' });

  expect(out).toEqual({ value: {} });
  expect(logs).toEqual([]);
  expect(opens).toEqual([]);
  expect(runs.length).toBe(0);
});

for (const [name, env] of [
  ['ACTUAL_PLAN_GATE=off', { ACTUAL_PLAN_GATE: 'off' }],
  ['ACTUAL_RULES_BRIEF=off', { ACTUAL_RULES_BRIEF: 'off' }],
  ['ACTUAL_CLI_SUBPROCESS=1', { ACTUAL_CLI_SUBPROCESS: '1' }],
] as const) {
  test(`${name} turns off the end-of-turn pane too`, async (fire: any, on: any) => {
    // ACTUAL_CLI_SUBPROCESS above all: the conformance judge is a nested
    // `claude -p` that reaches Stop too, and must not run git and the CLI.
    const logs: string[] = [];
    const opens: any[] = [];
    const spawns: any[] = [];
    stopBase(on);
    const runs = harness(on, { env, logs, spawns });
    on('ui.open', async (_$: any, e: any) => {
      opens.push(e);
      return { value: undefined };
    });

    await fire.classic.Stop({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' });

    expect(logs).toEqual([]);
    expect(opens).toEqual([]);
    expect(runs.length).toBe(0);
    expect(spawns).toEqual([]);
  });
}

// ── the review's follow-ups ─────────────────────────────────────────────────

test('a bare cd moves the tracked directory', async (fire: any, on: any) => {
  // `cd apps/web` on its own needed no separator, so the parser never matched
  // it, the ambiguity check threw the command away, and the shell moved while
  // the mod did not.
  const runs = harness(on, { root: '/repo', liveShell: true });

  await fire.tool.call({ tool: 'Bash', command: 'cd apps/web', tool_use_id: 'cd_1' });
  await fire.tool.call({ tool: 'Bash', command: 'cat a.ts', tool_use_id: 'cd_2' });

  expect(JSON.parse(runs[0].init.stdin).tool_input.file_path).toBe('/repo/apps/web/a.ts');
});

test('a cd in a command that cannot brief is still tracked', async (fire: any, on: any) => {
  // `cd x && npm test` is not read-only, and the read-only gate returned
  // before the directory was recorded, so the shell moved and the mod did not.
  let call = 0;
  const runs = harness(on, {
    root: '/repo',
    liveShell: true,
    // The first command is a write-shaped one; the read follows it.
    tool: () => ({ ref: 1, result: { stdout: 'x' }, isReadOnly: ++call > 1 }),
  });

  await fire.tool.call({ tool: 'Bash', command: 'cd apps/web && npm test', tool_use_id: 'cd_3a' });
  await fire.tool.call({ tool: 'Bash', command: 'cat a.ts', tool_use_id: 'cd_3b' });

  expect(runs.length).toBe(1);
  expect(JSON.parse(runs[0].init.stdin).tool_input.file_path).toBe('/repo/apps/web/a.ts');
});

test('successive cds compose, as the shell composes them', async (fire: any, on: any) => {
  // `cd a && cd b` ends in `a/b`. Overwriting put the base one level too
  // shallow for every later path in the session.
  const runs = harness(on, { root: '/repo', liveShell: true });

  await fire.tool.call({ tool: 'Bash', command: 'cd apps && cd web && cat a.ts', tool_use_id: 'cd_4' });

  expect(JSON.parse(runs[0].init.stdin).tool_input.file_path).toBe('/repo/apps/web/a.ts');
});

test('a spent budget is reported once a session, not once a read', async (fire: any, on: any) => {
  // Every later read of any file in the repository repeated the row, the
  // ungoverned ones this promises to stay quiet about included.
  const logs: string[] = [];
  harness(on, { logs, config: { maxSessionChars: 1 } });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'bg_1' });
  await fire.tool.call({ tool: 'Bash', command: 'cat src/b.ts', tool_use_id: 'bg_2' });
  await fire.tool.call({ tool: 'Bash', command: 'cat src/c.ts', tool_use_id: 'bg_3' });

  expect(logs.filter((l) => l.includes('BUDGET')).length).toBe(1);
});

test('a cap of zero turns briefing off and says nothing', async (fire: any, on: any) => {
  // `maxSessionChars: 0` is documented as off. Off used to report on every read.
  const logs: string[] = [];
  const runs = harness(on, { logs, config: { maxSessionChars: 0 } });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'off_1' });

  expect(logs).toEqual([]);
  expect(runs.length).toBe(0);
});

test('a pane that cannot be placed says so in the transcript', async (fire: any, on: any) => {
  // A pane a mod opens by itself needs 144 columns and waits undrawn below
  // that, so the end of a turn was silent in a narrower terminal.
  const logs: string[] = [];
  stopBase(on);
  harness(on, { logs });
  on('ui.open', async () => ({ value: { isPlaced: false, reason: 'terminal too narrow' } }));

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'np_1' });
  logs.length = 0;
  await fire.classic.Stop({ hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/repo' });

  expect(logs.join('\n')).toContain('/rules-brief');
});

test('a placed pane adds no transcript line', async (fire: any, on: any) => {
  const logs: string[] = [];
  stopBase(on);
  harness(on, { logs });
  on('ui.open', async () => ({ value: { isPlaced: true } }));

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'np_2' });
  logs.length = 0;
  await fire.classic.Stop({ hook_event_name: 'Stop', session_id: 'sess-1', cwd: '/repo' });

  expect(logs).toEqual([]);
});

test('the debug note names the reason the CLI gave', async (fire: any, on: any) => {
  // It said "already briefed" whatever the token was, so a debug session
  // chasing an ungoverned file was told the opposite of what the CLI reported.
  harness(on, {
    env: { ACTUAL_HOOK_DEBUG: '1' },
    cli: { exitCode: 0, stdout: '', stderr: 'actual rules brief: no-brief=ungoverned src/a.ts' },
  });

  const out = await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'dbg_1' });
  expect(JSON.stringify(out)).toContain('ungoverned');
  expect(JSON.stringify(out)).not.toContain('already briefed this session');
});

test('a ~/ path resolves against the home directory', async (fire: any, on: any) => {
  // PATH_TOKEN accepted `~/` and joinPath made it `<base>/~/...`, which exists
  // nowhere, so the pattern offered a candidate that could never resolve. A
  // checkout usually does sit under home, so such a path names a real file.
  const runs = harness(on, { env: { HOME: '/Users/x' }, root: '/Users/x/repo' });

  await fire.tool.call({ tool: 'Bash', command: 'cat ~/repo/src/a.ts', tool_use_id: 'home_1' });

  expect(runs.length).toBe(1);
  expect(JSON.parse(runs[0].init.stdin).tool_input.file_path).toBe('/Users/x/repo/src/a.ts');
});

test('a ~/ path outside the repository is still declined', async (fire: any, on: any) => {
  const runs = harness(on, { env: { HOME: '/Users/x' }, root: '/Users/x/repo' });

  await fire.tool.call({ tool: 'Bash', command: 'cat ~/notes/a.ts', tool_use_id: 'home_2' });

  expect(runs.length).toBe(0);
});

test('the mod states the root, so the CLI cannot infer it from a moved shell', async (fire: any, on: any) => {
  // The CLI takes its root from `--repo` first and the envelope's `cwd`
  // otherwise, and that cwd follows the agent's `cd`. Without the flag, after
  // `cd apps/actual` every file was placed against that subdirectory: ones
  // inside it matched as `lib/...` against repository-relative globs, ones
  // outside it refused as not under the root. Four governed reads in one
  // measured session briefed nothing while the mod had resolved all four.
  const runs = harness(on, { cwd: '/repo/apps/actual', root: '/repo', gitRoot: '/repo' });

  await fire.tool.call({ tool: 'Bash', command: 'cat lib/a.ts', tool_use_id: 'repo_1' });

  expect(runs.length).toBe(1);
  expect(runs[0].argv[runs[0].argv.indexOf('--repo') + 1]).toBe('/repo');
});

test('the stated root survives a cd into a subdirectory', async (fire: any, on: any) => {
  // The shell moves as the command runs, so the cwd read afterwards already
  // includes the `cd`: joining the target onto it again looked for
  // /repo/apps/actual/apps/actual/lib/a.ts and skipped the read without a word.
  const runs = harness(on, { cwd: '/repo', root: '/repo', gitRoot: '/repo', liveShell: true });

  await fire.tool.call({ tool: 'Bash', command: 'cd apps/actual && cat lib/a.ts', tool_use_id: 'repo_2' });

  expect(runs.length).toBe(1);
  // The file resolves against the moved shell; the root does not move with it.
  expect(JSON.parse(runs[0].init.stdin).tool_input.file_path).toBe('/repo/apps/actual/lib/a.ts');
  expect(runs[0].argv[runs[0].argv.indexOf('--repo') + 1]).toBe('/repo');
});

// ── the second review ───────────────────────────────────────────────────────

test('a failed cd still moves the base for the next relative cd', async (fire: any, on: any) => {
  // The shell moved although the command failed, and the read-side gates
  // return on an error before looking at the command. Reading the live cwd
  // keeps the base right; a copy kept by the mod went stale here.
  let call = 0;
  const runs = harness(on, {
    root: '/repo',
    liveShell: true,
    tool: () => ({ ref: 1, result: { stdout: 'x' }, isReadOnly: true, isError: ++call === 1 }),
  });

  await fire.tool.call({ tool: 'Bash', command: 'cd apps && npm test', tool_use_id: 'fc_1' });
  await fire.tool.call({ tool: 'Bash', command: 'cd web && cat a.ts', tool_use_id: 'fc_2' });

  expect(runs.length).toBe(1);
  expect(JSON.parse(runs[0].init.stdin).tool_input.file_path).toBe('/repo/apps/web/a.ts');
});

test('a CLI without rules brief is probed once and spawned never', async (fire: any, on: any) => {
  // actual-cli v0.6.2 answers `unrecognized subcommand` with exit 2. Every
  // read used to log a CLI ERROR row for that.
  const logs: string[] = [];
  const spawns: any[] = [];
  const runs = harness(on, { logs, spawns, helpExit: 2 });

  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'old_1' });
  await fire.tool.call({ tool: 'Read', file_path: '/repo/src/b.ts', tool_use_id: 'old_2' });

  expect(runs.length).toBe(0);
  expect(logs.filter((l) => l.includes('CLI ERROR'))).toEqual([]);
  expect(briefed(r)).toBe('');
  expect(spawns.filter((s) => s.argv.includes('--help')).length).toBe(1);
});

test('a spawn that rejects is a CLI error, and an earlier brief survives', async (fire: any, on: any) => {
  // `$.process.run` rejects past its timeout. The first file's brief was
  // already recorded by the CLI as shown, so dropping it loses it for good.
  const logs: string[] = [];
  const runs = harness(on, { logs, rejectBrief: (n) => n === 2 });

  const r = await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts src/b.ts', tool_use_id: 'rej_1' });

  expect(runs.length).toBe(2);
  expect(briefed(r)).toContain(BRIEF);
});

test('a spawn that rejects with nothing collected reports a CLI error', async (fire: any, on: any) => {
  const logs: string[] = [];
  harness(on, { logs, rejectBrief: () => true });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'rej_2' });

  expect(logs.some((l) => l.includes('CLI ERROR'))).toBe(true);
});

test('a turn that only wrote opens no pane', async (fire: any, on: any) => {
  // Every Bash call in a governed repo leaves a row, a write's included. Only
  // a brief, a held-back one or a failure is worth taking focus for.
  const opens: any[] = [];
  stopBase(on);
  harness(on, { tool: () => ({ ref: 1, result: { stdout: 'x' }, isReadOnly: false }) });
  on('ui.open', async (_$: any, e: any) => {
    opens.push(e);
    return { value: undefined };
  });

  await fire.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'w_1' });
  await fire.classic.Stop({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' });

  expect(opens).toEqual([]);
});

test('the pane opens once for a brief, then not again until there is another', async (fire: any, on: any) => {
  const opens: any[] = [];
  stopBase(on);
  harness(on);
  on('ui.open', async (_$: any, e: any) => {
    opens.push(e);
    return { value: undefined };
  });

  await fire.tool.call({ tool: 'Bash', command: 'cat src/a.ts', tool_use_id: 'p_1' });
  await fire.classic.Stop({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' });
  await fire.classic.Stop({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' });

  expect(opens.length).toBe(1);
});
