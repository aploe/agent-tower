import { test } from 'node:test';
import assert from 'node:assert/strict';
import { duration, relTime, stateLine, stateMark, stepTip, thirdLine, toolTip, unreadable } from '../public/modules/format.mjs';

const NOW = Date.parse('2026-11-16T12:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

test('relTime', () => {
  assert.equal(relTime(ago(5_000), NOW), 'now');
  assert.equal(relTime(ago(40_000), NOW), '40 s');
  assert.equal(relTime(ago(12 * 60_000), NOW), '12 min');
  assert.equal(relTime(ago(6 * 3_600_000), NOW), '6 h');
  assert.equal(relTime(ago(72 * 3_600_000), NOW), '3 d');
  assert.equal(relTime(null, NOW), '—');
});

test('relTime: unparseable and future timestamps', () => {
  assert.equal(relTime('garbage', NOW), '—');
  assert.equal(relTime(new Date(NOW + 30_000).toISOString(), NOW), 'now');
});

test('stateLine', () => {
  assert.deepEqual(stateLine({ state: 'working', current: { label: 'Deploy to staging' } }), { text: 'Deploy to staging', tone: 'normal' });
  assert.deepEqual(stateLine({ state: 'working', current: null }), { text: 'working', tone: 'normal' });
  assert.deepEqual(stateLine({ state: 'prompt', ask: { kind: 'permission', certain: true, via: 'main', tool: 'Bash' } }), { text: 'needs permission: Bash', tone: 'ask' });
  assert.deepEqual(stateLine({ state: 'prompt', ask: { kind: 'permission', certain: true, via: 'subagent', tool: 'Bash' } }), { text: 'subagent needs permission: Bash', tone: 'ask' });
  assert.deepEqual(stateLine({ state: 'prompt', ask: { kind: 'permission', certain: false, via: 'main', tool: 'Bash' } }), { text: 'probably asking', tone: 'askWeak' });
  assert.deepEqual(stateLine({ state: 'prompt', ask: { kind: 'question', certain: true } }), { text: 'asks a question', tone: 'ask' });
  assert.deepEqual(stateLine({ state: 'prompt', ask: { kind: 'plan', certain: true } }), { text: 'waits for plan approval', tone: 'ask' });
  assert.deepEqual(stateLine({ state: 'waiting' }), { text: 'done', tone: 'normal' });
  assert.deepEqual(stateLine({ state: 'idle' }), { text: 'idle', tone: 'normal' });
});

test('stateLine: a permission prompt without a known tool, and a prompt without ask', () => {
  assert.deepEqual(stateLine({ state: 'prompt', ask: { kind: 'permission', certain: true, via: 'main', tool: null } }), { text: 'needs permission', tone: 'ask' });
  assert.deepEqual(stateLine({ state: 'prompt', ask: null }), { text: 'probably asking', tone: 'askWeak' });
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
  assert.equal(unreadable({ registry: true, windows: false }), 'Windows sessions not readable right now');
  assert.equal(unreadable({ registry: false, windows: null }), 'WSL sessions not readable right now');
  assert.equal(unreadable({ registry: false, windows: false }), 'WSL and Windows sessions not readable right now');
  assert.equal(unreadable(undefined), null); // an older daemon sends no sources
  assert.equal(unreadable({ registry: true, colonyHook: false, vscodeUnread: false }), null); // these only add detail
});

test('toolTip: a readable name next to the tool, the bare name for unknown tools', () => {
  assert.equal(toolTip('Bash'), 'Shell command (Bash)');
  assert.equal(toolTip('Read'), 'Read file (Read)');
  assert.equal(toolTip('mcp__x__y'), 'mcp__x__y');
  assert.equal(toolTip(undefined), '—');
});

test('stepTip: what the mark means and when the step started (local clock)', () => {
  const at = new Date(2026, 10, 16, 9, 5).toISOString();
  assert.equal(stepTip({ status: 'done', at }), 'Done · started 09:05');
  assert.equal(stepTip({ status: 'error', at }), 'Failed or interrupted · started 09:05');
  assert.equal(stepTip({ status: 'running', at: null }), 'Running');
  assert.equal(stepTip({ status: 'done', at: 'garbage' }), 'Done');
});
