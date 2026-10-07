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

// A token that looks like a path with an extension. Deliberately narrow:
// over-extraction costs a wasted ~20ms CLI call, and the CLI answers nothing
// for a file no rule governs, so a false candidate is cheap and a false
// negative is a missed brief.
const PATH_TOKEN = /^[\w.][\w./-]*\.[A-Za-z0-9]{1,6}$/;

// First path-shaped token in the command. One path per call in Phase 1: the
// common read is a single file, and briefing several at once is exactly the
// volume question Phase 3 has to answer first.
function candidatePaths(command) {
  if (typeof command !== 'string' || command.length === 0) return [];
  const out = [];
  for (const token of command.trim().split(/\s+/).slice(1)) {
    if (token.startsWith('-')) continue;
    if (PATH_TOKEN.test(token)) out.push(token);
  }
  return out.slice(0, 1);
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

      const paths = candidatePaths(e.command);
      if (paths.length === 0) return result;

      const cwd = await $.session.cwd();
      const sessionId = await $.session.id();
      if (!cwd || !sessionId) return result;

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
