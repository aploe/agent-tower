import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { groupOf, reconcile, loadDismissed, saveDismissed, updateDismissed } from '../src/dismissed.mjs';

async function tmpState() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-dismissed-'));
  return { root, cfg: { stateDir: path.join(root, 'nested', 'state') } };
}

test('waiting and idle are one group', () => {
  assert.equal(groupOf('waiting'), groupOf('idle'));
  assert.equal(groupOf('waiting'), 'finished');
  assert.equal(groupOf('working'), 'working');
  assert.equal(groupOf('prompt'), 'prompt');
});

test('reconcile keeps a finished row that ages from waiting to idle', () => {
  const entries = [{ sessionId: 'a', group: 'finished' }];
  assert.deepEqual(reconcile(entries, [{ id: 'a', state: 'waiting' }]), entries);
  assert.deepEqual(reconcile(entries, [{ id: 'a', state: 'idle' }]), entries);
});

test('reconcile drops an entry when the session works again, asks, or is gone', () => {
  const entries = [{ sessionId: 'a', group: 'finished' }];
  assert.deepEqual(reconcile(entries, [{ id: 'a', state: 'working' }]), []);
  assert.deepEqual(reconcile(entries, [{ id: 'a', state: 'prompt' }]), []);
  assert.deepEqual(reconcile(entries, [{ id: 'b', state: 'waiting' }]), []);
  assert.deepEqual(reconcile(entries, []), []);
});

test('load: missing file and corrupt file both give []', async () => {
  const { root, cfg } = await tmpState();
  try {
    assert.deepEqual(await loadDismissed(cfg), []);
    await fs.mkdir(cfg.stateDir, { recursive: true });
    const file = path.join(cfg.stateDir, 'dismissed.json');
    await fs.writeFile(file, '{not json');
    assert.deepEqual(await loadDismissed(cfg), []);
    await fs.writeFile(file, '{"sessionId":"a"}');
    assert.deepEqual(await loadDismissed(cfg), []);
    await fs.writeFile(file, JSON.stringify([
      { sessionId: 'ok', group: 'working' },
      { sessionId: 5, group: 'working' },
      { sessionId: 'x', group: 'bogus' },
      null,
    ]));
    assert.deepEqual(await loadDismissed(cfg), [{ sessionId: 'ok', group: 'working' }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('save then load round-trips and creates the folder', async () => {
  const { root, cfg } = await tmpState();
  try {
    const entries = [{ sessionId: 'a', group: 'finished' }, { sessionId: 'b', group: 'prompt' }];
    await saveDismissed(cfg, entries);
    assert.deepEqual(await loadDismissed(cfg), entries);
    assert.deepEqual(await fs.readdir(cfg.stateDir), ['dismissed.json']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('saves started together land in call order: the file holds the last call', async () => {
  const { root, cfg } = await tmpState();
  try {
    const big = Array.from({ length: 20000 }, (_, i) => ({ sessionId: `s${i}`, group: 'finished' }));
    const small = [{ sessionId: 'last', group: 'working' }];
    await Promise.all([saveDismissed(cfg, big), saveDismissed(cfg, small)]);
    assert.deepEqual(await loadDismissed(cfg), small);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a failed save does not break the chain for the next one', async () => {
  const { root, cfg } = await tmpState();
  try {
    await fs.mkdir(path.dirname(cfg.stateDir), { recursive: true });
    await fs.writeFile(cfg.stateDir, 'a file where the folder should be');
    await assert.rejects(saveDismissed(cfg, [{ sessionId: 'a', group: 'working' }]));
    await fs.rm(cfg.stateDir);
    await saveDismissed(cfg, [{ sessionId: 'b', group: 'working' }]);
    assert.deepEqual(await loadDismissed(cfg), [{ sessionId: 'b', group: 'working' }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('updateDismissed: a dismiss started during a reconcile survives', async () => {
  const { root, cfg } = await tmpState();
  try {
    await saveDismissed(cfg, [{ sessionId: 'old', group: 'finished' }]);
    let release;
    const gate = new Promise((r) => { release = r; });
    // the reconcile reads the list, then waits; the dismiss is started meanwhile
    const reconcileRun = updateDismissed(cfg, async (entries) => {
      await gate;
      return entries.filter((e) => e.sessionId !== 'old');
    });
    const dismissRun = updateDismissed(cfg, (entries) => [...entries, { sessionId: 'new', group: 'working' }]);
    release();
    await Promise.all([reconcileRun, dismissRun]);
    assert.deepEqual(await loadDismissed(cfg), [{ sessionId: 'new', group: 'working' }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('updateDismissed returns the new list and writes nothing when it is unchanged', async () => {
  const { root, cfg } = await tmpState();
  try {
    assert.deepEqual(await updateDismissed(cfg, (e) => e), []);
    await assert.rejects(fs.stat(cfg.stateDir)); // no folder created for a no-op
    const next = await updateDismissed(cfg, () => [{ sessionId: 'a', group: 'prompt' }]);
    assert.deepEqual(next, [{ sessionId: 'a', group: 'prompt' }]);
    assert.deepEqual(await loadDismissed(cfg), next);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reconcile with keepAbsent keeps entries whose session is missing, and still drops a changed group', () => {
  const entries = [{ sessionId: 'gone', group: 'finished' }, { sessionId: 'here', group: 'working' }];
  const sessions = [{ id: 'here', state: 'waiting' }];
  assert.deepEqual(reconcile(entries, sessions, { keepAbsent: true }), [{ sessionId: 'gone', group: 'finished' }]);
  assert.deepEqual(reconcile(entries, sessions), []);
});
