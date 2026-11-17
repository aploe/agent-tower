import test from 'node:test';
import assert from 'node:assert/strict';
import { decideSessionState, wantsSubagents, LONG_RUNNING, INTERACTIVE } from '../src/state.mjs';

const T = Date.parse('2026-11-16T12:00:00Z');
const S = 1000;
const M = 60000;
const cfg = { idleAfterMinutes: 240, promptAfterSeconds: 60, fallback: { workingMinutes: 3, promptMinutes: 1, waitingMinutes: 90 } };
const none = { status: null, statusUpdatedAtMs: null, waitingFor: null };
const busy = { status: 'busy', statusUpdatedAtMs: T - 5 * M, waitingFor: null };
const call = (name, atMs, status = 'running') => ({ id: `${name}-${atMs}`, name, input: {}, atMs, status, resultText: null });
const decide = (o = {}) => decideSessionState({
  now: T, registry: busy, hook: null, open: [], subOpen: [], lastMs: T - 2 * M, lastType: 'assistant', cfg, ...o,
});

test('constants', () => {
  assert.deepEqual([...LONG_RUNNING].sort(), ['Agent', 'Monitor', 'TaskOutput', 'Workflow']);
  assert.deepEqual([...INTERACTIVE].sort(), ['AskUserQuestion', 'ExitPlanMode']);
});

