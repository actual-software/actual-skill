// Tests for the dialog a gate's denial raises and for recording a typed
// override (hooks/override-dialog.js, wired by hooks/register.js).
//
// The test's own hooks stand for what sits beneath the mod: plan-gate.sh's
// answer to PreToolUse:ExitPlanMode, impl-gate.sh's to Stop, the dialog's
// answers (the AskUserQuestion call $.ui.ask makes), and the CLI.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { ruleIdsFrom, denialQuestion, readAnswer, overrideOutcome } from './override-dialog.js'

const ROOT = '/repo'
const RULES = '/repo/.actual/rules'
const SESSION = 'session-1'

// The deny text as the CLI's hook_deny_reason writes it for a session.
function denyText(ids: string[], revised = 'A revised plan is re-checked automatically.') {
  const lines = ids.map(
    (id, i) => `${i % 2 ? 'CONFLICT' : 'DECISION'} ${id} (MUST): reason ${i} — rule: "statement" — plan: "span"`,
  )
  lines.push(
    `${revised} Session: ${SESSION}. Only the user can override a rule — the agent must not ` +
      'try. Tell the user they can type `/actual-cli:override <rule-id> [reason]` (or ' +
      '`/actual-cli:override all`) as a message in this session, or run `actual ' +
      'check-override` from an ordinary terminal (see `actual check-override --help`).',
  )
  return lines.join('\n')
}

// What `actual check-override --claude-hook` prints for a recorded override.
const recorded = (keys: string[]) =>
  JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `The user overrode ${keys.join(', ')}.` },
    overridden: keys,
  })
const nothing = (why: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: why } })

