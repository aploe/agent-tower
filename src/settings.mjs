// The user's overrides of the daemon config, kept in `settings.json` in the state folder.
// Only values that differ from the config default are stored (spec 5.1).
import fs from 'node:fs/promises';
import path from 'node:path';

export const KEYS = { idleAfterMinutes: { min: 5, max: 1440 } };

const FILE = 'settings.json';
let saveCount = 0;

function isValue(key, value) {
  const { min, max } = KEYS[key];
  return Number.isInteger(value) && value >= min && value <= max;
}

export function defaultsOf(cfg) {
  return Object.fromEntries(Object.keys(KEYS).map((key) => [key, cfg[key]]));
}

/** The valid overrides in the file; anything missing, damaged or foreign is ignored. */
export async function loadSettings(cfg) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(path.join(cfg.stateDir, FILE), 'utf8'));
  } catch {
    return {};
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {};
  const out = {};
  for (const key of Object.keys(data)) {
    if (Object.hasOwn(KEYS, key) && isValue(key, data[key])) out[key] = data[key];
  }
  return out;
}

/** Own keys only (Object.keys), so a `__proto__` entry is an unknown key, not a lookup. */
export function validatePatch(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'Settings must be a JSON object' };
  }
  const patch = {};
  for (const key of Object.keys(body)) {
    if (!Object.hasOwn(KEYS, key)) return { ok: false, reason: `Unknown setting: ${key}` };
    const value = body[key];
    if (value !== null && !isValue(key, value)) {
      const { min, max } = KEYS[key];
      return { ok: false, reason: `${key} must be a whole number from ${min} to ${max}` };
    }
    patch[key] = value;
  }
  return { ok: true, patch };
}

async function write(cfg, overrides) {
  await fs.mkdir(cfg.stateDir, { recursive: true });
  const target = path.join(cfg.stateDir, FILE);
  const tmp = `${target}.${process.pid}.${++saveCount}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(overrides, null, 2));
  await fs.rename(tmp, target);
}

let chain = Promise.resolve();

/** Load -> apply patch -> save as ONE step on a promise chain, so two updates cannot
 *  interleave their read and write. null or a value equal to the default removes the override.
 *  A failed write rejects its own caller only; the chain goes on. Returns the new overrides. */
export function updateSettings(cfg, defaults, patch) {
  const run = chain.then(async () => {
    const before = await loadSettings(cfg);
    const after = { ...before };
    for (const key of Object.keys(patch)) {
      if (patch[key] === null || patch[key] === defaults[key]) delete after[key];
      else after[key] = patch[key];
    }
    if (JSON.stringify(after) !== JSON.stringify(before)) await write(cfg, after);
    return after;
  });
  chain = run.catch(() => {});
  return run;
}