test('1: open AskUserQuestion is a certain question, whatever else says', () => {
  const d = decide({ registry: { ...busy, status: 'idle' }, open: [call('AskUserQuestion', T - 9 * M)] });
  assert.deepEqual([d.state, d.rule, d.ask.kind, d.ask.certain, d.ask.via, d.stateSource, d.stateSinceMs],
    ['prompt', '1', 'question', true, 'main', 'transcript', T - 9 * M]);
});
test('1: open ExitPlanMode is a plan approval', () => {
  const d = decide({ open: [call('ExitPlanMode', T - M)], hook: { status: 'working', sinceMs: T - 10 * M } });
  assert.deepEqual([d.state, d.rule, d.ask.kind, d.ask.certain], ['prompt', '1', 'plan', true]);
});
test('1: interactive call with atMs null still wins, stateSinceMs null', () => {
  const d = decide({ open: [call('AskUserQuestion', null)] });
  assert.deepEqual([d.rule, d.stateSinceMs], ['1', null]);
});
test('1: a finished AskUserQuestion is not open', () => {
  const d = decide({ open: [call('AskUserQuestion', T - M, 'done')] });
  assert.equal(d.rule, '4');
});
test('2a: hook prompt vouches for a call not newer than since + 2 s', () => {
  const d = decide({ registry: none, hook: { status: 'prompt', sinceMs: T - 5 * M }, open: [call('Bash', T - 5 * M - 200)] });
  assert.deepEqual([d.state, d.rule, d.ask.certain, d.stateSource, d.stateSinceMs], ['prompt', '2a', true, 'hook', T - 5 * M - 200]);
  assert.equal(d.ask.kind, 'permission');
  assert.equal(d.ask.via, 'main');
});
test('2a: oldest qualifying call wins', () => {
  const old = call('Bash', T - 5 * M - 1000);
  const d = decide({ registry: none, hook: { status: 'prompt', sinceMs: T - 5 * M }, open: [call('Edit', T - 5 * M + 1000), old] });
  assert.equal(d.ask.call, old);
});
test('2b: a newer call older than 60 s is an uncertain prompt', () => {
  const d = decide({ registry: none, hook: { status: 'prompt', sinceMs: T - 30 * M }, open: [call('Bash', T - 90 * S)] });
  assert.deepEqual([d.state, d.rule, d.ask.certain, d.stateSource, d.stateSinceMs], ['prompt', '2b', false, 'transcript', T - 90 * S]);
});
test('2b does not fire for a call younger than 60 s: fallback decides (rule 5)', () => {
  const d = decide({ registry: none, hook: { status: 'prompt', sinceMs: T - 30 * M }, open: [call('Bash', T - 10 * S)] });
  assert.deepEqual([d.state, d.rule], ['working', '5']);
});
test('2c: subagent call the hook vouches for', () => {
  const since = T - 2 * M;
  const d = decide({ registry: none, hook: { status: 'prompt', sinceMs: since }, open: [call('Agent', T - 5 * M)], subOpen: [call('Bash', since - 100)] });
  assert.deepEqual([d.state, d.rule, d.ask.via, d.ask.certain, d.stateSource], ['prompt', '2c', 'subagent', true, 'hook']);
  assert.equal(d.stateSinceMs, since - 100);
});
test('2c: newer subagent call older than 60 s is uncertain', () => {
  const d = decide({ registry: none, hook: { status: 'prompt', sinceMs: T - 30 * M }, open: [], subOpen: [call('Bash', T - 2 * M)] });
  assert.deepEqual([d.state, d.rule, d.ask.via, d.ask.certain, d.stateSource], ['prompt', '2c', 'subagent', false, 'transcript']);
});
test('2c: subagent calls of long-running tools do not count', () => {
  const d = decide({ registry: none, hook: { status: 'prompt', sinceMs: T - 30 * M }, open: [], subOpen: [call('Monitor', T - 2 * M)] });
  assert.equal(d.rule, '5');
});
test('2c is skipped when a qualifying main call exists', () => {
  const d = decide({ registry: none, hook: { status: 'prompt', sinceMs: T - 30 * M }, open: [call('Bash', T - 10 * S)], subOpen: [call('Bash', T - 5 * M)] });
  assert.equal(d.rule, '5');
});
test('2: hook prompt without any qualifying call falls through to the registry', () => {
  const d = decide({ registry: none, hook: { status: 'prompt', sinceMs: T - M }, open: [call('Agent', T - 9 * M)] });
  assert.equal(d.rule, '5');
});
test('2: hook prompt with sinceMs null vouches for nothing; 2b still applies', () => {
  const d = decide({ registry: none, hook: { status: 'prompt', sinceMs: null }, open: [call('Bash', T - 10 * M)] });
  assert.deepEqual([d.rule, d.ask.certain], ['2b', false]);
  const young = decide({ registry: none, hook: { status: 'prompt', sinceMs: null }, open: [call('Bash', T - 5 * S)] });
  assert.equal(young.rule, '5');
});
test('2: hook prompt with sinceMs null, subagent call is uncertain 2c', () => {
  const d = decide({ registry: none, hook: { status: 'prompt', sinceMs: null }, subOpen: [call('Bash', T - 10 * M)] });
  assert.deepEqual([d.rule, d.ask.certain, d.ask.via], ['2c', false, 'subagent']);
});
test('2: open call with atMs null cannot be compared', () => {
  const d = decide({ registry: none, hook: { status: 'prompt', sinceMs: T - M }, open: [call('Bash', null)] });
  assert.equal(d.rule, '5');
});
test('3: no hook file, open call older than 60 s: uncertain prompt', () => {
  const d = decide({ registry: none, hook: null, open: [call('Bash', T - 61 * S)] });
  assert.deepEqual([d.state, d.rule, d.ask.certain, d.ask.via, d.stateSource, d.stateSinceMs], ['prompt', '3', false, 'main', 'transcript', T - 61 * S]);
});
test('3: exactly 60 s is not older than 60 s', () => {
  assert.equal(decide({ registry: none, hook: null, open: [call('Bash', T - 60 * S)] }).rule, '5');
});
test('3: does not fire when a hook file exists', () => {
  const d = decide({ registry: none, hook: { status: 'working', sinceMs: T - M }, open: [call('Bash', T - 10 * M)] });
  assert.equal(d.rule, '5');
});
test('a hook that says working vouches against a prompt', () => {
  const d = decide({ hook: { status: 'working', sinceMs: T - 20 * M }, open: [call('Bash', T - 10 * M)] });
  assert.deepEqual([d.state, d.rule], ['working', '4']);
});
test('long-running tools never count as a prompt', () => {
  const d = decide({ registry: none, hook: null, open: [call('Monitor', T - 10 * M)] });
  assert.deepEqual([d.state, d.rule], ['working', '5']);
});
test('4: idle is waiting for 240 minutes, then idle', () => {
  const w = decide({ registry: { status: 'idle', statusUpdatedAtMs: T - 10 * M, waitingFor: null } });
  assert.deepEqual([w.state, w.rule, w.stateSource, w.stateSinceMs, w.ask], ['waiting', '4', 'registry', T - 10 * M, null]);
  assert.equal(decide({ registry: { status: 'idle', statusUpdatedAtMs: T - 241 * M, waitingFor: null } }).state, 'idle');
});
test('4: shell counts as working', () => {
  const sh = decide({ registry: { ...busy, status: 'shell' } });
  assert.deepEqual([sh.state, sh.rule], ['working', '4']);
});
test('4: registry waiting with a main call is a certain permission prompt, since = statusUpdatedAt', () => {
  const c = call('Bash', T - 30 * S);
  const w = decide({ registry: { status: 'waiting', statusUpdatedAtMs: T - 3 * M, waitingFor: 'permission prompt' }, open: [call('Agent', T - 9 * M), c] });
  assert.deepEqual([w.state, w.rule, w.stateSource, w.stateSinceMs], ['prompt', '4', 'registry', T - 3 * M]);
  assert.deepEqual(w.ask, { kind: 'permission', certain: true, via: 'main', call: c, summary: 'permission prompt' });
});
test('4: registry waiting with only a subagent call is via subagent, certain', () => {
  const c = call('Bash', T - 30 * S);
  const w = decide({ registry: { status: 'waiting', statusUpdatedAtMs: T - M, waitingFor: 'permission prompt' }, open: [call('Agent', T - 9 * M)], subOpen: [call('Edit', T - 10 * S), c].sort((a, b) => a.atMs - b.atMs) });
  assert.deepEqual([w.state, w.rule, w.ask.via, w.ask.certain, w.stateSinceMs], ['prompt', '4', 'subagent', true, T - M]);
  assert.equal(w.ask.call.name, 'Bash');
});
test('4: registry busy + hook prompt + old open Bash is working (grant edge)', () => {
  const d = decide({ hook: { status: 'prompt', sinceMs: T - 30 * M }, open: [call('Bash', T - 5 * M)] });
  assert.deepEqual([d.state, d.rule, d.stateSource, d.ask], ['working', '4', 'registry', null]);
});
test('4: registry busy + stale hook prompt + old subagent call is working', () => {
  const d = decide({ hook: { status: 'prompt', sinceMs: T - 30 * M }, open: [], subOpen: [call('Bash', T - 5 * M)] });
  assert.deepEqual([d.state, d.rule], ['working', '4']);
});
test('4: registry waiting without call or waitingFor', () => {
  const w = decide({ registry: { status: 'waiting', statusUpdatedAtMs: T - 3 * M, waitingFor: '' } });
  assert.deepEqual([w.state, w.stateSinceMs, w.ask.call, w.ask.summary, w.ask.via, w.ask.certain], ['prompt', T - 3 * M, null, null, 'main', true]);
});
test('4: idle without statusUpdatedAtMs is waiting with stateSinceMs null', () => {
  const d = decide({ registry: { status: 'idle', statusUpdatedAtMs: null, waitingFor: null } });
  assert.deepEqual([d.state, d.stateSinceMs], ['waiting', null]);
});
test('5: no registry status: fallback working by recent activity', () => {
  const d = decide({ registry: { status: null, statusUpdatedAtMs: null, waitingFor: null }, lastMs: T - M });
  assert.deepEqual([d.state, d.rule, d.stateSource, d.stateSinceMs, d.ask], ['working', '5', 'transcript', T - M, null]);
});
test('5: unknown status value uses the fallback; hook status feeds it', () => {
  const d = decide({ registry: { status: 'zzz', statusUpdatedAtMs: null, waitingFor: null }, hook: { status: 'waiting', sinceMs: T }, lastMs: T - M });
  assert.deepEqual([d.state, d.rule, d.stateSource], ['waiting', '5', 'hook']);
});
test('5: open call older than promptMinutes is a prompt with the call as ask.call', () => {
  const c = call('Bash', T - 2 * M);
  const d = decide({ registry: { status: null }, open: [c], lastMs: T - 2 * M });
  assert.deepEqual([d.state, d.stateSinceMs, d.ask.kind, d.ask.certain, d.ask.via, d.ask.call, d.ask.summary],
    ['prompt', T - 2 * M, 'permission', false, 'main', c, null]);
});
test('5: waiting older than 240 minutes becomes idle', () => {
  const reg = { status: null };
  const w = decide({ registry: reg, lastMs: T - 100 * M });
  assert.equal(w.state, 'waiting'); // session is known open, so the 90 min cap does not apply
  assert.equal(decide({ registry: reg, lastMs: T - 239 * M }).state, 'waiting');
  const i = decide({ registry: reg, lastMs: T - 241 * M });
  assert.deepEqual([i.state, i.stateSinceMs], ['idle', T - 241 * M]);
});
test('5: lastMs null stays null', () => {
  const d = decide({ registry: { status: null }, lastMs: null, lastType: null });
  assert.equal(d.stateSinceMs, null);
});
test('5: no transcript activity at all is idle, never a guessed working', () => {
  const d = decide({ registry: { status: null }, lastMs: null, lastType: null });
  assert.deepEqual([d.state, d.rule], ['idle', '5']);
});
test('wantsSubagents', () => {
  const hp = { status: 'prompt', sinceMs: T };
  const wait = { status: 'waiting' };
  assert.equal(wantsSubagents({ registry: wait, hook: null, open: [call('Agent', T)] }), true);
  assert.equal(wantsSubagents({ registry: wait, hook: null, open: [] }), true);
  assert.equal(wantsSubagents({ registry: wait, hook: null, open: [call('Bash', T)] }), false);
  assert.equal(wantsSubagents({ registry: { status: 'busy' }, hook: hp, open: [call('Agent', T)] }), false);
  assert.equal(wantsSubagents({ registry: { status: null }, hook: hp, open: [call('Agent', T)] }), true);
  assert.equal(wantsSubagents({ registry: { status: 'zzz' }, hook: hp, open: [] }), true);
  assert.equal(wantsSubagents({ registry: { status: null }, hook: hp, open: [call('Bash', T)] }), false);
  assert.equal(wantsSubagents({ registry: { status: null }, hook: null, open: [] }), false);
  assert.equal(wantsSubagents({ registry: { status: null }, hook: { status: 'working', sinceMs: T }, open: [call('Agent', T)] }), false);
});
