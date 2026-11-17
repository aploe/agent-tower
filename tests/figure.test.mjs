import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { HUE_COUNT, assignHues, hueIndex } from '../public/modules/figure.mjs';

const session = (id, extra = {}) => ({ id, startedAt: '2026-11-17T08:00:00.000Z', dismissed: false, ...extra });

/** `count` ids whose hash colour (modulo n) is the same. */
function collidingIds(count, n) {
  const byHue = new Map();
  for (let i = 0; ; i++) {
    const id = `s-${i}`;
    const k = hueIndex(id, n);
    const list = byHue.get(k) ?? [];
    list.push(id);
    byHue.set(k, list);
    if (list.length === count) return list;
  }
}

test('hueIndex is stable, in range, and spreads', () => {
  const id = '5f0c9e2a-7b41-4d8e-9a36-c21e8b7f4d10';
  assert.equal(hueIndex(id), hueIndex(id));
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const v = hueIndex(randomUUID());
    assert.ok(Number.isInteger(v) && v >= 0 && v < HUE_COUNT, `out of range: ${v}`);
    seen.add(v);
  }
  assert.ok(seen.size >= HUE_COUNT - 2, `only ${seen.size} of ${HUE_COUNT} hues used`);
});

test('hueIndex honours n', () => {
  const v = hueIndex('abc', 3);
  assert.ok(v >= 0 && v < 3);
});

test('tower.css defines exactly HUE_COUNT figure hues', () => {
  const css = readFileSync(new URL('../public/tower.css', import.meta.url), 'utf8');
  const defined = [...css.matchAll(/--hue-(\d+):/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  assert.deepEqual(defined, Array.from({ length: HUE_COUNT }, (_, i) => i));
});

test('assignHues: sessions whose hash colours collide still get different colours', () => {
  const ids = collidingIds(4, HUE_COUNT);
  const hues = assignHues(ids.map((id) => session(id)));
  assert.equal(new Set(hues.values()).size, 4);
  for (const v of hues.values()) assert.ok(v >= 0 && v < HUE_COUNT);
});

test('assignHues: a session takes its hash colour while that one is free', () => {
  const hues = assignHues([session('only-one')]);
  assert.equal(hues.get('only-one'), hueIndex('only-one'));
});

test('assignHues: the older session keeps the hash colour, the newer one moves', () => {
  const [a, b] = collidingIds(2, HUE_COUNT);
  const hues = assignHues([
    session(b, { startedAt: '2026-11-17T09:00:00.000Z' }),
    session(a, { startedAt: '2026-11-17T08:00:00.000Z' }),
  ]);
  assert.equal(hues.get(a), hueIndex(a));
  assert.equal(hues.get(b), (hueIndex(b) + 1) % HUE_COUNT);
});

test('assignHues: a hidden session gives way to a shown one', () => {
  const [a, b] = collidingIds(2, HUE_COUNT);
  const hues = assignHues([
    session(a, { dismissed: true }),
    session(b, { startedAt: '2026-11-17T09:00:00.000Z' }),
  ]);
  assert.equal(hues.get(b), hueIndex(b));
});

test('assignHues: a session keeps the colour it holds, even when its own one is free again', () => {
  const [a, b] = collidingIds(2, HUE_COUNT);
  const first = assignHues([session(a), session(b, { startedAt: '2026-11-17T09:00:00.000Z' })]);
  const moved = first.get(b);
  const second = assignHues([session(b, { startedAt: '2026-11-17T09:00:00.000Z' })], first);
  assert.equal(second.get(b), moved);
  assert.equal(second.has(a), false, 'ended sessions drop out');
});

test('assignHues: a colour freed by an ended session goes to the next one that hashes to it', () => {
  const [a, b] = collidingIds(2, HUE_COUNT);
  const held = assignHues([session(a)]);
  assert.equal(assignHues([session(a), session(b)], held).get(b), (hueIndex(b) + 1) % HUE_COUNT, 'a still listed: b moves');
  assert.equal(assignHues([session(b)], held).get(b), hueIndex(b), 'a ended: b takes its own colour');
});

test('assignHues: more sessions than colours still gives every one a colour', () => {
  const sessions = Array.from({ length: 7 }, (_, i) => session(`many-${i}`));
  const hues = assignHues(sessions, new Map(), 3);
  assert.equal(hues.size, 7);
  assert.equal(new Set(hues.values()).size, 3);
  for (const v of hues.values()) assert.ok(v >= 0 && v < 3);
});
