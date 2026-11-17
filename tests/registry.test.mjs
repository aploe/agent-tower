import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry } from '../src/sources/registry.mjs';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tower-registry-'));
  const claudeDir = join(root, 'claude');
  const sessions = join(claudeDir, 'sessions');
  const procRoot = join(root, 'proc');
  await mkdir(sessions, { recursive: true });
  await mkdir(procRoot, { recursive: true });
  return { cfg: { claudeDir }, sessions, procRoot };
}

async function writeReg(dir, pid, obj) {
  await writeFile(join(dir, `${pid}.json`), typeof obj === 'string' ? obj : JSON.stringify(obj));
}

async function writeStat(procRoot, pid, state, start) {
  await mkdir(join(procRoot, String(pid)), { recursive: true });
  await writeFile(
    join(procRoot, String(pid), 'stat'),
    `${pid} (cl aude) ${state} ${Array(18).fill('0').join(' ')} ${start} 0 0`,
  );
}

function reg(pid, over = {}) {
  return { pid, sessionId: `s-${pid}`, cwd: '/w', startedAt: 1794840000000, procStart: '500', ...over };
}

test('a live entry carries every field', async () => {
  const { cfg, sessions, procRoot } = await setup();
  await writeReg(sessions, 100, reg(100, {
    kind: 'interactive', entrypoint: 'claude-vscode', name: 'foo', nameSource: 'derived',
    status: 'busy', statusUpdatedAt: 1794840965761, waitingFor: 'approve Bash',
  }));
  await writeStat(procRoot, 100, 'S', '500');
  const r = await loadRegistry(cfg, { procRoot });
  assert.deepEqual(r.live.get('s-100'), {
    pid: 100, sessionId: 's-100', cwd: '/w',
    startedAt: new Date(1794840000000).toISOString(),
    kind: 'interactive', entrypoint: 'claude-vscode', name: 'foo', nameSource: 'derived',
    status: 'busy', statusUpdatedAtMs: 1794840965761, waitingFor: 'approve Bash',
    origin: 'wsl', hostSessionId: null,
  });
});

test('missing fields become null', async () => {
  const { cfg, sessions, procRoot } = await setup();
  await writeReg(sessions, 101, { pid: 101, sessionId: 'x', procStart: '500' });
  await writeStat(procRoot, 101, 'S', '500');
  const e = (await loadRegistry(cfg, { procRoot })).live.get('x');
  assert.equal(e.cwd, null);
  assert.equal(e.startedAt, null);
  assert.equal(e.statusUpdatedAtMs, null);
  assert.equal(e.waitingFor, null);
  assert.equal(e.status, null);
});

test('procStart mismatch means a reused PID: dropped', async () => {
  const { cfg, sessions, procRoot } = await setup();
  await writeReg(sessions, 200, reg(200));
  await writeStat(procRoot, 200, 'S', '999');
  const r = await loadRegistry(cfg, { procRoot });
  assert.equal(r.live.size, 0);
});

test('a zombie (state Z) is dropped', async () => {
  const { cfg, sessions, procRoot } = await setup();
  await writeReg(sessions, 300, reg(300));
  await writeStat(procRoot, 300, 'Z', '500');
  const r = await loadRegistry(cfg, { procRoot });
  assert.equal(r.live.size, 0);
});

test('unparseable JSON and a file without sessionId are skipped, the rest survives', async () => {
  const { cfg, sessions, procRoot } = await setup();
  await writeReg(sessions, 400, '{ not json');
  await writeReg(sessions, 401, { pid: 401, procStart: '500' });
  await writeReg(sessions, 402, reg(402));
  for (const p of [400, 401, 402]) await writeStat(procRoot, p, 'S', '500');
  const r = await loadRegistry(cfg, { procRoot });
  assert.deepEqual([...r.live.keys()], ['s-402']);
});

test('a file that vanishes between readdir and readFile is skipped', async () => {
  const { cfg, sessions, procRoot } = await setup();
  await symlink(join(sessions, 'nowhere.json'), join(sessions, '4711.json'));
  await writeReg(sessions, 500, reg(500));
  await writeStat(procRoot, 500, 'S', '500');
  const r = await loadRegistry(cfg, { procRoot });
  assert.deepEqual([...r.live.keys()], ['s-500']);
});

