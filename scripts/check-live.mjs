// Compares the daemon's session list with `claude agents --json` (read-only), per side: the WSL
// rows with the WSL CLI, the Windows rows with `claude.exe` next to the Windows .claude folder
// (spec F31 b). Exit code 1 when the id sets of either side differ.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { loadConfig } from '../src/config.mjs';
import { collect } from '../src/collect.mjs';
import { loadSettings } from '../src/settings.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FALLBACK_CLI = path.join(os.homedir(), '.local/bin/claude');

async function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir && existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}

/** Map sessionId -> agent from `<bin> agents --json`. */
async function agentsOf(bin, opts = {}) {
  const { stdout } = await run(bin, ['agents', '--json'], { timeout: 60000, maxBuffer: 64 * 1024 * 1024, ...opts });
  const parsed = JSON.parse(stdout);
  const list = Array.isArray(parsed) ? parsed : (parsed.agents ?? parsed.sessions ?? []);
  const out = new Map();
  for (const a of list) {
    const id = a.sessionId ?? a.id;
    if (id) out.set(id, a);
  }
  return out;
}

/** Prints the comparison of one side and returns its number of differences. */
function compare(side, cli, rows) {
  const tower = new Map(rows.map((s) => [s.id, s]));
  const onlyCli = [...cli.keys()].filter((id) => !tower.has(id));
  const onlyTower = [...tower.keys()].filter((id) => !cli.has(id));
  console.log(`--- ${side}`);
  for (const id of onlyCli) console.log(`only in CLI:   ${id} ${cli.get(id).name ?? ''}`);
  for (const id of onlyTower) console.log(`only in tower: ${id} ${tower.get(id).title}`);
  const ids = [...new Set([...cli.keys(), ...tower.keys()])].sort();
  console.log('id-prefix | cli status | tower state | opens in | title');
  for (const id of ids) {
    const c = cli.get(id);
    const t = tower.get(id);
    const state = t ? t.state + (t.ask ? (t.ask.certain ? '' : '?') : '') : '-';
    console.log(`${id.slice(0, 8)} | ${c?.status ?? '-'} | ${state} | ${t?.opensIn ?? '-'} | ${t?.title ?? c?.name ?? ''}`);
  }
  const diffs = onlyCli.length + onlyTower.length;
  console.log(`${side}: ${diffs} differences (cli ${cli.size}, tower ${tower.size})`);
  return diffs;
}

const baseCfg = await loadConfig({ root, argv: [] });
const cfg = { ...baseCfg, ...(await loadSettings(baseCfg)) }; // as the widget sees it

let t0 = performance.now();
await collect(cfg);
const firstMs = Math.round(performance.now() - t0);
t0 = performance.now();
const snap = await collect(cfg);
const secondMs = Math.round(performance.now() - t0);
console.log(`collect took ${firstMs} ms, then ${secondMs} ms; sources ${JSON.stringify(snap.sources)}`);

let diffs = compare('wsl', await agentsOf((await onPath('claude')) ?? FALLBACK_CLI), snap.sessions.filter((s) => s.host === 'wsl'));

if (!cfg.windowsClaudeDir) {
  console.log('windows: skipped (no windowsClaudeDir)');
} else {
  const home = path.dirname(cfg.windowsClaudeDir);
  const exe = path.join(home, '.local/bin/claude.exe');
  if (!existsSync(exe)) {
    console.log(`windows: skipped (no ${exe})`);
  } else {
    // A Windows exe needs a cwd Windows can see; a WSL path is not one.
    diffs += compare('windows', await agentsOf(exe, { cwd: home }), snap.sessions.filter((s) => s.host === 'windows'));
  }
}
process.exitCode = diffs === 0 ? 0 : 1;