function world(
  on: On,
  options: {
    planDeny?: () => string | undefined
    stopBlock?: () => string | undefined
    // The dialog's answers, in order; a `null` dismisses it.
    answers?: (string | null)[]
    // What the CLI prints for each check-override call, by its prompt.
    cli?: (prompt: string, argv: readonly string[]) => { exitCode: number; stdout: string }
    rules?: string[]
    env?: Record<string, string>
  } = {},
) {
  mock.env(on, options.env ?? {})
  const asked: any[] = []
  const submitted: any[] = []
  const overrides: { argv: readonly string[]; prompt: string; stdin: any }[] = []
  const answers = [...(options.answers ?? [])]
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.list', () => {
    const names = options.rules ?? ['R-001.md']
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: `${ROOT}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[1] === 'check-override') {
      const stdin = JSON.parse(e.init?.stdin ?? '{}')
      overrides.push({ argv: e.argv, prompt: stdin.prompt, stdin })
      const out = options.cli?.(stdin.prompt, e.argv) ?? { exitCode: 0, stdout: recorded([`doc::${stdin.prompt.split(' ')[1]}`]) }
      return { value: { ...out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // plan-gate.sh is registered on ExitPlanMode alone; the dialog's own
  // AskUserQuestion call passes through PreToolUse too.
  on('classic.PreToolUse', ($, e: any) => {
    if (e.tool !== 'ExitPlanMode') return {}
    const deny = options.planDeny?.()
    return deny === undefined ? {} : { deny }
  })
  on('classic.Stop', () => {
    const block = options.stopBlock?.()
    return block === undefined ? {} : { block }
  })
  on('tool.call', ($, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      const q = e.questions[0]
      asked.push(q)
      const answer = answers.shift()
      if (answer === null || answer === undefined) return { deny: 'The user dismissed the dialog.' }
      return { ref: 1, result: { questions: e.questions, answers: { [q.question]: answer } }, text: answer }
    }
    return { ref: 1, result: { plan: 'p' }, text: 'approved' }
  })
  on('prompt.submit', ($, e) => {
    submitted.push(e)
    return { text: e.text }
  })
  return { asked, overrides, submitted }
}

const exitPlan = ($: any) => $.tool.call({ tool: 'ExitPlanMode', plan: 'p', tool_use_id: 'x1' })
const labels = (q: any) => q.options.map((o: any) => o.label ?? o)

test('a plan denial asks with revising first and recommended', async ($, on) => {
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001', 'R-SRB-001']), answers: [null] })
  await exitPlan($)
  expect(w.asked.length).toBe(1)
  expect(w.asked[0].question).toBe('Plan blocked by 2 rules: R-AUTH-001, R-SRB-001. What should happen?')
  expect(w.asked[0].header).toBe('Plan blocked')
  expect(labels(w.asked[0])).toEqual([
    'Revise the plan to conform (Recommended)',
    'Override all 2 rules',
  ])
})

test('revise: the agent reads the denial with the choice and no override commands', async ($, on) => {
  const w = world(on, {
    planDeny: () => denyText(['R-AUTH-001']),
    answers: ['Revise the plan to conform (Recommended)'],
  })
  const r: any = await exitPlan($)
  expect(r.isError).toBe(true)
  expect(r.text).toContain('DECISION R-AUTH-001 (MUST)')
  expect(r.text).toContain('The user chose to revise the plan')
  expect(r.text).not.toContain('/actual-cli:override')
  expect(r.text).not.toContain('check-override')
  expect(w.overrides).toEqual([])
})

test('override all: recorded through the dialog, and the plan goes on to its approval', async ($, on) => {
  const w = world(on, {
    planDeny: () => denyText(['R-AUTH-001', 'R-SRB-001']),
    answers: ['Override all 2 rules'],
    cli: () => ({ exitCode: 0, stdout: recorded(['a::R-AUTH-001', 'b::R-SRB-001']) }),
  })
  const r: any = await exitPlan($)
  expect(r.text).toBe('approved')
  // The agent reads the override with the approved plan.
  expect(r.context).toEqual(['The user overrode a::R-AUTH-001, b::R-SRB-001 in the override dialog.'])
  expect(w.overrides.map(o => o.prompt)).toEqual(['/actual-cli:override all'])
  expect(w.overrides[0].argv).toEqual(['actual', 'check-override', '--claude-hook', '--rules-dir', RULES, '--via', 'dialog'])
  expect(w.overrides[0].stdin).toEqual({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, prompt: '/actual-cli:override all' })
})

test('one rule: "Override <id>" and no choice step', async ($, on) => {
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001']), answers: ['Override R-AUTH-001'] })
  const r: any = await exitPlan($)
  expect(labels(w.asked[0])).toEqual(['Revise the plan to conform (Recommended)', 'Override R-AUTH-001'])
  expect(w.overrides.map(o => o.prompt)).toEqual(['/actual-cli:override R-AUTH-001'])
  expect(r.text).toBe('approved')
})

test('an answer typed under Other reaches the agent as the user\'s words', async ($, on) => {
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001']), answers: ['keep apiAuth but skip the header check'] })
  const r: any = await exitPlan($)
  expect(r.text).toContain('The user answered the override dialog: "keep apiAuth but skip the header check"')
  expect(w.overrides).toEqual([])
})

test('a dismissed dialog leaves the denial as the CLI wrote it', async ($, on) => {
  const deny = denyText(['R-AUTH-001'])
  world(on, { planDeny: () => deny, answers: [null] })
  const r: any = await exitPlan($)
  expect(r.text).toBe(deny)
})

test('a CLI that records nothing keeps the plan blocked and says why', async ($, on) => {
  world(on, {
    planDeny: () => denyText(['R-AUTH-001', 'R-SRB-001']),
    answers: ['Override all 2 rules'],
    cli: () => ({ exitCode: 2, stdout: '' }),
  })
  const r: any = await exitPlan($)
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Not recorded: all: the actual CLI did not record it.')
})

test('an id two blocking rules share is not offered alone; all still covers it', async ($, on) => {
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001', 'R-AUTH-001', 'R-SRB-001']), answers: [null] })
  await exitPlan($)
  expect(w.asked[0].question).toBe('Plan blocked by 3 rules: R-SRB-001. What should happen?')
  expect(labels(w.asked[0])).toContain('Override all 3 rules')
})

test('the first rule is read even behind a prefix on its line', () => {
  expect(ruleIdsFrom(`PreToolUse:ExitPlanMode hook error: ${denyText(['R-A', 'R-B'])}`)).toEqual({ ids: ['R-A', 'R-B'], blocked: 2 })
  // A level-shaped phrase inside a reason is not a rule line.
  expect(ruleIdsFrom(denyText(['R-A']).replace('reason 0', 'a CONFLICT with it (see above)'))).toEqual({ ids: ['R-A'], blocked: 1 })
})

test('a deny from a CLI that cannot record an in-session override asks nothing', async ($, on) => {
  const old = 'DECISION R-AUTH-001 (MUST): x\nA revised plan is re-checked automatically. Session: s. Run `actual check-override` from a terminal.'
  const w = world(on, { planDeny: () => old })
  const r: any = await exitPlan($)
  expect(r.text).toBe(old)
  expect(w.asked).toEqual([])
})

test('nothing governed or governance off: no dialog', async ($, on) => {
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001']), env: { ACTUAL_PLAN_GATE: 'off' } })
  await exitPlan($)
  expect(w.asked).toEqual([])
})

test('the implementation gate asks about the changes, and an override lets the turn end', async ($, on) => {
  const w = world(on, {
    stopBlock: () => denyText(['R-HDR-001', 'R-ADR-001'], 'A revised change is re-checked automatically.'),
    answers: ['Override all 2 rules'],
    cli: () => ({ exitCode: 0, stdout: recorded(['a::R-HDR-001', 'b::R-ADR-001']) }),
  })
  const out: any = await $.classic.Stop({ stop_hook_active: false } as any)
  expect(w.asked[0].header).toBe('Code blocked')
  expect(labels(w.asked[0])[0]).toBe('Revise the changes to conform (Recommended)')
  expect(out.block).toBeUndefined()
})

test('the implementation gate: revise keeps the turn going with the choice', async ($, on) => {
  world(on, {
    stopBlock: () => denyText(['R-HDR-001'], 'A revised change is re-checked automatically.'),
    answers: ['Revise the changes to conform (Recommended)'],
  })
  const out: any = await $.classic.Stop({ stop_hook_active: false } as any)
  expect(out.block).toContain('The user chose to revise the changes')
  expect(out.block).not.toContain('/actual-cli:override')
})

// ── a typed override ─────────────────────────────────────────────────────────

test('a typed override is recorded by the mod and its answer reaches the agent', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: '/actual-cli:override R-AUTH-001 reviewed', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.overrides.map(o => o.prompt)).toEqual(['/actual-cli:override R-AUTH-001 reviewed'])
  // No --via: a CLI from before the flag still records a typed one.
  expect(w.overrides[0].argv).toEqual(['actual', 'check-override', '--claude-hook', '--rules-dir', RULES])
  expect(w.submitted.at(-1).context).toEqual(['The user overrode doc::R-AUTH-001.'])
})

test('an override a plugin submitted, or an ordinary prompt, records nothing', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: '/actual-cli:override all', wait: false, origin: { kind: 'plugin', name: 'other' } } as any)
  await $.prompt.submit({ text: 'how does an override work?', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.overrides).toEqual([])
})

test('a CLI that cannot record a typed override: the agent is told nothing was', async ($, on) => {
  const w = world(on, { cli: () => ({ exitCode: 2, stdout: '' }) })
  await $.prompt.submit({ text: '/actual-cli:override all', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.submitted.at(-1).context[0]).toContain('could not record it from the session')
})

// ── the pure parts, directly ─────────────────────────────────────────────────

test('overrideOutcome: "all" that recorded passes with a note', () => {
  const q = denialQuestion('plan', denyText(['R-A', 'R-B']))!
  expect(overrideOutcome(q, ['all'], [JSON.parse(recorded(['d::R-A', 'd::R-B']))])).toEqual({
    pass: true,
    note: 'The user overrode d::R-A, d::R-B in the override dialog.',
  })
  expect(readAnswer(q, 'Override all 2 rules')).toEqual({ targets: ['all'] })
  // There is no "choose rules" step: that label is just an answer typed under Other.
  expect(readAnswer(q, 'Choose rules to override').text).toContain('The user answered the override dialog')
  const failed = overrideOutcome(q, ['R-A'], [JSON.parse(nothing('no rule matching R-A'))])
  expect(failed.text).toContain('Not recorded: no rule matching R-A')
})
