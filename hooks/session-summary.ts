// session-summary.ts - Claude Code mod: "Actual AI: X of Y ADRs added to context"
// in the status line, read from `actual session summary`.
//
// Refreshed at session start and after each main-loop response, always in the
// background: nothing waits on the CLI, and a call that fails or runs past
// CLI_TIMEOUT_MS leaves the last line in place. Shows nothing in a
// repository with no committed rules, or whose rules hold no decision (Y = 0).

import type { EngineInterface, Register } from 'claude-code'

const CLI_TIMEOUT_MS = 2000

type Place = { root: string; rulesDir: string; ruleFiles: number }
type Counts = { x: number; y: number }

// The rules directory must be the one the brief hook hands `actual rules
// brief`, or the CLI reads a different session record and X never moves. So it
// comes from bootstrap.sh itself, run as a command hook would run it: from the
// session's directory, with its root as CLAUDE_PROJECT_DIR, which Claude Code
// sets for command hooks alone.
const LOCATE =
  '. "$0" && dir=$(rules_dir) && printf \'%s\\n%s\\n%s\\n\' "$(resolve_repo_root)" "$dir" "$(rules_count "$dir")"'

const statusText = ({ x, y }: Counts): string | undefined =>
  y === 0 ? undefined : `Actual AI: ${x} of ${y} ${y === 1 ? 'ADR' : 'ADRs'} added to context`

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

async function locate($: EngineInterface): Promise<Place | undefined> {
  const [root, cwd] = await Promise.all([$.session.root(), $.session.cwd()])
  const { exitCode, stdout } = await $.process.run(
    ['bash', '-c', LOCATE, `${$.plugin.root}/hooks/lib/bootstrap.sh`],
    { cwd, env: { CLAUDE_PROJECT_DIR: root }, timeoutMs: CLI_TIMEOUT_MS },
  )
  const [repoRoot = '', rulesDir = '', ruleFiles = ''] = stdout.split('\n')
  if (exitCode !== 0 || repoRoot === '' || rulesDir === '' || !/^\d+$/.test(ruleFiles)) return undefined
  return { root: repoRoot, rulesDir, ruleFiles: Number(ruleFiles) }
}

async function summarize($: EngineInterface, place: Place): Promise<Counts | undefined> {
  const session = await $.session.id()
  const { exitCode, stdout } = await $.process.run(
    ['actual', 'session', 'summary', '--session', session, '--rules-dir', place.rulesDir, '--json'],
    { cwd: place.root, timeoutMs: CLI_TIMEOUT_MS },
  )
  if (exitCode !== 0) return undefined
  const { x, y } = JSON.parse(stdout) as { x?: unknown; y?: unknown }
  return isCount(x) && isCount(y) ? { x, y } : undefined
}

type Order = { started: number; shown: number; text: string | undefined | null }

// Resolves once the line is updated or left alone, and never rejects: a failed
// or timed-out call keeps whatever the line said before. A refresh that
// finishes after a newer one leaves the newer one's line in place, and the
// line is sent again only when its text changes.
async function refresh($: EngineInterface, order: Order): Promise<void> {
  const ticket = ++order.started
  try {
    if ((await $.env.get('ACTUAL_CLI_SUBPROCESS')) === '1') return
    const place = await locate($)
    if (place === undefined) return
    let text: string | undefined
    if (place.ruleFiles > 0) {
      const counts = await summarize($, place)
      if (counts === undefined) return
      text = statusText(counts)
    }
    if (ticket < order.shown) return
    order.shown = ticket
    if (text === order.text) return
    order.text = text
    $.ui.status(text)
  } catch {
    // A rejected run (timeout, no `actual` on PATH) or unreadable output.
  }
}

export const register: Register = on => {
  // `text: null` until the first refresh lands, so that one is always sent.
  const order: Order = { started: 0, shown: 0, text: null }

  on('session.start', ($, e, next) => {
    void refresh($, order)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) void refresh($, order)
    return next(e)
  })
}
