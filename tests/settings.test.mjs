import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KEYS, defaultsOf, loadSettings, validatePatch, updateSettings } from '../src/settings.mjs';

async function tmpState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-settings-'));
  return { root, cfg: { stateDir: path.join(root, 'nested', 'state') } };
}

test('KEYS and defaultsOf', () => {
  assert.deepEqual(KEYS, { idleAfterMinutes: { min: 5, max: 1440 } });
  assert.deepEqual(defaultsOf({ idleAfterMinutes: 240, pollMs: 500 }), { idleAfterMinutes: 240 });
});

test('validatePatch accepts a known integer in range and null', () => {
  assert.deepEqual(validatePatch({ idleAfterMinutes: 120 }), { ok: true, patch: { idleAfterMinutes: 120 } });
  assert.deepEqual(validatePatch({ idleAfterMinutes: null }), { ok: true, patch: { idleAfterMinutes: null } });
  assert.deepEqual(validatePatch({}), { ok: true, patch: {} });
  assert.equal(validatePatch({ idleAfterMinutes: 5 }).ok, true);
  assert.equal(validatePatch({ idleAfterMinutes: 1440 }).ok, true);
});

test('validatePatch refuses everything else', () => {
  for (const body of [null, [], 'x', 7, { pollMs: 500 }, { idleAfterMinutes: 4 }, { idleAfterMinutes: 1441 },
    { idleAfterMinutes: 12.5 }, { idleAfterMinutes: '120' }, { idleAfterMinutes: true },
    JSON.parse('{"__proto__":{"idleAfterMinutes":60}}'), { idleAfterMinutes: 60, port: 1 }]) {
    const v = validatePatch(body);
    assert.equal(v.ok, false, JSON.stringify(body));
    assert.equal(typeof v.reason, 'string');
  }
});

test('loadSettings: missing, damaged and foreign content give no overrides', async () => {
  const { root, cfg } = await tmpState();
  try {
    assert.deepEqual(await loadSettings(cfg), {});
    await fs.mkdir(cfg.stateDir, { recursive: true });
    const file = path.join(cfg.stateDir, 'settings.json');
    const cases = [
      ['{ not json', {}],
      ['[1,2]', {}],
      ['{"idleAfterMinutes":0,"pollMs":1}', {}],
      ['{"idleAfterMinutes":120,"x":1}', { idleAfterMinutes: 120 }],
    ];
    for (const [text, expected] of cases) {
      await fs.writeFile(file, text);
      assert.deepEqual(await loadSettings(cfg), expected, text);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('updateSettings stores an override, drops one that equals the default, drops null', async () => {
  const { root, cfg } = await tmpState();
  try {
    const defaults = { idleAfterMinutes: 240 };
    assert.deepEqual(await updateSettings(cfg, defaults, { idleAfterMinutes: 60 }), { idleAfterMinutes: 60 });
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(cfg.stateDir, 'settings.json'), 'utf8')), { idleAfterMinutes: 60 });
    assert.deepEqual(await updateSettings(cfg, defaults, { idleAfterMinutes: 240 }), {});
    assert.deepEqual(await updateSettings(cfg, defaults, { idleAfterMinutes: 60 }), { idleAfterMinutes: 60 });
    assert.deepEqual(await updateSettings(cfg, defaults, { idleAfterMinutes: null }), {});
    assert.deepEqual(await fs.readdir(cfg.stateDir), ['settings.json']); // no temp file left
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('updateSettings: two calls at once land in call order', async () => {
  const { root, cfg } = await tmpState();
  try {
    const d = { idleAfterMinutes: 240 };
    const [, b] = await Promise.all([updateSettings(cfg, d, { idleAfterMinutes: 60 }), updateSettings(cfg, d, { idleAfterMinutes: 120 })]);
    assert.deepEqual(b, { idleAfterMinutes: 120 });
    assert.deepEqual(await loadSettings(cfg), { idleAfterMinutes: 120 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
