// register.js - Claude mod: brief the agent on the rules governing a file it
// read through Bash.
//
// Why this exists beside hooks/rules-brief.sh rather than replacing it.
// PostToolUse:Read is the delivery point rules-brief.sh uses, and it is the
// right one -- except that across 212 sampled local sessions, 80% of file
// reads never went through the Read tool at all. They went through `cat`,
// `head`, `sed -n` and `grep` in Bash, which fires no Read hook. 35% of those
// sessions used Bash more than five times and Read exactly zero times. One of
// them (sprintreview session fb5061e2) implemented a whole feature in 35 Bash
// calls, reached the Stop gate with three MUST conflicts, and was never
// briefed once, because there was nothing for PostToolUse:Read to hook.
//
// A settings hook cannot close that gap well: it would need a second
// PostToolUse registration on Bash, a shell-side parse of an arbitrary command
// string, and a CLI spawn per Bash call inside a 2-second timeout. A mod gets
// the command string as data, runs in-process, and spends its CLI time inside
// $.process.run, which the hook time limit explicitly excludes.
//
// Division of labour with rules-brief.sh: that hook owns Read, this mod owns
// Bash, and they never both fire for one tool call. The mod deliberately
// synthesizes a PostToolUse:Read envelope and calls `actual rules brief
// --claude-hook` rather than the simpler `--file` direct mode, because
// --claude-hook is what consults brief memory. Both paths therefore share one
// dedup store and a file read with `cat` after a Read tool call is not briefed
// twice. Direct mode is stateless (verified: same file twice returns the full
// brief both times), so using it here would have meant a second, parallel
// dedup store in the mod.
//
// Advisory by construction, like the hook. It never denies, never rewrites a
// command, and never changes a tool result except to append context. Every
// failure path leaves the result exactly as the tool produced it. There is
// deliberately no .catch handler: a .catch makes a hook fail closed, which is
// right for a gate and wrong for this.

// Phase 1 scope: the plumbing, plus the two facts a real session established
// that no amount of reasoning would have. Both were found by probing an actual
// `claude -p` run, and both corrected a guess:
//
//  1. A Bash tool result's `result` field is an OBJECT ({stdout, stderr,
//     interrupted, isImage, ...}) and the string Claude actually reads is
//     `result.stdout`. The sibling `text` field looks like the obvious answer
//     and is not: a marker appended to `text` never reached the model, while
//     the same marker in `result.stdout` did. Assigning a string to `result`
//     would have replaced the whole object and rendered "[object Object]" in
//     place of the command's output -- the brief destroying what it annotates.
//  2. Claude Code already classifies each Bash command: `isReadOnly` is true
//     for `cat a.txt` and `sed -n 1p a.txt`, and absent for `echo written >
//     b.txt`. That is the read-vs-write signal Phase 2 was going to build a
//     regex for, supplied by the permission system itself.
//
// So classification is not ours to guess. We brief a Bash call only when
// Claude Code says it was read-only, which is both broader than a command
// allowlist (it covers `grep -n file`, pipes, and spellings nobody enumerated)
// and safer: a command Claude Code cannot classify leaves isReadOnly absent,
// and absent means no brief.
//
// Briefing only read-only commands also settles a design question with
// evidence. A write-shaped command has already composed its replacement text
// by the time it exists, so briefing it could only prompt a revision -- which
// is impl-gate.sh's job. Only a read can be briefed before the edit is
// written, which is the whole point of delivering at read time.
//
// What Phase 2 still owes: better *path* extraction -- heredoc bodies, more
// than one path per command -- not classification.

// --- Path extraction ---------------------------------------------------
//
// What this has to get right, measured against the 35 Bash calls of one real
// session (sprintreview fb5061e2) and a live probe of isReadOnly:
//
//   cat a.ts                              one path
//   cat a.ts b.ts                         read-only, TWO paths
//   cat a.ts | head -3                    read-only, pipe
//   cd /abs/dir && cat rel/a.ts           read-only, path relative to /abs/dir
//   grep -n class a.ts                    read-only
//   sed -n 1,2p a.ts                      read-only
//
// 11 of those 35 calls (31%) began with `cd <dir> &&`, every one of them with
// an absolute target, and the targets were not all the repo root -- one was
// apps/actual. A path in such a command resolves against the cd target, not
// the session's cwd, so ignoring the prefix means either missing the file or,
// worse, resolving to a different file that happens to exist at the same
// relative path.

