// Probe P4: opens one live session's VS Code tab through src/vscode.mjs. MOVES WINDOWS on the
// screen: run it only together with André. Usage: node scripts/probe-open.mjs <sessionIdPrefix>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from '../src/collect.mjs';
import { loadConfig } from '../src/config.mjs';
import { loadRegistry } from '../src/sources/registry.mjs';
import { openSession } from '../src/vscode.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prefix = process.argv[2];
if (!prefix) {
  console.error('usage: node scripts/probe-open.mjs <sessionIdPrefix>');
  process.exit(2);
}

const cfg = await loadConfig({ root, argv: [] });
const snap = await collect(cfg);
const hits = snap.sessions.filter((s) => s.id.startsWith(prefix));
if (hits.length !== 1) {
  console.error(hits.length ? `prefix "${prefix}" matches ${hits.length} sessions` : `no live session with prefix "${prefix}"`);
  process.exit(2);
}
const s = hits[0];
const reg = await loadRegistry(cfg);
console.log(`session ${s.id}\n  cwd   ${s.cwd}\n  title ${s.title}\n  distro ${cfg.wslDistro}`);

try {
  const res = await openSession({
    cwd: s.cwd,
    sessionId: s.id,
    distro: cfg.wslDistro,
    knownCwds: reg?.knownCwds ?? [],
    cfg,
  });
  console.log(`opened: window ${res.window} "${res.title}"`);
} catch (err) {
  console.log(`refused: ${err.message}`);
  process.exitCode = 1;
}
