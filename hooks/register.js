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

// Candidate absolute paths named by a read-only command. Returns at most
// MAX_PATHS_PER_COMMAND, in the order they appear.
function candidatePaths(command, cwd) {
  if (typeof command !== 'string' || command.length === 0) return [];
  const split = resolveBase(command);
  if (!split) return [];

  const base = split.base ?? cwd;
  if (!base) return [];

  const out = [];
  const seen = new Set();
  // Skip argv[0] of each pipeline stage: `cat`, `head`, `grep` are not paths,
  // and a tool name with a dot (`a.out`) would otherwise look like one.
  for (const stage of split.rest.split(/\||&&|;/)) {
    for (const token of stage.trim().split(/\s+/).slice(1)) {
      if (token.startsWith('-')) continue;
      if (!PATH_TOKEN.test(token)) continue;
      const abs = normalizePath(joinPath(base, token));
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    }
  }
  return out.slice(0, MAX_PATHS_PER_COMMAND);
}

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
// governed file would brief again. Both are asserted in the tests.
function envelopeFor({ sessionId, cwd, filePath }) {
  return JSON.stringify({
    session_id: sessionId,
    cwd,
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: filePath },
    tool_response: { type: 'text' },
  });
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

export function register(on) {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    // Let the command run first. Briefing is advisory, so it must never delay
    // or gate the tool, and a command that fails has nothing worth briefing.
    const result = await next(e);

    try {
      if (await optedOut($)) return result;
      if (result?.deny || result?.isError) return result;
      // Claude Code's own read/write verdict. Absent (not false) for a write,
      // and absent for anything it could not classify -- both mean no brief.
      if (result?.isReadOnly !== true) return result;
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

      // Two filters before any spawn. Containment keeps the brief inside the
      // checkout the session is governing -- `cat /etc/hosts` and a scratchpad
      // file under TMPDIR both name real files that no rule governs. Existence
      // catches a token that merely looks like a path. Both are cheap next to
      // a process spawn, and the CLI answering "no rules" is not a substitute:
      // it would still cost the spawn, once per Bash call, forever.
      const within = candidatePaths(e.command, cwd).filter((p) =>
        isWithin(root ?? cwd, p)
      );
      if (within.length === 0) return result;

      const paths = [];
      for (const candidate of within) {
        if (await $.fs.exists(candidate)) paths.push(candidate);
      }
      if (paths.length === 0) return result;

      let appended = '';
      for (const filePath of paths) {
        const run = await $.process.run(
          ['actual', 'rules', 'brief', '--claude-hook'],
          { stdin: envelopeFor({ sessionId, cwd, filePath }), cwd }
        );
        if (run.exitCode !== 0) continue;
        const brief = briefFrom(run.stdout);
        if (brief) appended += (appended ? '\n\n' : '') + brief;
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