// A token that could be a path with an extension. No `*`, so a glob such as
// `src/*.ts` is not mistaken for a file. No quotes, so `sed -n '1,2p'` and a
// quoted path with a space are both passed over -- the latter is a known and
// accepted miss.
//
// The extension must begin with a letter. Running this over 35 real Bash
// commands, the version string in `echo "=== jwt 9.0.3 API evidence ==="`
// matched a digits-allowed pattern and became a candidate path; `.ts`, `.md`,
// `.json`, `.cjs`, `.tf`, `.yaml` and `.d.ts` all still match.
const PATH_TOKEN = /^[\w.][\w./-]*\.[A-Za-z][A-Za-z0-9]{0,5}$/;

// How many files one command may brief. A command reading six files would
// otherwise inject six briefs at once, which is the volume question Phase 3
// still owes an answer to; until then, cap it low.
const MAX_PATHS_PER_COMMAND = 2;

// Peel any leading `cd <dir> &&` chain off the front and report the directory
// the rest of the command actually runs in. Only a leading chain counts: a
// `cd` later in the pipeline changes the base partway through, and guessing
// which half a path belongs to is worse than declining, so that returns null.
function resolveBase(command) {
  let rest = command.trim();
  let base = null;
  for (;;) {
    const m = /^cd\s+("[^"]+"|'[^']+'|[^\s&|;]+)\s*&&\s*/.exec(rest);
    if (!m) break;
    base = m[1].replace(/^["']|["']$/g, '');
    rest = rest.slice(m[0].length);
  }
  // A `cd` anywhere in what is left makes the base ambiguous.
  if (/(^|[\s&|;])cd\s/.test(rest)) return null;
  // Everything from a heredoc marker on is the body of a document, not argv.
  // Scanning it finds property accessors -- `jwk.kid`, `claims.jti` -- that
  // look exactly like dotted paths. Those commands are never briefed anyway,
  // because Claude Code does not mark a heredoc read-only (probed live, even
  // for one that only reads and prints), but the extractor should not be
  // inventing candidates it would then have to filter.
  const heredoc = rest.indexOf('<<');
  if (heredoc !== -1) rest = rest.slice(0, heredoc);
  return { base, rest };
}

// Join a possibly-relative token onto a base directory, without importing
// path: a mod's whole dependency surface is the mods API, same hygiene rule
// the shell hooks follow for jq and python.
function joinPath(base, token) {
  if (token.startsWith('/')) return token;
  return `${base.replace(/\/+$/, '')}/${token}`;
}

// Collapse `.` and `..` segments so containment can be checked as a string
// prefix. A token that climbs above its base is left with leading `..`, which
// no absolute root prefixes, so it is rejected by the containment test rather
// than needing its own branch.
function normalizePath(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return (p.startsWith('/') ? '/' : '') + out.join('/');
}

function isWithin(root, candidate) {
  const r = normalizePath(root).replace(/\/+$/, '');
  if (r === '' || r === '/') return true;
  return candidate === r || candidate.startsWith(`${r}/`);
}

// The Bash tool runs every command in ONE persistent shell, so a `cd` in any
// call changes the directory every later call runs in -- while
// $.session.cwd() keeps reporting the session's own directory, which does not
// move. Observed in session 9dc24b52: one call did
// `cd <repo>/apps/actual && ...`, and two later calls read
// `lib/oauth/verify-token.ts`, a governed file. Resolved against the session
// cwd those became <repo>/lib/oauth/verify-token.ts, which does not exist, so
// the existence filter dropped them and two briefs were silently lost.
//
// Tracked per session, updated from a leading `cd` chain. Perfect shell
// emulation is not the goal and not achievable -- a `cd` buried in a pipeline,
// a shell variable, a subshell -- so the resolver below treats this as the
// first guess among several rather than the truth.
const shellCwds = new Map();

// Candidate path tokens, plus the directory a leading `cd` chain moved to.
// Resolution is left to the caller, which can check what exists; this stays a
// pure function so the corpus of real commands can be replayed against it.
function candidateTokens(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  const split = resolveBase(command);
  if (!split) return null;

  const tokens = [];
  const seen = new Set();
  // Skip argv[0] of each pipeline stage: `cat`, `head`, `grep` are not paths,
  // and a tool name with a dot (`a.out`) would otherwise look like one.
  for (const stage of split.rest.split(/\||&&|;/)) {
    for (const token of stage.trim().split(/\s+/).slice(1)) {
      if (token.startsWith('-')) continue;
      if (!PATH_TOKEN.test(token)) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
  }
  return { cdTarget: split.base, tokens };
}

// --- What the user sees ---------------------------------------------------
//
// The brief itself has to reach Claude, so it rides in the tool result and
// costs context -- which is why there is a session budget at all. What a
// *person* needs is different: whether a brief happened, what it covered, and
// when one did not, why. A drawn tree costs nothing, because `ui.render`
// output goes to the terminal and the Desktop app and Claude never reads it.
// So everything below is free, and none of it is in the budget.
//
// It is also not a substitute for the brief: nothing draws in `claude -p`, the
// SDK, the VS Code chat panel or a cloud session (hooks still run there). A
// drawing is for the person watching, and there is no person watching those.

// One record per Bash tool call, keyed by its tool_use_id so the ToolResult
// drawing can find the call it belongs to. Bounded: a long session makes
// thousands of tool calls and this is a convenience, not a log.
const MAX_OUTCOMES = 200;
const outcomes = new Map();

function recordOutcome(toolUseId, record) {
  if (!toolUseId) return;
  outcomes.set(toolUseId, { at: Date.now(), ...record });
  while (outcomes.size > MAX_OUTCOMES) {
    const oldest = outcomes.keys().next().value;
    outcomes.delete(oldest);
  }
}

// Read the shape back out of a brief for the one-line summary. Best effort by
// construction: this parses the CLI's human-readable text, which is not a
// contract, so every field is optional and a parse that finds nothing yields a
// character count instead. A summary is cosmetic -- it must never be able to
// affect whether the brief itself was delivered.
function summarize(brief) {
  const decisions = [];
  let current = null;
  for (const line of brief.split('\n')) {
    if (line.startsWith('## ')) {
      current = { title: line.slice(3).trim(), shown: 0, total: 0 };
      decisions.push(current);
    } else if (/^- \[/.test(line)) {
      if (current) current.shown += 1;
    } else {
      // The CLI's own truncation note, which is per decision: the rules listed
      // above it are `shown`, and `total` is how many that decision really has.
      const more = /^- \((\d+) of (\d+) rules shown\)/.exec(line);
      if (more && current) current.total = Number(more[2]);
    }
  }
  // A decision with no note is shown in full, so its total is what it listed.
  for (const d of decisions) if (!d.total) d.total = d.shown;
  return {
    decisions: decisions.map((d) => d.title),
    shown: decisions.reduce((n, d) => n + d.shown, 0),
    total: decisions.reduce((n, d) => n + d.total, 0),
    chars: brief.length,
  };
}

// The line drawn under a tool result. Null for the calls worth saying nothing
// about -- a command that read no governed file is the overwhelming majority,
// and a line on every one of them would be noise rather than information.
function drawnLine(record) {
  if (!record) return null;
  const files = (record.files ?? []).map((f) => f.split('/').pop()).join(', ');
  switch (record.outcome) {
    case 'delivered': {
      const s = record.summary ?? {};
      const n = s.decisions?.length ?? 0;
      const rules =
        s.total && s.total > s.shown
          ? `${s.shown} of ${s.total} rules`
          : `${s.shown ?? 0} rules`;
      return `actual: briefed ${n} ADR${n === 1 ? '' : 's'}, ${rules} — ${files}`;
    }
    case 'deduped':
      return `actual: ${files} governed, already briefed this session`;
    case 'budget':
      return 'actual: briefing budget spent for this session, staying quiet';
    case 'cli-error':
      return `actual: brief unavailable (${record.detail ?? 'CLI error'}) — ${files}`;
    default:
      // 'unresolved', 'no-paths' and 'not-read-only' are recorded for the pane
      // and deliberately not drawn.
      return null;
  }
}

// --- Session budget -----------------------------------------------------
//
// Dedup (shared with the hook, via brief memory) stops the same decision being
// briefed twice. What it cannot bound is accumulation: a session that touches
// many governed files collects many distinct decisions. Measured over three
// real rule sets -- 425, 183 and 219 documents -- a 40-file session accumulates
// 12 to 18 distinct decisions, so roughly 20-30 KB of injected context, and
// 87-100% of sampled files were governed by at least one rule.
//
// `--min-score` cannot substitute for a cap. Its scores form a fixed lattice
// of 0.75 x {1, 1.5, 2, 3, 4} -- five rungs, identical in all three corpora --
// and the score measures how narrowly a rule's `verify` glob was written
// (`ai/**` scores 0.75, `ai/src/mastra/workflows/**/*.ts` scores 3.00), not how
// relevant the rule is. So one threshold behaves differently everywhere: a
// 1.50 floor cuts 70% in one repo, 23% in another and 0% in a third. It stays
// a per-repo escape hatch (`config set --repo rules_min_score`), not a lever
// this mod can set on anyone's behalf.
//
// Hence a hard per-session character cap. It stops rather than truncates: the
// CLI's own --max-chars already drops whole rules from a single brief and says
// how many it left out, and a brief cut mid-rule is worse than no brief -- a
// half-printed MUST can read as permission.

// Measured, not guessed. Against the 425-rule corpus with dedup active, 40
// governed files injected 18,751 characters -- and only 8 of those 40 reads
// produced a brief at all, the other 32 being decisions already delivered.
// Accumulation over that run: 9,039 chars at 10 files, 10,841 at 20, 12,573 at
// 30, 18,751 at 40.
//
// A first guess of 20,000 was wrong: it sits at 94% of the 40-file figure, so
// it would have started dropping briefs in ordinary sessions rather than
// catching runaway ones. This cap exists for pathology -- a session crossing
// hundreds of governed files in many rule areas -- not for tuning relevance,
// which is what dedup and the CLI's own limits are for. 48,000 is about 2.5x
// the measured normal case: roughly 12,000 tokens, or 6% of a 200k context
// window, which is a defensible ceiling for governance context and still stops
// an unbounded climb.
const DEFAULT_MAX_SESSION_CHARS = 48000;

// Per-session totals, keyed by session id so a reload or a second session in
// one process starts clean rather than inheriting a spent budget.
const spent = new Map();

function spendable(sessionId, cap) {
  const used = spent.get(sessionId) ?? 0;
  return Math.max(0, cap - used);
}

function spend(sessionId, chars) {
  spent.set(sessionId, (spent.get(sessionId) ?? 0) + chars);
}

// Said once, on the call that exhausts the budget. Briefing that simply stops
// is the silent-degradation failure this plugin already has one of too many:
// a brief that never arrives is indistinguishable from a file no rule governs.
// One short line makes the difference legible and tells the agent what to do.
const EXHAUSTED_NOTICE =
  'Actual rule briefing has reached its per-session context budget and will ' +
  'stay quiet from here. Run `actual rules brief --file <path>` if you need ' +
  'the rules for a specific file.';

// The one allowlisted shape, as a parse rather than a byte match. The hook has
// to do this with shell parameter expansion and needs five guards to pin the
// shape (see rules-brief.sh); here it is a property read, and every other
// field the CLI might emit -- a decision, continue, a permissionDecision --
// is ignored because it is simply never looked at.
function briefFrom(stdout) {
  if (!stdout) return '';
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return '';
  }
  const context = parsed?.hookSpecificOutput?.additionalContext;
  return typeof context === 'string' ? context : '';
}

// hook_event_name is load-bearing: an envelope without it returns nothing at
// all. session_id is load-bearing differently -- without it the CLI still
// briefs, but silently stops consulting brief memory, so every read of a
// governed file would brief again.
//
// agent_id is the third component of brief memory's key, and omitting it is
// worse than a duplicate brief. A subagent runs with its own context, so a
// decision briefed to the parent has not been shown to it -- which is exactly
// why the CLI keys on it (see brief_memory.rs). Probed in a real subagent, the
// Read hook's envelope carries `agent_id` and this mod's event carries the
// same value as `e.agentId`. Leaving it out filed the subagent's reads under
// the parent's slot, so the subagent would be denied a brief the parent had
// already seen, and the parent would later miss one it never saw. All three
// fields are asserted in the tests.
function envelopeFor({ sessionId, agentId, cwd, filePath }) {
  const envelope = {
    session_id: sessionId,
    cwd,
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath },
    tool_response: { type: 'text' },
  };
  // Omitted rather than sent empty for the main agent, matching the hook: the
  // CLI treats an absent and an empty agent_id the same, but an envelope that
  // mirrors the real one is easier to reason about.
  if (agentId) envelope.agent_id = agentId;
  return JSON.stringify(envelope);
}

// Every tunable is readable two ways: a `userConfig` field, which gives the
// operator a labelled row in the plugin's settings, and an environment
// variable, which an operator can set for one session without editing
// settings. Env wins, the same precedence the three switches above use.
//
// Two reasons it is not userConfig alone. The plugin already established the
// ACTUAL_* convention for exactly this, and `userConfig` values arrive in
// register()'s `options` at load time, which no test harness in this build can
// inject -- a tunable nothing can test is a tunable that quietly stops working.
// Each env name is written as a literal at its call site, not composed from a
// prefix, and the reads sit in one plain function rather than behind a table of
// closures. Claude Code enforces both: `$.env.get` refuses a template with a
// substitution, and `$` may only be passed to a function declared at the top of
// the file. The point is that the variables a mod reads can be listed without
// running it -- `claude plugin validate` prints them, which is the whole reason
// that output is worth showing a security reviewer.
async function readEnvSettings($) {
  const [maxSessionChars, limit, rulesPerDecision, maxChars, minScore] = await Promise.all([
    $.env.get('ACTUAL_RULES_BRIEF_MAX_SESSION_CHARS'),
    $.env.get('ACTUAL_RULES_BRIEF_LIMIT'),
    $.env.get('ACTUAL_RULES_BRIEF_RULES_PER_DECISION'),
    $.env.get('ACTUAL_RULES_BRIEF_MAX_CHARS'),
    $.env.get('ACTUAL_RULES_BRIEF_MIN_SCORE'),
  ]);
  return { maxSessionChars, limit, rulesPerDecision, maxChars, minScore };
}

// The rules directory to govern against. This has to agree with
// bootstrap.sh's rules_dir() exactly, not approximately: brief memory is keyed
// on session_id + agent_id + rules_dir, so any divergence means one read
// briefs twice -- and in a monorepo the mod also governs against the wrong
// rule set. Measured on a fixture whose root and subproject rule sets both
// match one file, before this was forwarded at all: the hook briefed the
// subproject's R-API-001 and the mod, same session, briefed the root's
// R-ROOT-001.
//
// No single mods API call gives that agreement, which four probed layouts
// settled:
//
//   layout                           hook        $.session.root()  repo().root
//   worktree under the project root  worktree    worktree   OK     main repo  X
//   worktree + CLAUDE_PROJECT_DIR    worktree    worktree   OK     main repo  X
//   monorepo subproject as project   subproject  subproject OK     outer repo X
//   launched in a subdirectory       git root    that subdir X      git root   OK
//
// $.session.root() tracks the session's working directory, so it is right for
// a worktree and wrong one directory down; repo().root is the main checkout,
// so it is the reverse. The last row is not academic -- running `claude` from
// a subdirectory pointed the mod at a .actual/rules that does not exist, and
// briefing went silently dead while the hook kept working.
//
// So the mod asks git the same question the hook asks, and applies the same
// rule: when CLAUDE_PROJECT_DIR and the git toplevel are nested, the deeper
// path is the more specific context and wins; otherwise the active checkout
// does. See resolve_repo_root in bootstrap.sh for why each case is that way.
// One git spawn per session, cached, because a session does not change repo.

const repoRoots = new Map();

function deeperOf(projectDir, gitRoot) {
  if (!projectDir) return gitRoot;
  if (!gitRoot) return projectDir;
  const p = projectDir.replace(/\/+$/, '');
  const g = gitRoot.replace(/\/+$/, '');
  if (g === p) return g;
  if (g.startsWith(`${p}/`)) return g; // worktree: nested under the project
  if (p.startsWith(`${g}/`)) return p; // monorepo: subproject inside the repo
  return g; // unrelated: the active checkout wins
}

async function resolveRepoRoot($, sessionId, cwd) {
  if (repoRoots.has(sessionId)) return repoRoots.get(sessionId);
  let gitRoot = null;
  try {
    const run = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd });
    if (run.exitCode === 0) gitRoot = (run.stdout ?? '').trim() || null;
  } catch {
    // Not a repository, or no git. Fall through to the project dir.
  }
  const projectDir = await $.env.get('CLAUDE_PROJECT_DIR');
  const root = deeperOf(projectDir || null, gitRoot) ?? cwd;
  repoRoots.set(sessionId, root);
  return root;
}

