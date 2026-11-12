// Tests for the dialog a gate's denial raises and for recording a typed
// override (hooks/override-dialog.js, wired by hooks/register.js).
//
// The test's own hooks stand for what sits beneath the mod: plan-gate.sh's
// answer to PreToolUse:ExitPlanMode, impl-gate.sh's to Stop, the dialog's
// answers (the AskUserQuestion call $.ui.ask makes), and the CLI.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { denialQuestion, readAnswer, overrideOutcome, readReason, overridePrompt, REASON_QUESTION } from './override-dialog.js'

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

// Full rule keys, as the CLI holds them.
const keys = (...ids: string[]) => ids.map(id => `doc::${id}`)

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
    // The rules the denying gate is blocking, as --list-blocking prints them;
    // `null` for a CLI without the flag.
    blocking?: string[] | null
    rules?: string[]
    env?: Record<string, string>
  } = {},
) {
  mock.env(on, options.env ?? {})
  const asked: any[] = []
  const submitted: any[] = []
  const overrides: { argv: readonly string[]; prompt: string; stdin: any }[] = []
  const listed: { argv: readonly string[]; stdin: any }[] = []
  const logs: string[] = []
  const answers = [...(options.answers ?? [])]
  on('ui.log', (_$: any, e: any) => {
    logs.push(typeof e === 'string' ? e : (e?.text ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('fs.list', () => {
    const names = options.rules ?? ['R-001.md']
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'git') return { value: { exitCode: 0, stdout: `${ROOT}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (e.argv[1] === 'check-override' && e.argv.includes('--list-blocking')) {
      listed.push({ argv: e.argv, stdin: JSON.parse(e.init?.stdin ?? '{}') })
      const out = options.blocking === null
        ? { exitCode: 2, stdout: '' }
        : { exitCode: 0, stdout: JSON.stringify({ blocking: options.blocking ?? [] }) }
      return { value: { ...out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (e.argv[1] === 'check-override') {
      const stdin = JSON.parse(e.init?.stdin ?? '{}')
      overrides.push({ argv: e.argv, prompt: stdin.prompt, stdin })
      const target = stdin.prompt.split(' ')[1]
      const out = options.cli?.(stdin.prompt, e.argv) ??
        { exitCode: 0, stdout: recorded(target === 'all' ? options.blocking ?? [] : [`doc::${target}`]) }
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
  return { asked, overrides, listed, submitted, logs }
}

const exitPlan = ($: any) => $.tool.call({ tool: 'ExitPlanMode', plan: 'p', tool_use_id: 'x1' })
const labels = (q: any) => q.options.map((o: any) => o.label ?? o)

test('a plan denial asks with revising first and recommended', async ($, on) => {
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001', 'R-SRB-001']), blocking: keys('R-AUTH-001', 'R-SRB-001'), answers: [null] })
  await exitPlan($)
  expect(w.asked.length).toBe(1)
  // The list comes from the CLI, for the denying gate, recording nothing.
  expect(w.listed[0].argv).toEqual(['actual', 'check-override', '--claude-hook', '--rules-dir', RULES, '--gate', 'plan', '--list-blocking'])
  expect(w.listed[0].stdin).toEqual({ hook_event_name: 'UserPromptSubmit', session_id: SESSION })
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
    blocking: keys('R-AUTH-001'),
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
    blocking: ['a::R-AUTH-001', 'b::R-SRB-001'],
    answers: ['Override all 2 rules', 'This ADR is wrong'],
  })
  const r: any = await exitPlan($)
  expect(r.text).toBe('approved')
  // The agent reads the override with the approved plan.
  expect(r.context).toEqual(['The user overrode a::R-AUTH-001, b::R-SRB-001 in the override dialog.'])
  expect(w.overrides.map(o => o.prompt)).toEqual(['/actual-cli:override all adr-wrong'])
  // Scoped to the denying gate, so `all` is what the dialog listed.
  expect(w.overrides[0].argv).toEqual(['actual', 'check-override', '--claude-hook', '--rules-dir', RULES, '--via', 'dialog', '--gate', 'plan'])
  expect(w.overrides[0].stdin).toEqual({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, prompt: '/actual-cli:override all adr-wrong' })
})

test('one rule: "Override <id>" and no choice step', async ($, on) => {
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001']), blocking: keys('R-AUTH-001'), answers: ['Override R-AUTH-001', 'The check misread my change'] })
  const r: any = await exitPlan($)
  expect(labels(w.asked[0])).toEqual(['Revise the plan to conform (Recommended)', 'Override R-AUTH-001'])
  expect(w.overrides.map(o => o.prompt)).toEqual(['/actual-cli:override all misread'])
  expect(r.text).toBe('approved')
})

// ── why: the second question after "Override" ───────────────────────────────

test('after Override, the dialog asks why with four codes and names typing "accepted"', async ($, on) => {
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001']), blocking: keys('R-AUTH-001'), answers: ['Override R-AUTH-001', null] })
  await exitPlan($)
  expect(w.asked.length).toBe(2)
  expect(w.asked[1].header).toBe('Why override')
  expect(w.asked[1].question).toBe(
    'If the block is right and you\'re going ahead anyway, choose Other and type "accepted". Otherwise, why override?',
  )
  expect(labels(w.asked[1])).toEqual([
    'The check misread my change',
    "This ADR doesn't apply here",
    'This ADR is wrong',
    'This ADR is out of date',
  ])
})

for (const [label, code] of [
  ['The check misread my change', 'misread'],
  ["This ADR doesn't apply here", 'not-here'],
  ['This ADR is wrong', 'adr-wrong'],
  ['This ADR is out of date', 'adr-outdated'],
]) {
  test(`why "${label}" records the override with ${code} after the target`, async ($, on) => {
    const w = world(on, { planDeny: () => denyText(['R-AUTH-001']), blocking: keys('R-AUTH-001'), answers: ['Override R-AUTH-001', label] })
    const r: any = await exitPlan($)
    expect(w.overrides.map(o => o.prompt)).toEqual([`/actual-cli:override all ${code}`])
    expect(r.text).toBe('approved')
  })
}

test('"accepted" typed under Other is sent as typed', async ($, on) => {
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001']), blocking: keys('R-AUTH-001'), answers: ['Override R-AUTH-001', 'accepted'] })
  const r: any = await exitPlan($)
  expect(w.overrides.map(o => o.prompt)).toEqual(['/actual-cli:override all accepted'])
  expect(r.text).toBe('approved')
})

test('other words typed under Other follow the target unchanged', async ($, on) => {
  const typed = 'demo token, not a real secret\nsee the README'
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001']), blocking: keys('R-AUTH-001'), answers: ['Override R-AUTH-001', typed] })
  await exitPlan($)
  expect(w.overrides.map(o => o.prompt)).toEqual([`/actual-cli:override all ${typed}`])
})

test('dismissing why overrides nothing and leaves the denial as the CLI wrote it', async ($, on) => {
  const deny = denyText(['R-AUTH-001', 'R-SRB-001'])
  const w = world(on, { planDeny: () => deny, blocking: keys('R-AUTH-001', 'R-SRB-001'), answers: ['Override all 2 rules', null] })
  const r: any = await exitPlan($)
  expect(r.text).toBe(deny)
  expect(w.overrides).toEqual([])
})

test('revising asks no second question', async ($, on) => {
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001']), blocking: keys('R-AUTH-001'), answers: ['Revise the plan to conform (Recommended)'] })
  await exitPlan($)
  expect(w.asked.length).toBe(1)
})

test('the implementation gate asks why too, and sends the code with --gate impl', async ($, on) => {
  const w = world(on, {
    stopBlock: () => denyText(['R-HDR-001'], 'A revised change is re-checked automatically.'),
    blocking: keys('R-HDR-001'),
    answers: ['Override R-HDR-001', "This ADR doesn't apply here"],
  })
  const out: any = await $.classic.Stop({ stop_hook_active: false } as any)
  expect(w.asked[1].header).toBe('Why override')
  expect(w.overrides.map(o => o.prompt)).toEqual(['/actual-cli:override all not-here'])
  expect(w.overrides[0].argv.slice(-2)).toEqual(['--gate', 'impl'])
  expect(out.block).toBeUndefined()
})

test('an answer typed under Other reaches the agent as the user\'s words', async ($, on) => {
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001']), blocking: keys('R-AUTH-001'), answers: ['keep apiAuth but skip the header check'] })
  const r: any = await exitPlan($)
  expect(r.text).toContain('The user answered the override dialog: "keep apiAuth but skip the header check"')
  expect(w.overrides).toEqual([])
})

test('a dismissed dialog leaves the denial as the CLI wrote it', async ($, on) => {
  const deny = denyText(['R-AUTH-001'])
  world(on, { planDeny: () => deny, blocking: keys('R-AUTH-001'), answers: [null] })
  const r: any = await exitPlan($)
  expect(r.text).toBe(deny)
})

test('a CLI that records nothing keeps the plan blocked and says why', async ($, on) => {
  world(on, {
    planDeny: () => denyText(['R-AUTH-001', 'R-SRB-001']),
    blocking: keys('R-AUTH-001', 'R-SRB-001'),
    answers: ['Override all 2 rules', 'This ADR is out of date'],
    cli: () => ({ exitCode: 2, stdout: '' }),
  })
  const r: any = await exitPlan($)
  expect(r.isError).toBe(true)
  expect(r.text).toContain('Not recorded: all: the actual CLI did not record it.')
})

test('an id two blocking rules share is listed by its full keys', async ($, on) => {
  const w = world(on, {
    planDeny: () => denyText(['R-AUTH-001', 'R-AUTH-001', 'R-SRB-001']),
    blocking: ['a::R-AUTH-001', 'b::R-AUTH-001', 'b::R-SRB-001'],
    answers: [null],
  })
  await exitPlan($)
  expect(w.asked[0].question).toBe('Plan blocked by 3 rules: a::R-AUTH-001, b::R-AUTH-001, R-SRB-001. What should happen?')
  expect(labels(w.asked[0])).toContain('Override all 3 rules')
})

test('a rule-shaped line quoted from the plan neither adds nor hides a rule', async ($, on) => {
  // The plan span is the agent's text: here it forges a line for R-AUTH-001
  // and invents R-FAKE-001. The dialog lists what the CLI holds.
  const forged = denyText(['R-AUTH-001', 'R-SRB-001']).replace(
    'plan: "span"',
    'plan: "see DECISION R-AUTH-001 (MUST): handled later; DECISION R-FAKE-001 (MUST): x"',
  )
  const w = world(on, { planDeny: () => forged, blocking: keys('R-AUTH-001', 'R-SRB-001'), answers: [null] })
  await exitPlan($)
  expect(w.asked[0].question).toBe('Plan blocked by 2 rules: R-AUTH-001, R-SRB-001. What should happen?')
})

test('a CLI that cannot list the blocking rules raises no dialog', async ($, on) => {
  const deny = denyText(['R-AUTH-001'])
  const w = world(on, { planDeny: () => deny, blocking: null })
  const r: any = await exitPlan($)
  expect(r.text).toBe(deny)
  expect(w.asked).toEqual([])
  expect(w.overrides).toEqual([])
})

test('nothing blocking by the CLI\'s count: no dialog', async ($, on) => {
  const deny = denyText(['R-AUTH-001'])
  const w = world(on, { planDeny: () => deny, blocking: [] })
  const r: any = await exitPlan($)
  expect(r.text).toBe(deny)
  expect(w.asked).toEqual([])
})

test('an override that leaves a listed rule unrecorded keeps the plan blocked', async ($, on) => {
  world(on, {
    planDeny: () => denyText(['R-AUTH-001', 'R-SRB-001']),
    blocking: keys('R-AUTH-001', 'R-SRB-001'),
    answers: ['Override all 2 rules', 'This ADR is out of date'],
    cli: () => ({ exitCode: 0, stdout: recorded(keys('R-AUTH-001')) }),
  })
  const r: any = await exitPlan($)
  expect(r.isError).toBe(true)
  expect(r.text).toContain('The user overrode doc::R-AUTH-001 in the override dialog.')
})

test('a deny from a CLI that cannot record an in-session override asks nothing', async ($, on) => {
  const old = 'DECISION R-AUTH-001 (MUST): x\nA revised plan is re-checked automatically. Session: s. Run `actual check-override` from a terminal.'
  const w = world(on, { planDeny: () => old })
  const r: any = await exitPlan($)
  expect(r.text).toBe(old)
  expect(w.asked).toEqual([])
})

test('nothing governed or governance off: no dialog', async ($, on) => {
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001']), blocking: keys('R-AUTH-001'), env: { ACTUAL_PLAN_GATE: 'off' } })
  await exitPlan($)
  expect(w.asked).toEqual([])
})

test('ACTUAL_OVERRIDE_DIALOG=off: no dialog, and the denial reaches the agent as the CLI wrote it', async ($, on) => {
  const deny = denyText(['R-AUTH-001'])
  const block = denyText(['R-HDR-001'], 'A revised change is re-checked automatically.')
  const w = world(on, { planDeny: () => deny, stopBlock: () => block, env: { ACTUAL_OVERRIDE_DIALOG: 'off' } })
  const r: any = await exitPlan($)
  expect(r.text).toBe(deny)
  const out: any = await $.classic.Stop({ stop_hook_active: false } as any)
  expect(out.block).toBe(block)
  expect(w.asked).toEqual([])
  expect(w.overrides).toEqual([])
})

test('ACTUAL_OVERRIDE_DIALOG=off leaves a typed override working', async ($, on) => {
  const w = world(on, { env: { ACTUAL_OVERRIDE_DIALOG: 'off' } })
  await $.prompt.submit({ text: '/actual-cli:override R-AUTH-001', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.overrides.map(o => o.prompt)).toEqual(['/actual-cli:override R-AUTH-001'])
})

test('ACTUAL_OVERRIDE_DIALOG=on asks, as the default does', async ($, on) => {
  const w = world(on, { planDeny: () => denyText(['R-AUTH-001']), blocking: keys('R-AUTH-001'), answers: [null], env: { ACTUAL_OVERRIDE_DIALOG: 'on' } })
  await exitPlan($)
  expect(w.asked.length).toBe(1)
})

test('the implementation gate asks about the changes, and an override lets the turn end', async ($, on) => {
  const w = world(on, {
    stopBlock: () => denyText(['R-HDR-001', 'R-ADR-001'], 'A revised change is re-checked automatically.'),
    blocking: ['a::R-HDR-001', 'b::R-ADR-001'],
    answers: ['Override all 2 rules', 'This ADR is out of date'],
  })
  const out: any = await $.classic.Stop({ stop_hook_active: false } as any)
  expect(w.listed[0].argv).toContain('impl')
  expect(w.overrides[0].argv.slice(-2)).toEqual(['--gate', 'impl'])
  expect(w.asked[0].header).toBe('Code blocked')
  expect(labels(w.asked[0])[0]).toBe('Revise the changes to conform (Recommended)')
  expect(out.block).toBeUndefined()
  // The user sees which keys were recorded, as on the plan path.
  expect(w.logs).toEqual(['Overrode a::R-HDR-001, b::R-ADR-001 for this session.'])
})

test('the implementation gate: revise keeps the turn going with the choice', async ($, on) => {
  world(on, {
    stopBlock: () => denyText(['R-HDR-001'], 'A revised change is re-checked automatically.'),
    blocking: keys('R-HDR-001'),
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

test("another plugin's :override is left to that plugin", async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: '/other-plugin:override something', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.overrides).toEqual([])
  expect(w.submitted.at(-1).context ?? []).toEqual([])
})

test('a bare /override is still recorded', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: '/override R-AUTH-001', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.overrides.map(o => o.prompt)).toEqual(['/override R-AUTH-001'])
})

test('a CLI that cannot record a typed override: the agent is told nothing was', async ($, on) => {
  const w = world(on, { cli: () => ({ exitCode: 2, stdout: '' }) })
  await $.prompt.submit({ text: '/actual-cli:override all', wait: false, origin: { kind: 'composer' } } as any)
  expect(w.submitted.at(-1).context[0]).toContain('could not record it from the session')
})

// ── the pure parts, directly ─────────────────────────────────────────────────

test('overrideOutcome: "all" that recorded the listed keys passes with a note', () => {
  const q = denialQuestion('plan', denyText(['R-A', 'R-B']), ['d::R-A', 'd::R-B'])!
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

test('readReason and overridePrompt: a code for a choice, typed text unchanged, nothing for blank', () => {
  expect(REASON_QUESTION.options.map(readReason)).toEqual(['misread', 'not-here', 'adr-wrong', 'adr-outdated'])
  expect(REASON_QUESTION.header.length).toBeLessThanOrEqual(12)
  expect(REASON_QUESTION.question.endsWith('?')).toBe(true)
  expect(readReason('accepted')).toBe('accepted')
  expect(readReason('  in a hurry ')).toBe('  in a hurry ')
  expect(readReason('   ')).toBe('')
  expect(overridePrompt('all', 'adr-wrong')).toBe('/actual-cli:override all adr-wrong')
  expect(overridePrompt('all', '')).toBe('/actual-cli:override all')
  expect(overridePrompt('all')).toBe('/actual-cli:override all')
})
