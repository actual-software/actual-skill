// replay.mjs - run the mod's path extraction over a recorded session.
//
// Imports the pure helpers straight out of hooks/register.js, so this exercises
// the real extractor rather than a copy of it, and tracks the shell's directory
// across calls the way the mod does. Everything the mod needs $ for -- the
// read-only verdict, dedup, the budget -- is unavailable here, so a line marked
// `would brief` means the extractor resolved a governed-looking file, not that a
// brief would certainly arrive.
import { readFileSync, existsSync } from 'fs';

const [transcript, repo, modPath] = process.argv.slice(2);
const src = readFileSync(modPath, 'utf8');
const body = src.slice(0, src.indexOf('export function register'));
const mod = await import(
  'data:text/javascript,' +
    encodeURIComponent(body + '\nexport { candidateTokens, normalizePath, joinPath, isWithin };')
);

const rulesDir = `${repo}/.actual/rules`;
const commands = [];
for (const line of readFileSync(transcript, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let d;
  try { d = JSON.parse(line); } catch { continue; }
  if (d.type !== 'assistant') continue;
  for (const b of d.message?.content ?? []) {
    if (b?.type === 'tool_use' && b.name === 'Bash') commands.push(b.input?.command ?? '');
  }
}

let shell = repo;
let would = 0;
for (const command of commands) {
  const found = mod.candidateTokens(command);
  if (found?.cdTarget) shell = mod.normalizePath(mod.joinPath(shell, found.cdTarget));
  const head = command.split('\n')[0].slice(0, 64);
  if (!found || found.tokens.length === 0) {
    console.log(`  --          ${head}`);
    continue;
  }
  const bases = found.cdTarget ? [shell] : [...new Set([shell, repo])];
  const hits = [];
  for (const token of found.tokens) {
    if (hits.length >= 2) break;
    for (const base of bases) {
      const p = mod.normalizePath(mod.joinPath(base, token));
      if (!mod.isWithin(repo, p)) continue;
      if (mod.isWithin(rulesDir, p)) continue;
      if (!existsSync(p)) continue;
      if (!hits.includes(p)) hits.push(p);
      break;
    }
  }
  if (hits.length === 0) { console.log(`  unresolved  ${head}`); continue; }
  would += 1;
  console.log(`  would brief ${hits.map((p) => p.replace(`${repo}/`, '')).join('  ')}`);
}
console.log(`\n${commands.length} Bash calls, ${would} would resolve a file to brief`);