async function resolveRulesDir($, sessionId, cwd) {
  const override = await $.env.get('ACTUAL_RULES_DIR');
  if (override) return override;
  const root = await resolveRepoRoot($, sessionId, cwd);
  if (!root) return null;
  return `${root.replace(/\/+$/, '')}/.actual/rules`;
}

// Which keys exist, and the CLI flag each one forwards to. maxSessionChars has
// no flag: it is this mod's own budget, enforced here, not something the CLI
// knows about.
const CLI_FLAGS = {
  limit: '--limit',
  rulesPerDecision: '--rules-per-decision',
  maxChars: '--max-chars',
  minScore: '--min-score',
};

// Env wins over userConfig, the same precedence the three switches above use:
// a settings row is the durable preference, an environment variable is the
// override for one session.
function mergeSettings(fromEnv, options) {
  const resolved = {};
  for (const key of ['maxSessionChars', ...Object.keys(CLI_FLAGS)]) {
    const raw = fromEnv[key];
    const parsed = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
    if (Number.isFinite(parsed)) resolved[key] = parsed;
    else if (Number.isFinite(options[key])) resolved[key] = options[key];
  }
  return resolved;
}

// Pass a limit through to the CLI only when the operator set one, so the CLI's
// own defaults (2 decisions, 8 rules each, 4000 chars, no score floor) stay in
// one place rather than being restated here. --min-score especially: its
// default is the repository's own `rules_min_score`, then the user-wide key,
// and overriding that from here would silently ignore a repo's setting.
function cliLimits(resolved) {
  const argv = [];
  for (const [key, flag] of Object.entries(CLI_FLAGS)) {
    if (Number.isFinite(resolved[key])) argv.push(flag, String(resolved[key]));
  }
  return argv;
}