test('two entries with one sessionId: the live one wins', async () => {
  const { cfg, sessions, procRoot } = await setup();
  await writeReg(sessions, 600, reg(600, { sessionId: 'same' }));
  await writeReg(sessions, 601, reg(601, { sessionId: 'same' }));
  await writeStat(procRoot, 601, 'S', '500'); // 600 has no /proc entry
  const r = await loadRegistry(cfg, { procRoot });
  assert.equal(r.live.size, 1);
  assert.equal(r.live.get('same').pid, 601);
});

test('garbage startedAt becomes null instead of throwing', async () => {
  const { cfg, sessions, procRoot } = await setup();
  await writeReg(sessions, 700, reg(700, { startedAt: 'not a date', statusUpdatedAt: 'x' }));
  await writeStat(procRoot, 700, 'S', '500');
  const e = (await loadRegistry(cfg, { procRoot })).live.get('s-700');
  assert.equal(e.startedAt, null);
  assert.equal(e.statusUpdatedAtMs, null);
});

test('knownCwds lists dead entries too, without duplicates', async () => {
  const { cfg, sessions, procRoot } = await setup();
  await writeReg(sessions, 800, reg(800, { cwd: '/a' }));
  await writeReg(sessions, 801, reg(801, { cwd: '/a' }));
  await writeReg(sessions, 802, reg(802, { cwd: '/b' }));
  await writeStat(procRoot, 800, 'S', '500');
  const r = await loadRegistry(cfg, { procRoot });
  assert.equal(r.live.size, 1);
  assert.deepEqual([...r.knownCwds].sort(), ['/a', '/b']);
});

test('a missing sessions folder returns null', async () => {
  const { procRoot } = await setup();
  const r = await loadRegistry({ claudeDir: join(tmpdir(), 'tower-does-not-exist-xyz') }, { procRoot });
  assert.equal(r, null);
});

test('a custom startTimes decides liveness in one call; origin and hostSessionId are carried', async () => {
  const { cfg, sessions } = await setup();
  await writeReg(sessions, 51056, reg(51056, {
    procStart: '134393895681048400', entrypoint: 'claude-desktop',
    hostSessionId: 'local_0b1c2d3e-0000-4000-8000-000000000001', cwd: 'C:\\Users\\sam\\notes',
  }));
  await writeReg(sessions, 50156, reg(50156, { procStart: '134393258502160508' })); // PID reused: other start time
  await writeReg(sessions, 777, reg(777, { procStart: '1' })); // not running
  const calls = [];
  const r = await loadRegistry(cfg, {
    origin: 'windows',
    startTimes: async (pids) => {
      calls.push([...pids].sort((a, b) => a - b));
      return new Map([[51056, '134393895681048400'], [50156, '999']]);
    },
  });
  assert.deepEqual(calls, [[777, 50156, 51056]]);
  assert.deepEqual([...r.live.keys()], ['s-51056']);
  const e = r.live.get('s-51056');
  assert.equal(e.origin, 'windows');
  assert.equal(e.hostSessionId, 'local_0b1c2d3e-0000-4000-8000-000000000001');
  assert.equal(e.cwd, 'C:\\Users\\sam\\notes');
  assert.deepEqual(r.knownCwds.sort(), ['/w', 'C:\\Users\\sam\\notes']);
});

test('startTimes null makes the registry unreadable', async () => {
  const { cfg, sessions } = await setup();
  await writeReg(sessions, 1, reg(1));
  assert.equal(await loadRegistry(cfg, { startTimes: async () => null }), null);
});

test('no candidate: startTimes is not called', async () => {
  const { cfg, sessions } = await setup();
  await writeReg(sessions, 2, reg(2, { procStart: undefined }));
  let called = false;
  const r = await loadRegistry(cfg, { startTimes: async () => { called = true; return new Map(); } });
  assert.equal(called, false);
  assert.equal(r.live.size, 0);
});

test('claudeDir option beats cfg.claudeDir; defaults are origin wsl and hostSessionId null', async () => {
  const { cfg, procRoot } = await setup();
  const second = await mkdtemp(join(tmpdir(), 'tower-registry-second-'));
  await mkdir(join(second, 'sessions'));
  await writeReg(join(second, 'sessions'), 600, reg(600));
  await writeStat(procRoot, 600, 'S', '500');
  const r = await loadRegistry(cfg, { claudeDir: second, procRoot });
  const e = r.live.get('s-600');
  assert.equal(e.origin, 'wsl');
  assert.equal(e.hostSessionId, null);
  assert.equal((await loadRegistry(cfg, { procRoot })).live.size, 0); // cfg.claudeDir has no entry
});
