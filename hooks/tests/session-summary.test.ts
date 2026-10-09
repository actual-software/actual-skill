// Tests for hooks/session-summary.ts. Run: claude plugin test .
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
const counts = (x: number, y: number): Answer => ran(JSON.stringify({ x, y, decisions: [] }, null, 2))
const missing: Answer = { deny: 'spawn actual ENOENT' }

// Stands in for everything beneath the mod: the session, its environment,
// bootstrap.sh (reporting `ruleFiles` rule files) and the CLI, which answers
// each call with the next of `answers`, the last one repeating.
function world(on: On, options: { answers: (Answer | Promise<Answer>)[]; ruleFiles?: number; env?: Record<string, string> }) {
  const clock = mock.clock(on)
  mock.env(on, options.env ?? {})
  const shown: (string | undefined)[] = []
  const cli: Call[] = []
  const located: Call[] = []
  on('ui.status', ($, e) => {
    shown.push(e.text)
    return { value: undefined }
  })
  on('session.id', () => ({ value: SESSION }))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: CWD }))
  on('process.run', ($, e) => {
    if (e.argv[0] === 'bash') {
      located.push(e)
      return ran(`${ROOT}\n${RULES}\n${options.ruleFiles ?? 4}\n`)
    }
    cli.push(e)
    return options.answers.length > 1 ? options.answers.shift()! : options.answers[0]!
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: '' }))
  return { clock, shown, cli, located }
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

test('reads 0 of Y from session start', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12)] })
  await $.session.start(start)
  await w.clock.settle()
  expect(w.shown).toEqual(['Actual AI: 0 of 12 ADRs added to context'])
})

test('updates after each main-loop response', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12), counts(3, 12), counts(4, 12)] })
  await $.session.start(start)
  await w.clock.settle()
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(w.shown).toEqual([
    'Actual AI: 0 of 12 ADRs added to context',
    'Actual AI: 3 of 12 ADRs added to context',
    'Actual AI: 4 of 12 ADRs added to context',
  ])
})

test('sends the line again only when it changes', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12), counts(0, 12), counts(1, 12)] })
  await $.session.start(start)
  await w.clock.settle()
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  await $.turn.complete(turn('t2'))
  await w.clock.settle()
  expect(w.cli.length).toBe(3)
  expect(w.shown).toEqual(['Actual AI: 0 of 12 ADRs added to context', 'Actual AI: 1 of 12 ADRs added to context'])
})

test('says ADR when Y is 1', async ($, on) => {
  const w = world(on, { answers: [counts(0, 1), counts(1, 1)] })
  await $.session.start(start)
  await w.clock.settle()
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.shown).toEqual(['Actual AI: 0 of 1 ADR added to context', 'Actual AI: 1 of 1 ADR added to context'])
})

test('runs the CLI with the session id and the rules directory bootstrap.sh resolves', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12)] })
  await $.session.start(start)
  await w.clock.settle()
  expect(w.located).toEqual([
    {
      argv: ['bash', '-c', expect.stringContaining('rules_dir'), expect.stringMatching(/\/hooks\/lib\/bootstrap\.sh$/)],
      init: { cwd: CWD, env: { CLAUDE_PROJECT_DIR: ROOT }, timeoutMs: 2000 },
    },
  ])
  expect(w.cli).toEqual([
    {
      argv: ['actual', 'session', 'summary', '--session', SESSION, '--rules-dir', RULES, '--json'],
      init: { cwd: ROOT, timeoutMs: 2000 },
    },
  ])
})

test('shows nothing without rule files, and runs no CLI', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12)], ruleFiles: 0 })
  await $.session.start(start)
  await w.clock.settle()
  expect(w.shown).toEqual([undefined])
  expect(w.cli).toEqual([])
})

test('shows nothing when the rules hold no decision (Y = 0)', async ($, on) => {
  const w = world(on, { answers: [counts(0, 0)] })
  await $.session.start(start)
  await w.clock.settle()
  expect(w.shown).toEqual([undefined])
})