// What Phase 3 of the plan asked for: the numbers needed to choose a cap,
// rather than a cap chosen from unease.
//
// Two channels, because one is not enough. $.ui.log writes a dim transcript
// line the model does not read, which is the right thing in an interactive
// session -- measuring must not itself change what the session sees. But it
// does not reach `claude -p` stdout, and headless is exactly where a scripted
// measurement over many files would run, so the first attempt at this produced
// nothing at all. The second channel appends the same line to the brief, where
// it rides out on the tool result and is visible anywhere. That one does enter
// the model's context, so it is strictly debug-only.
//
// Neither channel writes a file. A durable log would mean declaring $.fs.write
// on a governance plugin whose audit surface is the thing that makes it
// reviewable, and a debug counter is not worth that.
async function budgetLine($, sessionId, cap) {
  try {
    const used = spent.get(sessionId) ?? 0;
    const usage = await $.session.usage();
    const ctx = usage?.context;
    const where = ctx ? ` context ${ctx.tokens}/${ctx.window} (${ctx.percent}%)` : '';
    const line = `actual rules brief: injected ${used}/${cap} chars this session;${where}`;
    $.ui.log(line);
    return line;
  } catch {
    // Instrumentation must never be the reason a brief fails.
    return '';
  }
}

// Same three switches the shell hooks honour, read through $.env so a test can
// set them. ACTUAL_CLI_SUBPROCESS is not an opt-out but a recursion guard:
// actual-cli runs its conformance judge as a nested `claude -p`, and a judge
// must weigh the rules it was handed, not rules a hook injected into its prompt
// mid-run.
//
// Every mods API call is async, including $.env.get. Reading these without
// awaiting compares a Promise to a string -- never equal, so every opt-out
// silently stops working -- and leaks an unhandled rejection per call. Awaited
// together rather than in sequence: three env reads are independent.
async function optedOut($) {
  const [planGate, briefSwitch, subprocess] = await Promise.all([
    $.env.get('ACTUAL_PLAN_GATE'),
    $.env.get('ACTUAL_RULES_BRIEF'),
    $.env.get('ACTUAL_CLI_SUBPROCESS'),
  ]);
  return planGate === 'off' || briefSwitch === 'off' || subprocess === '1';
}

