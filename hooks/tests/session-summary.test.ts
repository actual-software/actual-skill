// Tests for the count above the prompt: the session summary line that
// hooks/register.js draws, as the CLI gives it, in the AbovePrompt band.
import { expect, mock, test } from 'claude-code/testing'
import type { On, ProcessRunInit } from 'claude-code'

const ROOT = '/work/repo'
const CWD = '/work/repo/src'
const RULES = '/work/repo/.actual/rules'
const SESSION = 'session-1'

type Call = { argv: readonly string[]; init?: ProcessRunInit }
type Answer = { value: { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean } } | { deny: string }

const ran = (stdout: string, exitCode = 0): Answer => ({
  value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})
// What `actual session summary --json` prints: the counts, the areas the
// session worked in that no ADR covers, and the line the CLI builds from them.
const said = (line: string | null, of: { x?: number; y?: number; areas?: string[] } = {}): Answer => {
  const areas = of.areas ?? []
  const answer = { x: of.x ?? 0, y: of.y ?? 12, decisions: [], gaps: areas.length, areas_without_adr: areas, line }
  return ran(JSON.stringify(answer, null, 2))
}
// x of y ADRs added and no area without one, or no line when y is 0.
const counts = (x: number, y: number): Answer => said(y ? `Actual AI: ${x} of ${y} ADRs added to context` : null, { x, y })
// A CLI that has the subcommand and predates the line.
const beforeLine = (x: number, y: number): Answer => ran(JSON.stringify({ x, y, decisions: [] }, null, 2))
const missing: Answer = { deny: 'spawn actual ENOENT' }
const tooOld = ran('', 2)

// Stands in for everything beneath the mod: the session, its environment, the
// rules directory (holding `rules` entries), git, and the CLI, which answers
// each `session summary` call with the next of `answers`, the last one
// repeating. `beneath` is what the band's other rows draw, when anything, and
// `preflight` what the plugin's own SessionStart hook answers.
function world(
  on: On,
  options: {
    answers: (Answer | Promise<Answer>)[]
    rules?: string[]
    env?: Record<string, string>
    beneath?: string
    preflight?: object
  },
) {
  const clock = mock.clock(on)
  mock.env(on, options.env ?? {})
  let session = SESSION
  const summaries: Call[] = []
  const spawns: Call[] = []
  const listed: string[] = []
  let renders = 0
  on('session.id', () => ({ value: session }))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: CWD }))
  on('fs.list', ($, e) => {
    listed.push(e.path)
    const names = options.rules ?? ['R-001.md', 'R-002.md']
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })) }
  })
  on('process.run', ($, e) => {
    spawns.push(e)
    if (e.argv[0] === 'git') return ran(`${ROOT}\n`)
    summaries.push(e)
    return options.answers.length > 1 ? options.answers.shift()! : options.answers[0]!
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.SessionStart', () => options.preflight ?? { value: {} })
  on('ui.render', ($, e) => {
    if (e.component === 'AbovePrompt') renders += 1
    if (options.beneath === undefined) return { type: 'engine', ref: 1 }
    const { Text } = $.ui.resolve(e)
    return Text({ children: [options.beneath] })
  })
  return {
    clock,
    summaries,
    spawns,
    listed,
    renders: () => renders,
    switchSession: (id: string) => {
      session = id
    },
  }
}

const start = { cwd: CWD, surface: 'terminal', isInteractive: true } as const
const turn = (turnId: string, agentId?: string) => ({
  answer: 'ok',
  durationMs: 1,
  isAborted: false,
  reason: 'answer' as const,
  turnId,
  agentId,
})
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} }

// The band, mounted before anything is counted, so a reading that changes the
// count has to redraw it: a render answer is cached until the mod invalidates.
// `read` is the band's text as a person reads it, one line per row.
async function mountBand($: any, props: Partial<typeof BAND> = {}, surface: 'terminal' | 'desktop' = 'terminal') {
  const view = await $.ui.mount({ plugin: 'actual-cli', surface, component: 'AbovePrompt', props: { ...BAND, ...props } })
  return {
    read: async () => ((await view.findAll({ type: 'Text' })) as { text: string }[]).map(t => t.text).join('\n'),
    unmount: () => view.unmount(),
  }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`reads 0 of Y from session start (${surface})`, async ($, on) => {
    const w = world(on, { answers: [counts(0, 12)] })
    const band = await mountBand($, {}, surface)
    await $.session.start({ ...start, surface })
    await w.clock.settle()
    expect(await band.read()).toBe('Actual AI: 0 of 12 ADRs added to context')
    await band.unmount()
  })
}

test('updates after each main-loop response', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12), counts(3, 12), counts(4, 12)] })
  const band = await mountBand($)
  const seen: string[] = []
  await $.session.start(start)
  await w.clock.settle()
  seen.push(await band.read())
  for (const id of ['t1', 't2']) {
    await $.turn.complete(turn(id))
    await w.clock.settle()
    seen.push(await band.read())
  }
  expect(seen).toEqual([
    'Actual AI: 0 of 12 ADRs added to context',
    'Actual AI: 3 of 12 ADRs added to context',
    'Actual AI: 4 of 12 ADRs added to context',
  ])
  await band.unmount()
})