test('clears the line when Y drops to 0', async ($, on) => {
  const w = world(on, { answers: [counts(2, 5), counts(0, 0)] })
  await $.session.start(start)
  await w.clock.settle()
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.shown).toEqual(['Actual AI: 2 of 5 ADRs added to context', undefined])
})

test('shows nothing when the CLI is missing', async ($, on) => {
  const w = world(on, { answers: [missing] })
  await $.session.start(start)
  await w.clock.settle()
  expect(w.cli.length).toBe(1)
  expect(w.shown).toEqual([])
})

test('shows nothing when the CLI fails', async ($, on) => {
  const w = world(on, { answers: [ran('', 2)] })
  await $.session.start(start)
  await w.clock.settle()
  expect(w.cli.length).toBe(1)
  expect(w.shown).toEqual([])
})

test('does nothing inside an actual-cli subprocess', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12)], env: { ACTUAL_CLI_SUBPROCESS: '1' } })
  await $.session.start(start)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  expect(w.shown).toEqual([])
  expect(w.located).toEqual([])
  expect(w.cli).toEqual([])
})

test('stays on with ACTUAL_PLAN_GATE=off', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12)], env: { ACTUAL_PLAN_GATE: 'off' } })
  await $.session.start(start)
  await w.clock.settle()
  expect(w.shown).toEqual(['Actual AI: 0 of 12 ADRs added to context'])
})

test('keeps the last line when a later call fails, times out or prints garbage', async ($, on) => {
  const w = world(on, {
    answers: [counts(3, 12), ran('', 1), { deny: 'timed out after 2000 ms' }, ran('not json'), ran('{"x":-1,"y":12}'), counts(4, 12)],
  })
  await $.session.start(start)
  await w.clock.settle()
  for (const id of ['t1', 't2', 't3', 't4']) {
    await $.turn.complete(turn(id))
    await w.clock.settle()
  }
  expect(w.shown).toEqual(['Actual AI: 3 of 12 ADRs added to context'])
  await $.turn.complete(turn('t5'))
  await w.clock.settle()
  expect(w.shown).toEqual(['Actual AI: 3 of 12 ADRs added to context', 'Actual AI: 4 of 12 ADRs added to context'])
})

test('makes no call on a subagent turn', async ($, on) => {
  const w = world(on, { answers: [counts(0, 12)] })
  await $.session.start(start)
  await w.clock.settle()
  await $.turn.complete(turn('t1', 'subagent-1'))
  await w.clock.settle()
  expect(w.cli.length).toBe(1)
  expect(w.shown).toEqual(['Actual AI: 0 of 12 ADRs added to context'])
})

test('never holds a reply for the CLI', async ($, on) => {
  let answer: (a: Answer) => void = () => {}
  const w = world(on, { answers: [counts(0, 12), new Promise<Answer>(resolve => (answer = resolve))] })
  await $.session.start(start)
  await w.clock.settle()
  await $.turn.complete(turn('t1'))
  expect(w.shown).toEqual(['Actual AI: 0 of 12 ADRs added to context'])
  answer(counts(1, 12))
  await w.clock.settle()
  expect(w.shown).toEqual(['Actual AI: 0 of 12 ADRs added to context', 'Actual AI: 1 of 12 ADRs added to context'])
})

test('a slow call that lands after a newer one does not overwrite it', async ($, on) => {
  let slow: (a: Answer) => void = () => {}
  const w = world(on, { answers: [new Promise<Answer>(resolve => (slow = resolve)), counts(5, 12)] })
  await $.session.start(start)
  await $.turn.complete(turn('t1'))
  await w.clock.settle()
  slow(counts(0, 12))
  await w.clock.settle()
  expect(w.shown).toEqual(['Actual AI: 5 of 12 ADRs added to context'])
})
