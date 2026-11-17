// Adapted from agent-colony@7da77bb: tests/hookStatus.test.mjs
// Changed: reads cfg.colonyHookDir, asserts sinceMs (number) instead of since,
// dropped the subagent-counter cases, added the unparseable-since case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadColonyHook } from '../src/sources/colonyHook.mjs';

function dirWith(files) {
  const base = mkdtempSync(join(tmpdir(), 'tower-colonyhook-'));
  const dir = join(base, 'agent-colony');
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return { base, dir };
}

test('reads entries as a map with status and sinceMs', async () => {
  const { base, dir } = dirWith({
    'aaa.json': '{"sessionId":"aaa","status":"waiting","since":"2026-09-11T00:00:00Z"}',
    'bbb.json': '{"sessionId":"bbb","status":"working","since":"2026-09-11T00:05:00Z"}',
  });
  const map = await loadColonyHook({ colonyHookDir: dir });
  assert.equal(map.size, 2);
  assert.deepEqual(map.get('aaa'), { status: 'waiting', sinceMs: Date.parse('2026-09-11T00:00:00Z') });
  assert.equal(typeof map.get('bbb').sinceMs, 'number');
  assert.equal(map.get('bbb').status, 'working');
  assert.equal('subagents' in map.get('aaa'), false);
  rmSync(base, { recursive: true, force: true });
});

test('survives half-written files', async () => {
  const { base, dir } = dirWith({
    'aaa.json': '{"sessionId":"aaa","status":"idle","since":"2026-09-11T00:00:00Z"}',
    'bbb.json': '{"sessionId":"bbb","stat',
  });
  const map = await loadColonyHook({ colonyHookDir: dir });
  assert.equal(map.size, 1, 'the broken file drops out silently');
  rmSync(base, { recursive: true, force: true });
});

test('accepts the fourth state prompt', async () => {
  const { base, dir } = dirWith({
    'aaa.json': '{"sessionId":"aaa","status":"prompt","since":"2026-09-12T00:00:00Z"}',
  });
  const map = await loadColonyHook({ colonyHookDir: dir });
  assert.equal(map.get('aaa').status, 'prompt');
  rmSync(base, { recursive: true, force: true });
});

test('discards entries with an unknown status', async () => {
  const { base, dir } = dirWith({
    'aaa.json': '{"sessionId":"aaa","status":"tanzt","since":"2026-09-11T00:00:00Z"}',
  });
  const map = await loadColonyHook({ colonyHookDir: dir });
  assert.equal(map.size, 0);
  rmSync(base, { recursive: true, force: true });
});

test('missing folder gives null, not an empty map', async () => {
  const map = await loadColonyHook({ colonyHookDir: join(tmpdir(), 'gibt-es-nicht-4711') });
  assert.equal(map, null, 'null means unknown, an empty map would mean nobody works');
});

test('unparseable since gives sinceMs null', async () => {
  const { base, dir } = dirWith({
    'aaa.json': '{"sessionId":"aaa","status":"working","since":"garbage"}',
    'bbb.json': '{"sessionId":"bbb","status":"idle"}',
  });
  const map = await loadColonyHook({ colonyHookDir: dir });
  assert.equal(map.get('aaa').sinceMs, null);
  assert.equal(map.get('aaa').status, 'working');
  assert.equal(map.get('bbb').sinceMs, null);
  rmSync(base, { recursive: true, force: true });
});