test('redraws the band only when the line changes', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12), counts(0, 12), counts(1, 12)] })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(await band.read()).toBe('Actual AI: 1 of 12 ADRs added to context')
  expect(w.summaries.length).toBe(3)
  // Mounted, then 0 of 12, then 1 of 12: the unchanged second reading draws nothing.
  expect(w.renders()).toBe(3)
  await band.unmount()
})

// Every form of the line the CLI builds, beside the counts it builds it from.
const FORMS = [
  { line: 'Actual AI: 3 of 12 ADRs added to context · 2 areas with no ADR', x: 3, areas: ['src/billing', 'src/tax'] },
  { line: 'Actual AI: 3 of 12 ADRs added to context · 1 area with no ADR', x: 3, areas: ['src/billing'] },
  { line: 'Actual AI: 3 of 12 ADRs added to context', x: 3, areas: [] },
  { line: 'Actual AI: no ADR covers the 3 areas you worked in', x: 0, areas: ['src/billing', 'src/tax', 'web'] },
  { line: 'Actual AI: no ADR covers the area you worked in', x: 0, areas: ['src/billing'] },
  { line: 'Actual AI: 0 of 12 ADRs added to context', x: 0, areas: [] },
]

for (const form of FORMS) {
  test(`shows the CLI's line as given: ${form.line}`, async ($, on) => {
    const w = world(on, { answers: [said(form.line, form)] })
    const band = await mountBand($)
    await $.session.start(start)
    await w.clock.settle()
    expect(await band.read()).toBe(form.line)
    await band.unmount()
  })
}

test('holds no wording of its own: a form it has never seen shows word for word', async ($, on) => {
  const w = world(on, { answers: [said('Actual AI: 1 of 1 ADR added to context, in words no test has seen')] })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  expect(await band.read()).toBe('Actual AI: 1 of 1 ADR added to context, in words no test has seen')
  await band.unmount()
})

test('shows nothing for a null line, whatever the counts beside it', async ($, on) => {
  const w = world(on, { answers: [said(null, { x: 3, y: 12, areas: ['src/billing'] })] })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  expect(await band.read()).toBe('')
  await band.unmount()
})

test('shows nothing when the CLI predates the line, and builds none from x and y', async ($, on) => {
  const w = world(on, { answers: [beforeLine(3, 12)] })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  expect(w.summaries.length).toBe(1)
  expect(await band.read()).toBe('')
  await band.unmount()
})

test('runs the CLI with the session id and the rules directory the briefs use', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12)] })
  await $.session.start(start)
  await w.clock.settle()
  expect(w.listed).toEqual([RULES])
  expect(w.spawns).toEqual([
    { argv: ['git', 'rev-parse', '--show-toplevel'], init: { cwd: CWD, timeoutMs: 2000 } },
    {
      argv: ['actual', 'session', 'summary', '--session', SESSION, '--rules-dir', RULES, '--json'],
      init: { cwd: ROOT, timeoutMs: 2000 },
    },
  ])
})

test('counts against ACTUAL_RULES_DIR, as the briefs do', async ($, on) => {
  const w = world(on, { answers: [counts(0, 3)], env: { ACTUAL_RULES_DIR: '/elsewhere/rules' } })
  await $.session.start(start)
  await w.clock.settle()
  expect(w.listed).toEqual(['/elsewhere/rules'])
  expect(w.summaries.map(c => c.argv)).toEqual([
    ['actual', 'session', 'summary', '--session', SESSION, '--rules-dir', '/elsewhere/rules', '--json'],
  ])
})

test('shows nothing without rule files, and runs no CLI', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12)], rules: ['README.txt'] })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  expect(await band.read()).toBe('')
  expect(w.summaries).toEqual([])
  await band.unmount()
})

test('shows nothing when the rules hold no decision (a null line)', async ($, on) => {
  const w = world(on, { answers: [counts(0, 0)] })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  expect(await band.read()).toBe('')
  await band.unmount()
})

test('clears the band when the line turns null', async ($, on) => {
  const w = world(on, { answers: [counts(2, 5), counts(0, 0)] })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  const first = await band.read()
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect([first, await band.read()]).toEqual(['Actual AI: 2 of 5 ADRs added to context', ''])
  await band.unmount()
})

test('shows nothing when the CLI is missing', async ($, on) => {
  const w = world(on, { answers: [missing] })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  expect(w.summaries.length).toBe(1)
  expect(await band.read()).toBe('')
  await band.unmount()
})

test('shows nothing when the CLI predates session summary', async ($, on) => {
  const w = world(on, { answers: [tooOld] })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  expect(w.summaries.length).toBe(1)
  expect(await band.read()).toBe('')
  await band.unmount()
})