const PANE = 'rules-brief';

// Rows for the pane, newest first: what each recent Bash call did about
// briefing, including the calls that did nothing and why.
function paneRows(elements) {
  const { Box, Text } = elements;
  const rows = [...outcomes.entries()].reverse();
  if (rows.length === 0) {
    return [Text({ dimColor: true, children: ['No reads yet in this session.'] })];
  }
  return rows.slice(0, 40).map(([id, record], i) => {
    const files = (record.files ?? []).map((f) => f.split('/').pop()).join(', ');
    const label =
      {
        delivered: 'briefed  ',
        deduped: 'already  ',
        budget: 'budget   ',
        'cli-error': 'error    ',
        unresolved: 'no match ',
        'no-paths': 'no path  ',
        'not-read-only': 'writes   ',
      }[record.outcome] ?? record.outcome;
    const detail =
      record.outcome === 'delivered'
        ? `${record.summary?.decisions?.length ?? 0} ADR(s), ${record.summary?.shown ?? 0} of ${record.summary?.total || record.summary?.shown || 0} rules, ${record.summary?.chars ?? 0} chars`
        : record.detail ?? files ?? '';
    return Box({
      key: `row-${i}-${id}`,
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Text({ dimColor: record.outcome !== 'delivered', children: [label] }),
        Text({ children: [files || '—'] }),
        Text({ dimColor: true, children: [detail && detail !== files ? `· ${detail}` : ''] }),
      ],
    });
  });
}

