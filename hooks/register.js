// register.js - Claude mod: brief the agent on the rules governing a file it
// read, through the Read tool or through Bash.
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
// Division of labour with rules-brief.sh: this mod hooks both Read and Bash,
// and where it loads it stands the hook down for Read (STAND_DOWN_FIELD, below)
// so one brief is delivered once, by the path that has a budget and a record.
// The hook remains for versions of Claude Code that cannot load a mod. The mod deliberately
// synthesizes a PostToolUse:Read envelope and calls `actual rules brief
// --claude-hook` rather than the simpler `--file` direct mode, because
// --claude-hook is what consults brief memory. Both paths therefore share one
// dedup store and a file read with `cat` after a Read tool call is not briefed
// twice. Direct mode is stateless (verified: same file twice returns the full
// brief both times), so using it here would have meant a second, parallel
// dedup store in the mod.
//
// Advisory by construction, like the hook. It never denies, never rewrites a
// command, and never changes a tool result: a brief goes beside the result, in
// the call's `context`. Every failure path leaves the result exactly as the
// tool produced it. There is
// deliberately no .catch handler: a .catch makes a hook fail closed, which is
// right for a gate and wrong for this.

// Phase 1 scope: the plumbing, plus the two facts a real session established
// that no amount of reasoning would have. Both were found by probing an actual
// `claude -p` run, and both corrected a guess:
//
//  1. Where a brief goes. A tool.call result's `context` is what the model
//     reads after the tool's result. Probed on 2.1.287 with a marker for both
//     Read and Bash: the model received each as its own system reminder
//     ("tool.call hook additional context"), and the transcript recorded it
//     as a hook_additional_context attachment beside an untouched tool result
//     -- the channel a PostToolUse hook's additionalContext uses. An earlier
//     version appended the brief to result.stdout and result.file.content
//     instead, which put rule text inside the file as the model read it and
//     inside the tool result the transcript kept.
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
//
// Edit and Write are the one exception to "only a read", and a narrow one
// (AK-794). Claude Code makes the agent Read a file before editing or
// overwriting it, so for an existing file the Read brief has already landed
// and the CLI answers the edit with silence. What is left is a file written
// without a Read -- mostly a new one from Write -- which no read-time brief
// could ever reach. Its brief lands with the tool result, after the write ran,
// so it is a reminder that can prompt a revision, not a briefing ahead of the
// work. The Bash write path stays unbriefed: a shell write names its file
// inside an arbitrary command string, and the Stop gate covers it.

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
//
// A leading `/` or `~/` is allowed. Without it every absolute path was
// rejected, because the first character had to be a word character or a dot --
// and Claude Code's Bash tool writes absolute paths freely. A reported session
// ran `sed -n '1,20p' /Users/.../app/lib/query-keys.ts` and two `cat`s of
// absolute paths, and all three briefed nothing while the same reads written
// relatively briefed correctly, which made the whole feature look intermittent.
const PATH_TOKEN = /^(\/|~\/)?[\w.][\w./-]*\.[A-Za-z][A-Za-z0-9]{0,5}$/;

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
    // `&&` or `;`, and a `cd` that ends the command has neither. A bare
    // `cd apps/web` was previously not a base at all: the regex needed a
    // separator, so the loop never matched, the `cd` was still in `rest`, and
    // the ambiguity check below threw the whole command away. The shell kept
    // the new directory and this mod did not, so every later relative path
    // resolved against the wrong base.
    const m = /^cd\s+("[^"]+"|'[^']+'|[^\s&|;]+)\s*(?:&&|;|$)\s*/.exec(rest);
    if (!m) break;
    const target = m[1].replace(/^["']|["']$/g, '');
    // Successive `cd`s compose, as the shell composes them: `cd a && cd b`
    // ends in `a/b`, not `b`. Overwriting made the second one win, which put
    // the base one directory too shallow for the rest of the session.
    base = base === null || target.startsWith('/') ? target : joinPath(base, target);
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

// Why a file a Read, Edit or Write names outright is not worth a spawn, or
// null when it is: the Bash path's two filters, for the tools that skip its
// parsing. Without them every scratchpad write -- Claude Code keeps one under
// TMPDIR -- and every edit of a rule document spawned the CLI to hear "no".
//
// Outside only when outside the root, the session's directory and the
// session's project root alike. The root can be git's physical path while
// Claude names files by the logical one a symlinked checkout was opened
// through; a test against the root alone would skip governed files there,
// silently. The cwd covers that until the shell runs `cd apps/web`, after
// which a file elsewhere in the checkout is under neither; the project root
// ($.session.root()) is the logical path the session was opened at, or the
// one `/cd` or a worktree move took it to, and a shell `cd` does not move it.
// A file inside the rules directory is a rule document, which is not governed
// by itself.
function unbriefable(named, { repoRoot, cwd, sessionRoot, rulesDir }) {
  if (![repoRoot, cwd, sessionRoot].filter(Boolean).some((base) => isWithin(base, named))) return 'outside-root';
  if (rulesDir && isWithin(rulesDir, named)) return 'ungoverned';
  return null;
}

// The Bash tool runs every command in ONE persistent shell, so a `cd` in any
// call changes the directory every later call runs in. On Claude Code 2.1.296
// `$.session.cwd()` follows that shell: after `cd apps/actual && ls lib/oauth`
// the next call reads `<repo>/apps/actual`. That is why nothing is tracked
// here -- the cwd read after a call is already where the shell ended up, and
// the only arithmetic left is for the call that did the `cd`, whose relative
// target must be joined onto the directory the call STARTED in (see the
// tool.call handler). A copy of the shell's directory kept here drifted from
// the real one on every failed `cd`, and doubled every relative one.
//
// Perfect shell emulation is not the goal and not achievable -- a `cd` buried
// in a pipeline, a shell variable, a subshell -- so the resolver treats the
// shell's directory as the first guess among several rather than the truth.

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

// Under ACTUAL_HOOK_DEBUG, say what briefing decided -- including, and
// especially, when it decided nothing. The first version of this reported only
// from the point where a brief was already being appended, which left every
// case worth debugging silent: a command that was not read-only, a token that
// resolved to nothing, a spent budget, and a mod that never loaded all looked
// identical from a transcript. Three sessions were spent unable to tell them
// apart. The line rides out in the call's context, which the session
// transcript records even under `claude -p`, where $.ui.log does not reach.
// The model reads it too, so it is debug-gated.
async function debugNote($, outcome, detail) {
  const enabled = await $.env.get('ACTUAL_HOOK_DEBUG');
  if (!enabled) return '';
  return `actual rules brief [debug]: ${outcome}${detail ? ` -- ${detail}` : ''}`;
}

// Hand text to the model beside a tool's result, never inside it, so the
// result is the same whatever the tool's shape. Entries already there are
// kept: a hook beneath hands its context over whole. Returns the result
// untouched when there is no text, so the quiet path allocates nothing.
function withContext(result, text) {
  if (!text) return result;
  return { ...result, context: [...(result.context ?? []), text] };
}

// --- What the user sees ---------------------------------------------------
//
// The brief itself has to reach Claude, so it rides in the tool result and
// costs context -- which is why there is a session budget at all. What a
// *person* needs is different: whether a brief happened, what it covered, and
// when one did not, why. A `$.ui.log` row or the pane costs nothing,
// because they go to the terminal and the Desktop app and Claude never reads
// them. So everything below is free, and none of it is in the budget.
//
// It is also not a substitute for the brief: nothing shows in `claude -p`, the
// SDK, the VS Code chat panel or a cloud session (hooks still run there). The
// report is for the person watching, and there is no person watching those.

// One record per Bash tool call, keyed by its tool_use_id, so a call's
// report and the pane's row are the same record. Bounded: a long session makes
// thousands of tool calls and this is a convenience, not a log.
const MAX_OUTCOMES = 200;
// A quiet read's own outcome name, when every file was quiet for one reason.
// `already-briefed` is left out on purpose: that is the `deduped` row, whose
// line can also speak for a mixed call.
const QUIET_OUTCOMES = {
  ungoverned: 'ungoverned',
  'nothing-to-show': 'no-text',
  'outside-root': 'outside-root',
  'no-rules': 'no-rule-set',
};

// Per session, not per process. `spent` and `repoRoots` are both
// keyed by session and this was not, so a pane headed "this session" listed
// reads from before a `/clear` -- and from any other session sharing the
// process -- as though they were this one's.
// Sessions that have already been told the budget is spent.
const budgetAnnounced = new Set();

const outcomes = new Map();

function outcomesFor(sessionId) {
  let own = outcomes.get(sessionId);
  if (!own) {
    own = new Map();
    outcomes.set(sessionId, own);
  }
  return own;
}

function recordOutcome(sessionId, toolUseId, record) {
  if (!toolUseId) return;
  const own = outcomesFor(sessionId);
  own.set(toolUseId, { at: Date.now(), ...record });
  while (own.size > MAX_OUTCOMES) {
    own.delete(own.keys().next().value);
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

// `1 rule`, `2 rules`: the brief that names one rule says so.
function counted(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// The transcript row for one call. Null for the calls worth saying nothing
// about -- a command that read no governed file is the overwhelming majority,
// and a line on every one of them would be noise rather than information.
// The sentence for one call's outcome, without a prefix: $.ui.log adds the
// plugin's name itself.
//
// Reported through $.ui.log alone. An earlier version also drew the line under
// the tool call through `ui.render`, which looked better placed but could not
// be relied on -- Claude Code collapses some calls into a summary row whose id
// is not the call's, so the line vanished. Keeping both channels meant every
// expanded call reported its brief twice, once in each, which a real session
// showed six times over. One channel that always works beats two that
// sometimes do.
function names(files) {
  return files.map((f) => f.split('/').pop()).join(', ');
}

// A row's three columns: a state in caps, what it amounted to, then the files.
//
// The host draws every one of these as `⏺ actual-cli: <text>` at one dim
// weight -- $.ui.log carries text and nothing else, no colour and no bold -- so
// the only way to make a row findable is its shape. A bar glyph gives a column
// of rows a left edge, and a fixed-width state in caps puts the same word in
// the same place every time, so a scan down the transcript lands on it without
// reading the sentence.
//
// The state is padded to the longest of them, which is why the detail and the
// files line up across rows of different kinds.
const STATE_WIDTH = 9;

function row(state, detail, files) {
  const columns = [state.padEnd(STATE_WIDTH), detail];
  if (files) columns.push(`  ${files}`);
  return `\u258c ${columns.join('  ')}`;
}

function reportLine(record) {
  if (!record) return null;
  const files = names(record.files ?? []);
  switch (record.outcome) {
    case 'delivered': {
      const s = record.summary ?? {};
      const n = s.decisions?.length ?? 0;
      // A brief whose text did not parse still reports its size: the count is
      // the one thing always known, and "0 ADRs" reads as a failure.
      if (n === 0) return row('BRIEFED', `${s.chars ?? 0} chars`, files);
      const rules =
        s.total && s.total > s.shown
          ? `${s.shown} of ${counted(s.total, 'rule')}`
          : counted(s.shown ?? 0, 'rule');
      return row('BRIEFED', `${counted(n, 'ADR')} \u00b7 ${rules}`, files);
    }
    case 'deduped': {
      // Only the files this row can speak for. `unknown` is a CLI too old to
      // name a reason, which keeps both meanings rather than picking one.
      const by = (want) =>
        (record.files ?? []).filter((f) => ((record.reasons ?? {})[f] ?? 'unknown') === want);
      const known = by('already-briefed');
      const unsure = by('unknown');
      const groups = [];
      if (known.length) groups.push(`briefed earlier  ${names(known)}`);
      if (unsure.length) groups.push(`briefed earlier, or ungoverned  ${names(unsure)}`);
      if (groups.length === 0) return null;
      return row('NO CHANGE', groups.join('  \u00b7  '));
    }
    case 'ungoverned':
    case 'no-text':
    case 'outside-root':
    case 'no-rule-set':
      // Quiet for a reason that is not about this read: see the pane, which
      // names all four.
      return null;
    case 'budget':
      // Reported once by deliverBrief when the budget runs out, not per read.
      return null;
    case 'cli-error':
      return row('CLI ERROR', record.detail ?? 'CLI error', files);
    default:
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
//
// The event and tool are what the call was: a Bash or Read call is a
// PostToolUse:Read, an Edit or Write call is a PreToolUse on that tool -- the
// two pairs the CLI answers, and the ones hooks/rules-brief.sh forwards. The
// CLI keeps one brief memory across both, so a file briefed by either is not
// briefed again by the other.
function envelopeFor({ sessionId, agentId, cwd, filePath, tool = 'Read' }) {
  const write = WRITE_TOOLS.includes(tool);
  const envelope = {
    session_id: sessionId,
    cwd,
    hook_event_name: write ? 'PreToolUse' : 'PostToolUse',
    tool_name: write ? tool : 'Read',
    tool_input: { file_path: filePath },
  };
  if (!write) envelope.tool_response = { type: 'text' };
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
//   launched in a subdirectory       that subdir that subdir OK     git root   X
//
// $.session.root() tracks the session's working directory, so it is right for
// a worktree and right one directory down too: the hook resolves that
// subdirectory as well, because CLAUDE_PROJECT_DIR names it. repo().root is
// the main checkout, so it is wrong in every row.
//
// The last row was recorded the other way round here, on the assumption that
// the hook picks the git root. It does not, and a test that asserted it kept
// the error in place. Measured in a live session: with the subproject as the
// project directory, a Read briefed the subproject's decision and a `cat` of
// the same file briefed two of the root's, 3,296 characters, and the model
// received both.
//
// So the mod asks git the same question the hook asks, and applies the same
// rule: when CLAUDE_PROJECT_DIR and the git toplevel are nested, the deeper
// path is the more specific context and wins; otherwise the active checkout
// does. See resolve_repo_root in bootstrap.sh for why each case is that way.
// One git spawn per session and project root, cached. `/cd` and a worktree
// move change $.session.root() and a shell `cd` does not, so only a real move
// asks again.

const repoRoots = new Map();

// Per process, unlike the maps around it: the first $.session.root() this load
// of the module resolves, which the count's reading at session start makes
// before anything can move the session. CLAUDE_PROJECT_DIR stays there for the
// gates through `/cd`, a worktree move and `/clear`, and this stands in for it.
let launchRoot;

// Every spawn's timeout: the PostToolUse:Read hook's own budget in hooks.json.
// $.process.run waits 30 seconds when given none, and the hook time limit does
// not cover it, so a CLI that hangs would stall every read for that long. A
// spawn that times out does not return: `$.process.run` rejects, as it does
// when the command cannot start, so each caller catches it.
const SPAWN_TIMEOUT_MS = 2000;

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

// `~` expanded once per session. PATH_TOKEN accepts a `~/` token, and without
// this `joinPath` made it `<base>/~/repos/...`, which exists nowhere -- so the
// pattern offered a candidate that could never resolve. It matters because a
// checkout usually does sit under the home directory, so `cat ~/repos/x/a.ts`
// names a file this mod governs.
const homeDirs = new Map();

async function resolveHome($, sessionId) {
  if (homeDirs.has(sessionId)) return homeDirs.get(sessionId);
  let home = null;
  try {
    home = (await $.env.get('HOME')) || null;
  } catch {
    // No HOME: a `~` token simply stays unresolvable, as before.
  }
  homeDirs.set(sessionId, home);
  return home;
}

// Whether the installed CLI has `rules brief` at all, asked once a session the
// way preflight asks it (`have_rules_brief` in bootstrap.sh). actual-cli v0.6.2,
// the latest release, answers `unrecognized subcommand` with exit 2 -- and
// without this every read in a governed repository logged a CLI ERROR row for
// a state the person cannot do anything about mid-turn. Preflight already
// tells the agent once to upgrade.
//
// Only a definite answer is kept. A probe that times out says nothing about
// the CLI, so the next read asks again.
const briefAvailable = new Map();

async function rulesBriefAvailable($, sessionId, cwd) {
  if (briefAvailable.has(sessionId)) return briefAvailable.get(sessionId);
  let ok = false;
  let definite = true;
  try {
    const run = await $.process.run(['actual', 'rules', 'brief', '--help'], {
      cwd,
      timeoutMs: SPAWN_TIMEOUT_MS,
    });
    ok = run.exitCode === 0;
  } catch {
    // Cannot start (no `actual` on PATH) or still running at the timeout. The
    // first is as definite as an exit code; the second is not distinguishable
    // from it here, so neither is cached against the session for good.
    definite = false;
  }
  if (definite) briefAvailable.set(sessionId, ok);
  return ok;
}

async function resolveRepoRoot($, sessionId, cwd) {
  const sessionRoot = await $.session.root();
  if (!launchRoot) launchRoot = sessionRoot;
  const key = `${sessionId}\n${sessionRoot}`;
  if (repoRoots.has(key)) return repoRoots.get(key);
  let gitRoot = null;
  try {
    // Run in the root the answer is cached under, not the caller's cwd: the
    // first call after a move can come from wherever the shell has gone.
    const run = await $.process.run(['git', 'rev-parse', '--show-toplevel'], {
      cwd: sessionRoot || cwd,
      timeoutMs: SPAWN_TIMEOUT_MS,
    });
    if (run.exitCode === 0) gitRoot = (run.stdout ?? '').trim() || null;
  } catch {
    // Not a repository, or no git. Fall through to the project dir.
  }
  // CLAUDE_PROJECT_DIR is set for hook processes, not for a mod, so this read
  // returns nothing in a live session and `deeperOf` fell back to the git root
  // every time -- which is how the mod came to brief a monorepo subproject
  // from the root's rule set while the hook briefed it from the subproject's.
  // The launch root stands in for it. A moved root decides only the cache key
  // and where git runs, which is the part of the gates' answer that follows
  // their cwd.
  const projectDir = (await $.env.get('CLAUDE_PROJECT_DIR')) || launchRoot;
  const root = deeperOf(projectDir || null, gitRoot) ?? cwd;
  repoRoots.set(key, root);
  return root;
}

async function resolveRulesDir($, sessionId, cwd) {
  const override = await $.env.get('ACTUAL_RULES_DIR');
  if (override) return override;
  const root = await resolveRepoRoot($, sessionId, cwd);
  if (!root) return null;
  return `${root.replace(/\/+$/, '')}/.actual/rules`;
}

// The rules directory, but only when it holds a rule file -- rules_present in
// bootstrap.sh, counting the same way: top-level `*.md` entries. Null means
// this repository has nothing to govern against, and every handler below must
// then be a silent no-op: no CLI spawn, no record, no transcript line, no
// pane. Installing the plugin must not be visible in unrelated repositories.
//
// Not cached: a session can commit its first rule file partway through, and
// the hook re-checks on every Read for the same reason. A listing is in-process
// and cheap; the repo root underneath it is already cached per session and
// project root.
async function governedRulesDir($, sessionId, cwd) {
  const rulesDir = await resolveRulesDir($, sessionId, cwd);
  if (!rulesDir) return null;
  let entries;
  try {
    entries = await $.fs.list(rulesDir);
  } catch {
    return null;
  }
  return (entries ?? []).some((entry) => entry.name.endsWith('.md')) ? rulesDir : null;
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
// nothing at all. The second channel adds the same line to the brief, where it
// rides out in the call's context and the session transcript records it, even
// headless. That one does enter the model's context, so it is strictly
// debug-only.
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

// Everything that happens once a set of governed files is in hand: the
// budget, the CLI call per file, the record, and the context handed to the
// model. Shared by the shell path and the Read path so neither can drift
// from the other -- the divergence that produced every key bug in this mod.
async function deliverBrief($, e, result, paths, ctx) {
  const { cwd, sessionId, rulesDir, repoRoot, options } = ctx;
  const resolved = mergeSettings(await readEnvSettings($), options);
  const cap = Number.isFinite(resolved.maxSessionChars)
    ? resolved.maxSessionChars
    : DEFAULT_MAX_SESSION_CHARS;

  // A cap of 0 turns briefing off, which `maxSessionChars` documents. Off has
  // to mean silent: this used to fall through to the budget row below, so the
  // switch that disables the feature made it report on every single read.
  if (cap <= 0) return result;

  let remaining = spendable(sessionId, cap);
  if (remaining <= 0) {
    recordOutcome(sessionId, e.tool_use_id, { outcome: 'budget', files: paths });
    // Said once a session, not once a read. The budget is spent for the rest
    // of the session, so every later read of any file in the repository --
    // including the ungoverned ones this promises to stay quiet about --
    // repeated the same row. The pane still lists each one.
    if (!budgetAnnounced.has(sessionId)) {
      budgetAnnounced.add(sessionId);
      $.ui.log(row('BUDGET', `${cap} chars spent; quiet for the rest of this session`));
    }
    return withContext(result, await debugNote($, 'not briefed', `session budget of ${cap} chars is spent`));
  }

  if (!(await rulesBriefAvailable($, sessionId, cwd))) {
    recordOutcome(sessionId, e.tool_use_id, { outcome: 'no-cli', files: paths });
    return withContext(result, await debugNote($, 'not briefed', '`actual rules brief` is not available in this CLI'));
  }

  let appended = '';
  let exhausted = false;
  let cliError = null;
  const summaries = [];
  // Which files actually contributed, as opposed to which resolved. A
  // command naming two governed files where only one has anything new to
  // say must not be reported as having briefed both: `package.json,
  // pnpm-lock.yaml` read as two sources when the lockfile contributed
  // nothing, which is exactly the kind of thing this line exists to make
  // visible and so must not itself misstate.
  const briefedFiles = [];
  // Why each quiet file was quiet, from the CLI's stderr. Hook-mode stdout
  // cannot say -- it carries the brief the model reads -- so the reason is
  // named on stderr as `no-brief=<token>`, which the model never sees.
  const reasons = new Map();
  for (const filePath of paths) {
    let run;
    try {
      run = await $.process.run(
        [
          'actual', 'rules', 'brief', '--claude-hook',
          // The root, stated rather than inferred. The CLI takes it from
          // `--repo` first and from the envelope's `cwd` otherwise, and that cwd
          // follows the agent's `cd`: measured on 2.1.296, after
          // `cd apps/actual && ls lib/oauth` the next call ran in
          // `<repo>/apps/actual`. The CLI then placed every file against that
          // subdirectory -- files inside it matched as `lib/...` against
          // repository-relative globs, files outside it refused as "not under"
          // -- so four governed reads in one session briefed nothing while this
          // mod had resolved all four correctly. 11 of the 35 Bash calls in the
          // reference session began with `cd <dir> &&`.
          '--repo', repoRoot,
          '--rules-dir', rulesDir,
          ...cliLimits(resolved),
        ],
        {
          stdin: envelopeFor({ sessionId, agentId: e.agentId, cwd, filePath, tool: e.tool }),
          cwd,
          timeoutMs: SPAWN_TIMEOUT_MS,
        }
      );
    } catch {
      // Past the timeout, or the CLI could not start. `$.process.run` rejects
      // for both rather than returning an exit code. Without this the
      // rejection left for the handler's outer catch, which returned the
      // untouched result: no row, and a brief already collected for an earlier
      // file thrown away after the CLI had recorded it as shown.
      cliError = 'timed out or did not start';
      continue;
    }
    if (run.exitCode !== 0) {
      cliError = `exit ${run.exitCode}`;
      continue;
    }
    const reason = /no-brief=([a-z-]+)/.exec(run.stderr ?? '')?.[1];
    if (reason) reasons.set(filePath, reason);
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
    briefedFiles.push(filePath);
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
    recordOutcome(sessionId, e.tool_use_id, {
      outcome: exhausted ? 'budget' : 'delivered',
      files: briefedFiles,
      // Kept so the pane can still show what resolved but said nothing.
      resolved: paths,
      summary: {
        decisions: summaries.flatMap((x) => x.decisions),
        shown: summaries.reduce((n, x) => n + x.shown, 0),
        total: summaries.reduce((n, x) => n + x.total, 0),
        chars: appended.length,
      },
    });
  } else if (cliError) {
    recordOutcome(sessionId, e.tool_use_id, { outcome: 'cli-error', files: paths, detail: cliError });
  } else {
    // Resolved a governed file and the CLI said nothing: every applicable
    // decision has already been briefed this session. The single most
    // useful thing to be able to see, because it is the one case where
    // silence is correct.
    // One outcome name, two very different facts, which is why the CLI now
    // says which. A read whose files are all ungoverned is the common case
    // and reports nothing: in a repo of any size most files are not governed,
    // and a line on every one of them would bury the reads that matter.
    // When every file was quiet for the same reason, the row says which. A
    // mixed call stays `deduped`, whose line names each group.
    const kinds = new Set(paths.map((f) => reasons.get(f) ?? 'unknown'));
    const only = kinds.size === 1 ? [...kinds][0] : null;
    recordOutcome(sessionId, e.tool_use_id, {
      outcome: QUIET_OUTCOMES[only] ?? 'deduped',
      files: paths,
      reasons: Object.fromEntries(reasons),
    });
    // The reason the CLI gave, per file, rather than one guess for all of
    // them. This said "already briefed" whatever the token was, so a debug
    // session chasing an ungoverned or outside-root file was told the
    // opposite of what the CLI had reported.
    const why = paths
      .map((f) => `${f}: ${reasons.get(f) ?? 'no reason given'}`)
      .join('; ');
    const note = await debugNote($, 'not briefed', `nothing new for ${why}`);
    if (note) appended = note;
  }

  if (options.debug || (await $.env.get('ACTUAL_HOOK_DEBUG'))) {
    const line = await budgetLine($, sessionId, cap);
    if (line) appended += (appended ? '\n\n' : '') + line;
  }

  // Report through $.ui.log. An earlier version drew a line under the tool
  // result, which depends on the render site Claude Code uses and collapses
  // some calls into a summary row whose id is not any member call's
  // tool_use_id, so reports went missing. $.ui.log writes a dim transcript
  // line the model does not read and depends on no render site.
  //
  // This reverses an invariant added two commits earlier -- that the mod logs
  // nothing unless debugging. That rule was about leftover debug noise
  // reaching a user's transcript, which is still true of `EX=true`. One
  // deliberate line per brief is the report itself.
  // $.ui.log already prefixes the plugin's name, so the line carried its own
  // prefix twice: `actual-cli: actual: briefed 2 ADRs...`.
  //
  // An Edit or Write reports only what it delivered or what failed. Nearly
  // every edit is of a file already read, so its `NO CHANGE` row would be the
  // same line under every edit of a session; the pane still lists each one.
  const record = outcomesFor(sessionId).get(e.tool_use_id);
  const quietWrite =
    WRITE_TOOLS.includes(e.tool) && record?.outcome !== 'delivered' && record?.outcome !== 'cli-error';
  const report = quietWrite ? null : reportLine(record);
  if (report) $.ui.log(report);


  if (!appended) return result;

  return withContext(result, appended);
}

// One label per outcome, the one table the pane reads. Two
// copies of this drifted apart once already, which is how `no new` and
// `nothing new for` came to say the same thing two ways.
const OUTCOME_LABELS = {
  delivered: 'briefed  ',
  deduped: 'no new   ',
  ungoverned: 'no rules ',
  'no-text': 'no text  ',
  'outside-root': 'off-root ',
  'no-rule-set': 'no set   ',
  budget: 'budget   ',
  'cli-error': 'error    ',
  'no-cli': 'old CLI   ',
  unresolved: 'no match ',
  'no-paths': 'no path  ',
  'not-read-only': 'writes   ',
};

const PANE = 'rules-brief';

// Set on a PostToolUse:Read event this mod is briefing, so hooks/rules-brief.sh
// stands down for it. Read only: PreToolUse uses ACTUAL_SKILL_MOD_SESSION
// instead. The hook matches the literal bytes, so a rename here must be made
// there too.
const STAND_DOWN_FIELD = 'actual_rules_brief_by_mod';

// The tools briefed as a reminder when written, and the ones whose
// PreToolUse registration of rules-brief.sh this mod stands down. Exactly the
// CLI's own list: NotebookEdit names its file as notebook_path and the CLI
// does not answer it.
const WRITE_TOOLS = ['Edit', 'Write'];

// The session this load of the module last announced to rules-brief.sh,
// through the ACTUAL_SKILL_MOD_SESSION variable the hook compares with its own
// session_id. A hot reload starts it over, which costs one repeated set.
let announced;

async function announce($) {
  const sessionId = await $.session.id();
  if (!sessionId || sessionId === announced) return;
  // The same gates as the tool.call path, so a repository with no rules, or
  // briefing switched off, sees nothing of this mod -- not even a variable in
  // every process it starts. Not the maxSessionChars cap: at 0 the mod is
  // still in charge and silent, and announcing is what keeps the hook silent
  // too. Skipping here never costs a brief: the hook runs its own checks.
  if (await optedOut($)) return;
  const cwd = await $.session.cwd();
  if (!cwd || !(await governedRulesDir($, sessionId, cwd))) return;
  // A literal name, so `claude plugin validate` lists exactly this one write.
  await $.env.set('ACTUAL_SKILL_MOD_SESSION', sessionId);
  announced = sessionId;
}

// Rows for the pane, oldest first: what each Bash call did about briefing,
// including the calls that did nothing and why.
//
// In session order, because the rows explain each other -- a `no new` row only
// makes sense once the delivered row above it has stated the rules it is
// suppressing. Newest first put every explanation below the thing it
// explained.
function paneRows(elements, sessionId) {
  const { Box, Text } = elements;
  const rows = [...outcomesFor(sessionId).entries()];
  if (rows.length === 0) {
    return [Text({ dimColor: true, children: ['No reads yet in this session.'] })];
  }
  return rows.slice(-40).map(([id, record], i) => {
    const files = (record.files ?? []).map((f) => f.split('/').pop()).join(', ');
    // Files that resolved but contributed nothing, so a read that looks
    // unbriefed can be told from one that had nothing left to say.
    const quiet = (record.resolved ?? [])
      .filter((f) => !(record.files ?? []).includes(f))
      .map((f) => f.split('/').pop())
      .join(', ');
    const label = OUTCOME_LABELS[record.outcome] ?? record.outcome;
    const detail =
      record.outcome === 'delivered'
        ? `${counted(record.summary?.decisions?.length ?? 0, 'ADR')}, ${record.summary?.shown ?? 0} of ${counted(record.summary?.total || record.summary?.shown || 0, 'rule')}, ${record.summary?.chars ?? 0} chars`
        : record.detail ?? files ?? '';
    return Box({
      key: `row-${i}-${id}`,
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Text({ dimColor: record.outcome !== 'delivered', children: [label] }),
        Text({ children: [files || '—'] }),
        Text({ dimColor: true, children: [detail && detail !== files ? `· ${detail}` : ''] }),
        Text({ dimColor: true, children: [quiet ? `· nothing new for ${quiet}` : ''] }),
      ],
    });
  });
}

// ── the count above the prompt ──────────────────────────────────────────────
//
// The line `actual session summary` builds from brief memory, such as "Actual
// AI: 3 of 12 ADRs added to context · 2 areas with no ADR", drawn exactly as
// the CLI gives it in the band above the prompt, so the model never reads it.
//
// Read in the background at session start, after each main-loop turn, and on
// /clear, compaction, resume and fork. Nothing waits on the CLI, and a call
// that fails or outlasts SPAWN_TIMEOUT_MS keeps the line already shown.

// Per session: the line its band shows, and the refresh that set it. An
// `undefined` line shows nothing (no rule files, or the CLI's line is null).
const sessionCounts = new Map();
let countRefreshes = 0;

// One row: cut at the band's width, never wrapped onto a second.
function fitTo(text, columns) {
  if (!Number.isFinite(columns) || text.length <= columns) return text;
  return columns > 1 ? `${text.slice(0, columns - 1)}\u2026` : '';
}

// A CLI too old to have the subcommand exits non-zero, and one too old to
// build the line answers without it.
async function sessionSummary($, sessionId, rulesDir, repoRoot) {
  const run = await $.process.run(
    ['actual', 'session', 'summary', '--session', sessionId, '--rules-dir', rulesDir, '--json'],
    { cwd: repoRoot, timeoutMs: SPAWN_TIMEOUT_MS }
  );
  if (run.exitCode !== 0) return null;
  const { line } = JSON.parse(run.stdout);
  return line === null || typeof line === 'string' ? { line } : null;
}

// Never rejects. The rules directory is the one the briefs are filed under,
// so the line counts the decisions the CLI recorded for this session: what it
// was briefed, plus those in the brief that overran the budget, which the CLI
// recorded before deliverBrief withheld it. A refresh that lands after a newer
// one leaves the newer line, and the band is asked to redraw only when its
// line changes, because a render answer is cached until
// $.ui.invalidate.
async function refreshCount($) {
  const ticket = ++countRefreshes;
  try {
    if ((await $.env.get('ACTUAL_CLI_SUBPROCESS')) === '1') return;
    const [cwd, sessionId] = await Promise.all([$.session.cwd(), $.session.id()]);
    if (!sessionId) return;
    const rulesDir = await governedRulesDir($, sessionId, cwd);
    let text;
    if (rulesDir) {
      const repoRoot = await resolveRepoRoot($, sessionId, cwd);
      const summary = await sessionSummary($, sessionId, rulesDir, repoRoot);
      if (!summary) return;
      text = summary.line || undefined;
    }
    const last = sessionCounts.get(sessionId);
    if (last && ticket < last.ticket) return;
    sessionCounts.set(sessionId, { ticket, text });
    if (text !== last?.text) $.ui.invalidate('ui.render');
  } catch {
    // A spawn that rejected (no CLI, past the timeout) or output that did not
    // parse: the band keeps what it showed.
  }
}

export function register(on, options = {}) {
  on('session.start', async ($, e, next) => {
    // The count's first reading belongs here: at startup classic.SessionStart
    // fires before the session binds.
    void refreshCount($);
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

  // A subagent's turn ends inside its parent's, whose own end refreshes.
  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) void refreshCount($);
    return next(e);
  });

  // Every later start in this process: /clear, compaction, resume and fork.
  // session.start fires once per process and sees none of them.
  on('classic.SessionStart', ($, e, next) => {
    if (e.source !== 'startup') void refreshCount($);
    return next(e);
  });

  // Claude Code's surveys and every other plugin share this band: the rows
  // beneath are kept, and a survey has the band to itself.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e);
    if (e.props.hasSurvey) return theirs;
    const text = sessionCounts.get(await $.session.id())?.text;
    const row = text ? fitTo(text, e.props.bodyColumns) : '';
    if (!row) return theirs;
    const { Box, Text } = $.ui.resolve(e);
    return Box({ flexDirection: 'column', children: [Text({ children: [row] }), theirs] });
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
        ...paneRows(elements, await $.session.id()),
      ],
    });
  });

  // The Read tool and the shell, through one path. A brief is the same brief
  // either way, and so are the budget, the dedup record and the report row
  // -- which is the point: two implementations of one feature
  // produced four separate bugs where they computed the same key differently.
  // hooks/rules-brief.sh is registered on PostToolUse:Read and does the same
  // job as this mod, for versions of Claude Code that cannot load a mod. Where
  // the mod does load, it stands the hook down rather than briefing beside it:
  // two deliveries of the same brief, one of them with no budget, no record
  // and nothing reported.
  //
  // It stands down that one hook, not the event. The chain beneath a module is
  // every non-managed settings hook, so answering without calling next would
  // silence the person's own PostToolUse:Read hooks and every other plugin's
  // too. Instead the event goes on with STAND_DOWN_FIELD set, and
  // rules-brief.sh exits on seeing it.
  //
  // Probed on 2.1.287: settings hooks run inside this mod's tool.call next(e),
  // before the mod briefs, so the hook would otherwise always brief first; and
  // a field added here reaches the settings hook's stdin as written.
  on('classic.PostToolUse', async ($, e, next) => {
    if (e?.tool_name === 'Read') return next({ ...e, [STAND_DOWN_FIELD]: true });
    return next(e);
  });

  // The same stand-down for the PreToolUse:Edit|Write registration, by another
  // route. This event's `e` is the call's envelope, the tool's arguments
  // spread beside `tool`, so a field could only ride as an argument -- and the
  // arguments are what the permission check judges. Probed on 2.1.287: with
  // one added, auto mode's classifier gave no verdict on the Write, so it
  // never ran; without it, the same Write ran. So the event passes down
  // untouched, and the mod says it is here by an environment variable instead:
  // set before next, for this process and everything it starts after, so the
  // settings hook inherits it (probed on 2.1.287).
  //
  // The value is the session id, not a flag. A `claude` the session starts --
  // from a Bash call, say -- inherits the variable under a session id of its
  // own, so its hook still briefs when no mod loads there. A set that fails
  // costs a second brief, never the call. No decision is added either way, so
  // the normal permission flow is unchanged.
  on('classic.PreToolUse', async ($, e, next) => {
    if (WRITE_TOOLS.includes(e?.tool)) {
      try {
        await announce($);
      } catch {
        // rules-brief.sh briefs beside the mod: a duplicate, not a failure.
      }
    }
    return next(e);
  });

  on('tool.call', { tool: ['Bash', 'Read', ...WRITE_TOOLS] }, async ($, e, next) => {
    // Let the command run first. Briefing is advisory, so it must never delay
    // or gate the tool, and a command that fails has nothing worth briefing.
    //
    // The directory the call starts in is read first: Claude Code moves the
    // shell's directory while the command runs, so after next() a relative
    // `cd` target is already applied to what `$.session.cwd()` reports.
    let startCwd = null;
    try {
      startCwd = (await $.session.cwd()) || null;
    } catch {}
    const result = await next(e);

    try {
      if (await optedOut($)) return result;
      if (result?.deny || result?.isError) return result;

      const [cwd, sessionId] = await Promise.all([$.session.cwd(), $.session.id()]);
      if (!cwd || !sessionId) return result;
      // Before anything is recorded: a repository with no rules has nothing
      // for /rules-brief to list, not even a `not-read-only` row.
      const rulesDir = await governedRulesDir($, sessionId, cwd);
      if (!rulesDir) return result;

      // The command that moves the shell is usually not one that briefs
      // (`cd x && npm test` is not read-only), and a failed one moves it too,
      // so the directory is not read from anything the command's outcome
      // gates: it is the live cwd, or the start-of-call cwd plus the `cd`.
      // Parsing is pure, so doing it here costs nothing on a write.
      const found = e.tool === 'Bash' ? candidateTokens(e.command) : null;

      // An Edit or Write names its file outright, like a Read, and is briefed
      // whatever isReadOnly says: it is the reminder for a file never read.
      if (WRITE_TOOLS.includes(e.tool)) {
        const named = typeof e.file_path === 'string' ? normalizePath(e.file_path) : null;
        if (!named) {
          recordOutcome(sessionId, e.tool_use_id, { outcome: 'no-paths' });
          return withContext(result, await debugNote($, 'not briefed', `the ${e.tool} named no file`));
        }
        const repoRoot = await resolveRepoRoot($, sessionId, cwd);
        const skip = unbriefable(named, { repoRoot, cwd, sessionRoot: await $.session.root(), rulesDir });
        if (skip) {
          recordOutcome(sessionId, e.tool_use_id, { outcome: skip, files: [named] });
          return withContext(result, await debugNote($, 'not briefed', `${named} is ${skip === 'outside-root' ? 'outside the repository' : 'a rule document'}`));
        }
        return await deliverBrief($, e, result, [named], { cwd, sessionId, rulesDir, repoRoot, options });
      }

      // Claude Code's own read/write verdict. Absent (not false) for a write,
      // and absent for anything it could not classify -- both mean no brief.
      if (result?.isReadOnly !== true) {
        recordOutcome(sessionId, e.tool_use_id, { outcome: 'not-read-only' });
        return withContext(result, await debugNote($, 'not briefed', 'Claude Code did not mark this command read-only'));
      }

      const repoRoot = await resolveRepoRoot($, sessionId, cwd);

      // A Read names its file outright, already absolute. Only the shell
      // needs anything parsed out of it.
      if (e.tool === 'Read') {
        const named = typeof e.file_path === 'string' ? normalizePath(e.file_path) : null;
        if (!named) {
          recordOutcome(sessionId, e.tool_use_id, { outcome: 'no-paths' });
          return withContext(result, await debugNote($, 'not briefed', 'the Read named no file'));
        }
        const skip = unbriefable(named, { repoRoot, cwd, sessionRoot: await $.session.root(), rulesDir });
        if (skip) {
          recordOutcome(sessionId, e.tool_use_id, { outcome: skip, files: [named] });
          return withContext(result, await debugNote($, 'not briefed', `${named} is ${skip === 'outside-root' ? 'outside the repository' : 'a rule document'}`));
        }
        return await deliverBrief($, e, result, [named], { cwd, sessionId, rulesDir, repoRoot, options });
      }

      if (!found || found.tokens.length === 0) {
        recordOutcome(sessionId, e.tool_use_id, { outcome: 'no-paths' });
        return withContext(result, await debugNote($, 'not briefed', 'the command named no path-shaped token'));
      }
      // Where the command ran. With a `cd` in it, its target is relative to
      // where the call started; without one, the shell is where it ended.
      const shellCwd = found.cdTarget
        ? normalizePath(joinPath(startCwd ?? cwd, found.cdTarget))
        : cwd;

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
      const home = found.tokens.some((t) => t.startsWith('~/'))
        ? await resolveHome($, sessionId)
        : null;
      const paths = [];
      for (const token of found.tokens) {
        if (paths.length >= MAX_PATHS_PER_COMMAND) break;
        // A `~/` token names one absolute path, so it is resolved against the
        // home directory and not against each base in turn.
        const expanded = token.startsWith('~/') ? (home ? `${home}/${token.slice(2)}` : null) : token;
        if (expanded === null) continue;
        for (const base of bases) {
          const candidate = normalizePath(joinPath(base, expanded));
          if (!isWithin(repoRoot ?? cwd, candidate)) continue;
          // A rule document is not governed by itself, and agents read their
          // own rules unprompted -- session 9dc24b52 did it in its second Bash
          // call, `cat .actual/rules/cross-cutting-*.md`, which spawned the CLI
          // twice for nothing. Cheap to skip, and it keeps the brief about the
          // code rather than about the rules.
          if (isWithin(rulesDir, candidate)) continue;
          if (!(await $.fs.exists(candidate))) continue;
          if (!paths.includes(candidate)) paths.push(candidate);
          break;
        }
      }
      if (paths.length === 0) {
        // Tokens that looked like paths but resolved to nothing inside the
        // repository. Common and uninteresting on its own; the pane shows it.
        recordOutcome(sessionId, e.tool_use_id, { outcome: 'unresolved', tokens: found.tokens });
        return withContext(result, await debugNote($, 'not briefed',
          `no token resolved to a governed file inside the repo: ${found.tokens.join(', ')}`));
      }

      return await deliverBrief($, e, result, paths, { cwd, sessionId, rulesDir, repoRoot, options });
    } catch {
      // Fail open, silently, exactly as the shell hook does. A governance aid
      // that disturbs the agent's loop when it malfunctions is worse than one
      // that says nothing.
      return result;
    }
  });
}