test('does nothing inside an actual-cli subprocess', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12)], env: { ACTUAL_CLI_SUBPROCESS: '1' } })
  const band = await mountBand($)
  await $.session.start(start)
  await $.turn.complete(turn('t1'))
  await $.classic.SessionStart({ source: 'clear' })
  await w.clock.settle()
  expect(await band.read()).toBe('')
  expect(w.spawns).toEqual([])
  expect(w.listed).toEqual([])
  await band.unmount()
})

test('stays on with ACTUAL_PLAN_GATE=off', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12)], env: { ACTUAL_PLAN_GATE: 'off' } })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  expect(await band.read()).toBe('Actual AI: 0 of 12 ADRs added to context')
  await band.unmount()
})

test('keeps the last line when a later call fails, times out, prints garbage or gives no line', async ($, on) => {
  const w = world(on, {
    answers: [
      counts(3, 12),
      ran('', 1),
      { deny: 'timed out after 2000 ms' },
      ran('not json'),
      ran('null'),
      ran('{"x":3,"y":12,"line":5}'),
      beforeLine(4, 12),
      counts(4, 12),
    ],
  })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  for (const id of ['t1', 't2', 't3', 't4', 't5', 't6']) {
    await $.turn.complete(turn(id))
    await w.clock.settle()
    expect(await band.read()).toBe('Actual AI: 3 of 12 ADRs added to context')
  }
  await $.turn.complete(turn('t7'))
  await w.clock.settle()
  expect(await band.read()).toBe('Actual AI: 4 of 12 ADRs added to context')
  await band.unmount()
})

test('makes no call on a subagent turn', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12), counts(5, 12)] })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  await $.turn.complete(turn('t1', 'subagent-1'))
  await w.clock.settle()
  expect(w.summaries.length).toBe(1)
  expect(await band.read()).toBe('Actual AI: 0 of 12 ADRs added to context')
  await band.unmount()
})

test('never holds a reply for the CLI', async ($, on) => {
  let answer: (a: Answer) => void = () => {}
  const w = world(on, { answers: [counts(0, 12), new Promise<Answer>(resolve => (answer = resolve))] })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  await $.turn.complete(turn('t1'))
  expect(await band.read()).toBe('Actual AI: 0 of 12 ADRs added to context')
  answer(counts(1, 12))
  await w.clock.settle()
  expect(await band.read()).toBe('Actual AI: 1 of 12 ADRs added to context')
  await band.unmount()
})

test('a slow call that lands after a newer one does not overwrite it', async ($, on) => {
  let slow: (a: Answer) => void = () => {}
  const w = world(on, { answers: [new Promise<Answer>(resolve => (slow = resolve)), counts(5, 12)] })
  const band = await mountBand($)
  await $.session.start(start)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  slow(counts(0, 12))
  await w.clock.settle()
  expect(await band.read()).toBe('Actual AI: 5 of 12 ADRs added to context')
  await band.unmount()
})

test('refreshes on /clear, compaction, resume and fork, and leaves startup to session start', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12)] })
  await $.classic.SessionStart({ source: 'startup' })
  await w.clock.settle()
  expect(w.summaries.length).toBe(0)
  for (const source of ['clear', 'compact', 'resume', 'fork'] as const) {
    await $.classic.SessionStart({ source })
    await w.clock.settle()
  }
  expect(w.summaries.length).toBe(4)
})

test('/clear shows the count for the new session', async ($, on) => {
  const w = world(on, { answers: [counts(3, 12), counts(0, 12)] })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  const before = await band.read()
  w.switchSession('session-2')
  await $.classic.SessionStart({ source: 'clear' })
  await w.clock.settle()
  expect([before, await band.read()]).toEqual(['Actual AI: 3 of 12 ADRs added to context', 'Actual AI: 0 of 12 ADRs added to context'])
  expect(w.summaries[1]!.argv).toContain('session-2')
  await band.unmount()
})

test('hands the SessionStart hook answer on untouched', async ($, on) => {
  const preflight = { value: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'governance is active' } } }
  const w = world(on, { answers: [counts(0, 12)], preflight })
  expect(await $.classic.SessionStart({ source: 'clear' })).toEqual(preflight)
  await w.clock.settle()
})

test('stands aside while a survey holds the band', async ($, on) => {
  const w = world(on, { answers: [counts(3, 12)], beneath: 'How is Claude doing this session?' })
  const band = await mountBand($, { hasSurvey: true })
  await $.session.start(start)
  await w.clock.settle()
  expect(await band.read()).toBe('How is Claude doing this session?')
  await band.unmount()
})

test('keeps the rows beneath it', async ($, on) => {
  const w = world(on, { answers: [counts(3, 12)], beneath: 'a row from another plugin' })
  const band = await mountBand($)
  await $.session.start(start)
  await w.clock.settle()
  expect(await band.read()).toBe('Actual AI: 3 of 12 ADRs added to context\na row from another plugin')
  await band.unmount()
})

test('fits the width of the band', async ($, on) => {
  const w = world(on, { answers: [counts(3, 12)] })
  const band = await mountBand($, { bodyColumns: 24 })
  await $.session.start(start)
  await w.clock.settle()
  expect(await band.read()).toBe('Actual AI: 3 of 12 ADRs\u2026')
  await band.unmount()
})