export function register(on, options = {}) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'rules-brief',
        description: 'What rule briefing has done this session, and where it stayed quiet',
      });
    } catch {
      // A mod that cannot register its command still has to brief.
    }
    return next(e);
  });

  on('command.run', { command: 'rules-brief' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Rule briefing', focus: true, closeOnEscape: true });
    return {};
  });

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const elements = $.ui.resolve(e);
    const { Box, Text } = elements;
    return Box({
      flexDirection: 'column',
      children: [
        Text({ bold: true, children: ['Rule briefing this session'] }),
        Text({ children: [' '] }),
        ...paneRows(elements),
      ],
    });
  });

  // One dim line under the tool result that caused a brief. Keeps Claude
  // Code's own drawing and adds to it, rather than replacing it -- the command
  // output is the point and this is a footnote to it.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const theirs = await next(e);
    const line = drawnLine(outcomes.get(e.requestId));
    if (!line) return theirs;
    const { Box, Text } = $.ui.resolve(e);
    return Box({
      flexDirection: 'column',
      children: [theirs, Text({ dimColor: true, children: [`  ⊢ ${line}`] })],
    });
  });

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // Let the command run first. Briefing is advisory, so it must never delay
    // or gate the tool, and a command that fails has nothing worth briefing.
    const result = await next(e);

    try {
      if (await optedOut($)) return result;
      if (result?.deny || result?.isError) return result;
      // Claude Code's own read/write verdict. Absent (not false) for a write,
      // and absent for anything it could not classify -- both mean no brief.
      if (result?.isReadOnly !== true) {
        recordOutcome(e.tool_use_id, { outcome: 'not-read-only' });
        return result;
      }
      // result.stdout is the string Claude reads. Verified by appending a
      // marker to each candidate field in a live session: only the one in
      // result.stdout came back.
      if (typeof result?.result?.stdout !== 'string') return result;

      const [cwd, root, sessionId] = await Promise.all([
        $.session.cwd(),
        $.session.root(),
        $.session.id(),
      ]);
      if (!cwd || !sessionId) return result;

      const rulesDir = await resolveRulesDir($, sessionId, cwd);
      if (!rulesDir) return result;
      const repoRoot = await resolveRepoRoot($, sessionId, cwd);

      const found = candidateTokens(e.command);

      // Record the `cd` before deciding whether there is anything to brief.
      // The command that moves the shell usually names no file of its own --
      // `cd <repo>/apps/actual && ls lib/oauth/` was the real one -- so
      // returning early on "no candidates" would drop the directory and every
      // later relative path would resolve against the wrong base.
      if (found?.cdTarget) {
        shellCwds.set(
          sessionId,
          normalizePath(joinPath(shellCwds.get(sessionId) ?? cwd, found.cdTarget))
        );
      }
      if (!found || found.tokens.length === 0) {
        recordOutcome(e.tool_use_id, { outcome: 'no-paths' });
        return result;
      }
      const shellCwd = shellCwds.get(sessionId) ?? cwd;

      // Resolve each token against the bases it could plausibly be relative
      // to, nearest first, and let the filesystem decide. The shell's own
      // directory comes first because that is what the command actually used;
      // the session cwd and the repo root follow, because a tracked directory
      // can be stale (a `cd` the parser declined to follow) and a path is
      // often written from the repo root regardless of where the shell is.
      //
      // Two filters still gate every spawn. Containment keeps the brief inside
      // the checkout being governed -- `cat /etc/hosts` and a scratchpad file
      // under TMPDIR both name real files no rule governs. Existence settles
      // which base was meant. Letting the CLI answer "no rules" instead would
      // still cost a spawn, once per Bash call, forever.
      // An explicit `cd` in this command names the base, so it is authoritative:
      // `cd /elsewhere && cat a.ts` must not fall back to resolving a.ts inside
      // the repository, which would brief a different file of the same name.
      // Without a `cd` the base is a guess, and these are the candidates worth
      // guessing between -- the shell's tracked directory first, because that is
      // where the command actually ran.
      const bases = found.cdTarget
        ? [shellCwd]
        : [...new Set([shellCwd, cwd, repoRoot].filter(Boolean))];
      const paths = [];
      for (const token of found.tokens) {
        if (paths.length >= MAX_PATHS_PER_COMMAND) break;
        for (const base of bases) {
          const candidate = normalizePath(joinPath(base, token));
          if (!isWithin(repoRoot ?? cwd, candidate)) continue;
          // A rule document is not governed by itself, and agents read their
          // own rules unprompted -- session 9dc24b52 did it in its second Bash
          // call, `cat .actual/rules/cross-cutting-*.md`, which spawned the CLI
          // twice for nothing. Cheap to skip, and it keeps the brief about the
          // code rather than about the rules.
          if (isWithin(rulesDir, candidate)) continue;
          const ex = await $.fs.exists(candidate);
          $.ui.log('EX=' + JSON.stringify(ex) + ' type=' + typeof ex);
          if (!ex) continue;
          if (!paths.includes(candidate)) paths.push(candidate);
          break;
        }
      }
      if (paths.length === 0) {
        // Tokens that looked like paths but resolved to nothing inside the
        // repository. Common and uninteresting on its own; the pane shows it.
        recordOutcome(e.tool_use_id, { outcome: 'unresolved', tokens: found.tokens });
        return result;
      }

      const resolved = mergeSettings(await readEnvSettings($), options);
      const cap = Number.isFinite(resolved.maxSessionChars)
        ? resolved.maxSessionChars
        : DEFAULT_MAX_SESSION_CHARS;

      let remaining = spendable(sessionId, cap);
      if (remaining <= 0) {
        recordOutcome(e.tool_use_id, { outcome: 'budget', files: paths });
        return result;
      }

      let appended = '';
      let exhausted = false;
      let cliError = null;
      const summaries = [];
      for (const filePath of paths) {
        const run = await $.process.run(
          [
            'actual', 'rules', 'brief', '--claude-hook',
            '--rules-dir', rulesDir,
            ...cliLimits(resolved),
          ],
          { stdin: envelopeFor({ sessionId, agentId: e.agentId, cwd, filePath }), cwd }
        );
        if (run.exitCode !== 0) {
          cliError = `exit ${run.exitCode}`;
          continue;
        }
        const brief = briefFrom(run.stdout);
        if (!brief) continue;

        // A brief that does not fit is dropped whole, and the budget is
        // declared spent. Taking the next, smaller brief instead would make
        // which rules an agent sees depend on the order it happened to read
        // files in.
        if (brief.length > remaining) {
          exhausted = true;
          break;
        }
        appended += (appended ? '\n\n' : '') + brief;
        remaining -= brief.length;
        summaries.push(summarize(brief));
      }

      if (exhausted) {
        // Spend the rest of the budget so the notice is emitted once, not on
        // every subsequent read.
        spend(sessionId, cap);
        // Claude is told as well as the user, deliberately. The drawn toast is
        // for the person watching; Claude still needs to know that briefing has
        // stopped, or it is back to not being able to tell silence from a file
        // no rule governs.
        appended += (appended ? '\n\n' : '') + EXHAUSTED_NOTICE;
        $.ui.toast('Actual rule briefing has reached its per-session context budget.');
      } else if (appended) {
        spend(sessionId, appended.length);
      }

      if (appended) {
        // One record for the call, merging what each file contributed.
        recordOutcome(e.tool_use_id, {
          outcome: exhausted ? 'budget' : 'delivered',
          files: paths,
          summary: {
            decisions: summaries.flatMap((x) => x.decisions),
            shown: summaries.reduce((n, x) => n + x.shown, 0),
            total: summaries.reduce((n, x) => n + x.total, 0),
            chars: appended.length,
          },
        });
      } else if (cliError) {
        recordOutcome(e.tool_use_id, { outcome: 'cli-error', files: paths, detail: cliError });
      } else {
        // Resolved a governed file and the CLI said nothing: every applicable
        // decision has already been briefed this session. The single most
        // useful thing to be able to see, because it is the one case where
        // silence is correct.
        recordOutcome(e.tool_use_id, { outcome: 'deduped', files: paths });
      }

      if (options.debug || (await $.env.get('ACTUAL_HOOK_DEBUG'))) {
        const line = await budgetLine($, sessionId, cap);
        if (line) appended += (appended ? '\n\n' : '') + line;
      }

      if (!appended) return result;
      return {
        ...result,
        result: { ...result.result, stdout: `${result.result.stdout}\n\n${appended}` },
      };
    } catch {
      // Fail open, silently, exactly as the shell hook does. A governance aid
      // that disturbs the agent's loop when it malfunctions is worse than one
      // that says nothing.
      return result;
    }
  });
}
