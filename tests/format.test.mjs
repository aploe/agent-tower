import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duration, relTime, stateLine, stateMark, thirdLine, unreadable } from '../public/modules/format.mjs';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('relTime', () => {
  assert.equal(relTime(ago(5_000), NOW), 'jetzt');
  assert.equal(relTime(ago(40_000), NOW), '40 s');
  assert.equal(relTime(ago(12 * 60_000), NOW), '12 min');
  assert.equal(relTime(ago(6 * 3_600_000), NOW), '6 h');
  assert.equal(relTime(ago(72 * 3_600_000), NOW), '3 d');
  assert.equal(relTime(null, NOW), '—');
});

test('relTime: unparseable and future timestamps', () => {
  assert.equal(relTime('garbage', NOW), '—');
  assert.equal(relTime(new Date(NOW + 30_000).toISOString(), NOW), 'jetzt');
});

test('stateLine', () => {
  assert.deepEqual(stateLine({ state: 'working', current: { label: 'Deploy to staging' } }), { text: 'Deploy to staging', tone: 'normal' });
  assert.deepEqual(stateLine({ state: 'working', current: null }), { text: 'arbeitet', tone: 'normal' });
  assert.deepEqual(stateLine({ state: 'prompt', ask: { kind: 'permission', certain: true, via: 'main', tool: 'Bash' } }), { text: 'braucht Freigabe: Bash', tone: 'ask' });
  assert.deepEqual(stateLine({ state: 'prompt', ask: { kind: 'permission', certain: true, via: 'subagent', tool: 'Bash' } }), { text: 'Subagent braucht Freigabe: Bash', tone: 'ask' });
  assert.deepEqual(stateLine({ state: 'prompt', ask: { kind: 'permission', certain: false, via: 'main', tool: 'Bash' } }), { text: 'fragt vermutlich', tone: 'askWeak' });
  assert.deepEqual(stateLine({ state: 'prompt', ask: { kind: 'question', certain: true } }), { text: 'stellt eine Frage', tone: 'ask' });
  assert.deepEqual(stateLine({ state: 'prompt', ask: { kind: 'plan', certain: true } }), { text: 'wartet auf Plan-Freigabe', tone: 'ask' });
  assert.deepEqual(stateLine({ state: 'waiting' }), { text: 'fertig', tone: 'normal' });
  assert.deepEqual(stateLine({ state: 'idle' }), { text: 'ruht', tone: 'normal' });
});

test('stateLine: a permission prompt without a known tool, and a prompt without ask', () => {
  assert.deepEqual(stateLine({ state: 'prompt', ask: { kind: 'permission', certain: true, via: 'main', tool: null } }), { text: 'braucht Freigabe', tone: 'ask' });
  assert.deepEqual(stateLine({ state: 'prompt', ask: null }), { text: 'fragt vermutlich', tone: 'askWeak' });
});

test('thirdLine', () => {
  assert.equal(thirdLine({ project: 'vereinsblog', stateSince: ago(120_000) }, NOW), 'vereinsblog · 2 min');
  assert.equal(thirdLine({ project: 'vereinsblog', stateSince: null }, NOW), 'vereinsblog · —');
});

test('duration', () => {
  assert.equal(duration(30), '30 min');
  assert.equal(duration(60), '1 h');
  assert.equal(duration(90), '90 min');
  assert.equal(duration(480), '8 h');
});

test('stateMark: a spinner while working, a dot when finished whose read state VS Code knows', () => {
  assert.equal(stateMark({ state: 'working', unread: null }), 'spin');
  assert.equal(stateMark({ state: 'waiting', unread: true }), 'unread');
  assert.equal(stateMark({ state: 'waiting', unread: false }), 'read');
  assert.equal(stateMark({ state: 'waiting', unread: null }), null); // not known: no dot, not a grey one
  assert.equal(stateMark({ state: 'waiting' }), null); // an older daemon sends no field
  assert.equal(stateMark({ state: 'prompt', unread: true }), null);
  assert.equal(stateMark({ state: 'idle', unread: true }), null);
});

test('unreadable names the sides the daemon could not read', () => {
  assert.equal(unreadable({ registry: true, windows: true }), null);
  assert.equal(unreadable({ registry: true, windows: null }), null); // Windows not configured: nothing missing
  assert.equal(unreadable({ registry: true, windows: false }), 'Windows-Sessions gerade nicht lesbar');
  assert.equal(unreadable({ registry: false, windows: null }), 'WSL-Sessions gerade nicht lesbar');
  assert.equal(unreadable({ registry: false, windows: false }), 'WSL- und Windows-Sessions gerade nicht lesbar');
  assert.equal(unreadable(undefined), null); // an older daemon sends no sources
  assert.equal(unreadable({ registry: true, colonyHook: false, vscodeUnread: false }), null); // these only add detail
});
