// The page's logic for answering a held permission request: no DOM here.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as answerLogic from '../public/modules/answer.mjs';
import * as api from '../public/modules/api.mjs';
import { TABLES } from '../public/strings.mjs';

const { requestsOf, toggleChoice, choicesComplete, layoutSignature } = answerLogic;

// One single-choice and one multiple-choice question with three options each.
const qs = [{ multiSelect: false, options: [{}, {}, {}] }, { multiSelect: true, options: [{}, {}, {}] }];

test('requestsOf: a row without requests has none', () => {
  // An older daemon and every older fixture send rows without the key.
  assert.deepEqual(requestsOf({}), []);
  assert.deepEqual(requestsOf({ requests: null }), []);
  assert.deepEqual(requestsOf({ requests: 'x' }), []);
  assert.deepEqual(requestsOf(undefined), []);
  assert.deepEqual(requestsOf({ requests: [{ id: 'r1' }] }), [{ id: 'r1' }]);
});

test('toggleChoice: single choice replaces, multiple choice toggles and stays sorted', () => {
  assert.deepEqual(toggleChoice(qs, undefined, 0, 2), [[2], []]);
  assert.deepEqual(toggleChoice(qs, [[2], []], 0, 1), [[1], []]);
  assert.deepEqual(toggleChoice(qs, [[1], []], 0, 1), [[1], []]);
  assert.deepEqual(toggleChoice(qs, [[1], [2]], 1, 0), [[1], [0, 2]]);
  assert.deepEqual(toggleChoice(qs, [[1], [0, 2]], 1, 2), [[1], [0]]);
});

test('toggleChoice gives back a new array and leaves the old one alone', () => {
  const before = [[1], [2]];
  const after = toggleChoice(qs, before, 1, 0);
  assert.deepEqual(before, [[1], [2]]);
  assert.notEqual(after, before);
  assert.notEqual(after[1], before[1]);
});

test('choicesComplete: every question needs its selection', () => {
  assert.equal(choicesComplete(qs, undefined), false);
  assert.equal(choicesComplete(qs, [[1], []]), false);
  assert.equal(choicesComplete(qs, [[], [0]]), false);
  assert.equal(choicesComplete(qs, [[1]]), false);
  assert.equal(choicesComplete(qs, [[1], [0, 2]]), true);
  assert.equal(choicesComplete(qs, [[1], [2]]), true);
});

test('layoutSignature changes with view, height, blocks and their positions', () => {
  assert.equal(answerLogic.ARM_MS, 500);
  const base = { view: 'list', height: 400, blocks: [{ id: 'r1', top: 80 }] };
  const sig = layoutSignature(base);
  assert.equal(typeof sig, 'string');
  assert.equal(layoutSignature({ ...base, blocks: [{ id: 'r1', top: 80 }] }), sig);
  for (const other of [{ ...base, view: 'detail' }, { ...base, height: 430 }, { ...base, blocks: [] },
    { ...base, blocks: [{ id: 'r1', top: 120 }] }, { ...base, blocks: [{ id: 'r2', top: 80 }] },
    { ...base, blocks: [{ id: 'r1', top: 80 }, { id: 'r2', top: 200 }] }]) {
    assert.notEqual(layoutSignature(other), sig, JSON.stringify(other));
  }
  const two = { ...base, blocks: [{ id: 'r1', top: 80 }, { id: 'r2', top: 200 }] };
  assert.notEqual(layoutSignature({ ...two, blocks: [...two.blocks].reverse() }), layoutSignature(two));
});

test('answer() posts the click as JSON and gives back what the daemon says', async () => {
  const real = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init });
      return { json: async () => ({ ok: false, reason: 'This request is no longer open' }) };
    };
    const body = { requestId: 'r1', behavior: 'allow', choices: [[1], [0, 2]] };
    assert.deepEqual(await api.answer('123e4567-e89b-42d3-a456-426614174010', body), { ok: false, reason: 'This request is no longer open' });
    assert.equal(calls[0].url, '/api/sessions/123e4567-e89b-42d3-a456-426614174010/answer');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].init.body), body);

    globalThis.fetch = async () => { throw new Error('connection refused'); };
    assert.deepEqual(await api.answer('x', body), { ok: false, reason: 'Daemon not reachable' });
    globalThis.fetch = async () => ({ json: async () => 'nonsense' });
    assert.deepEqual(await api.answer('x', body), { ok: false, reason: 'Daemon not reachable' });
  } finally {
    globalThis.fetch = real;
  }
});

test('the answer buttons and the setting have their words in both languages', () => {
  const pick = (t) => [t.allow, t.deny, t.send, t.answerInWidget, t.answerInWidgetHint];
  assert.deepEqual(pick(TABLES.en), ['Allow', 'Deny', 'Send', 'Answer in the widget',
    'Answer permission prompts and questions right here. The dialog in VS Code keeps working.']);
  assert.deepEqual(pick(TABLES.de), ['Erlauben', 'Ablehnen', 'Senden', 'Im Widget antworten',
    'Freigaben und Fragen direkt hier beantworten. Der Dialog in VS Code bleibt nutzbar.']);
});
