// Hidden ("crossed off") rows. Together with `settings.json` (settings.mjs) this is all the daemon writes, both in its own state folder (spec 7.6, relaxed 2026-11-17).
import fs from 'node:fs/promises';
import path from 'node:path';

const GROUPS = new Set(['prompt', 'working', 'finished']);
const FILE = 'dismissed.json';
let saveCount = 0;

export function groupOf(state) {
  if (state === 'prompt') return 'prompt';
  if (state === 'working') return 'working';
  return 'finished'; // waiting, idle
}

/** keepAbsent: a session missing from the snapshot may only be unreadable (one side of WSL and
 *  Windows could not be read), so its entry stays. */
export function reconcile(entries, sessions, { keepAbsent = false } = {}) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  return entries.filter((e) => {
    const s = byId.get(e.sessionId);
    if (s === undefined) return keepAbsent;
    return groupOf(s.state) === e.group;
  });
}

export async function loadDismissed(cfg) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(path.join(cfg.stateDir, FILE), 'utf8'));
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  return data
    .filter((e) => e && typeof e.sessionId === 'string' && GROUPS.has(e.group))
    .map((e) => ({ sessionId: e.sessionId, group: e.group }));
}

let chain = Promise.resolve();

async function write(cfg, entries) {
  await fs.mkdir(cfg.stateDir, { recursive: true });
  const target = path.join(cfg.stateDir, FILE);
  const tmp = `${target}.${process.pid}.${++saveCount}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2));
  await fs.rename(tmp, target);
}

/** Saves run one after another in call order, so an older save can never overwrite a newer
 *  one. A failed write rejects its own caller only; the chain goes on. */
export function saveDismissed(cfg, entries) {
  const run = chain.then(() => write(cfg, entries));
  chain = run.catch(() => {});
  return run;
}

/** Load -> fn(entries) -> save as ONE step on the save chain, so a read-modify-write cannot
 *  interleave with another one (a dismiss lost against a concurrent reconcile). `fn` returns
 *  the new list; nothing is written when it equals the loaded one. Returns the new list. */
export function updateDismissed(cfg, fn) {
  const run = chain.then(async () => {
    const before = await loadDismissed(cfg);
    const after = await fn(before);
    if (JSON.stringify(after) !== JSON.stringify(before)) await write(cfg, after);
    return after;
  });
  chain = run.catch(() => {});
  return run;
}
