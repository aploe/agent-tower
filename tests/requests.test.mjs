import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as requests from '../src/requests.mjs';

const { eligibility, decisionFor, DENY } = requests;

const SID = '123e4567-e89b-42d3-a456-426614174010';
const row = { id: SID, host: 'wsl', entrypoint: 'claude-vscode', state: 'prompt' };
const bash = { hook_event_name: 'PermissionRequest', session_id: SID, tool_name: 'Bash', tool_input: { command: 'rm -rf build/tmp' } };
const ask = { ...bash, tool_name: 'AskUserQuestion', tool_input: { questions: [
  { question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] },
  { question: 'Which sides?', header: 'Sides', multiSelect: true, options: [{ label: 'Rice' }, { label: 'Pasta' }, { label: 'Salad' }] }] } };
const ok = (over = {}) => eligibility({ payload: bash, session: row, enabled: true, heldCount: 0, ...over });

test('eligibility: a Bash request of a VS Code session in WSL is held', () => {
  assert.deepEqual(ok(), { hold: true, request: { sessionId: SID, agentId: null, kind: 'permission', via: 'main', tool: 'Bash',
    detail: 'rm -rf build/tmp', extras: [], questions: null, toolInput: null } });
  const sub = ok({ payload: { ...bash, agent_id: 'a1' } }).request;
  assert.equal(sub.agentId, 'a1');
  assert.equal(sub.via, 'subagent');
});

test('eligibility: a question keeps its input for the answer', () => {
  const r = ok({ payload: ask }).request;
  assert.equal(r.kind, 'question');
  assert.equal(r.detail, null);
  assert.deepEqual(r.extras, []);
  assert.equal(r.questions.length, 2);
  assert.deepEqual(r.toolInput, ask.tool_input);
});

test('eligibility: every reason not to hold', () => {
  const why = (over) => ok(over).why;
  assert.equal(why({ enabled: false }), 'off');
  for (const payload of [null, [], { ...bash, hook_event_name: 'PreToolUse' }, { ...bash, session_id: 'x' }, { ...bash, tool_name: 7 }, { ...bash, tool_input: 'x' }]) {
    assert.equal(why({ payload }), 'payload');
  }
  for (const session of [null, { ...row, host: 'windows' }, { ...row, entrypoint: 'cli' }]) assert.equal(why({ session }), 'session');
  assert.equal(why({ payload: { ...bash, tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } } }), 'plan');
  assert.equal(why({ payload: { ...ask, tool_input: { questions: [] } } }), 'questions');
  assert.equal(why({ payload: { ...bash, tool_input: { command: 'x'.repeat(4001) } } }), 'detail');
  assert.equal(requests.MAX_HELD, 50);
  assert.equal(why({ heldCount: 49 }), undefined);
  assert.equal(why({ heldCount: 50 }), 'full');
});

test('decisionFor: allow and deny a permission', () => {
  const r = ok().request;
  assert.deepEqual(DENY, { behavior: 'deny', message: 'Denied by the user in the Agent Tower widget.', interrupt: true });
  assert.deepEqual(decisionFor(r, { behavior: 'allow' }), { ok: true, decision: { behavior: 'allow' } });
  assert.deepEqual(decisionFor(r, { behavior: 'deny' }), { ok: true, decision: DENY });
  assert.deepEqual(decisionFor(r, { behavior: 'maybe' }), { ok: false, reason: 'Unknown answer' });
  assert.deepEqual(decisionFor(r, null), { ok: false, reason: 'Unknown answer' });
  assert.deepEqual(decisionFor(r, { behavior: 'allow', choices: [[0]] }), { ok: false, reason: 'Choices do not belong to a permission request' });
});

test('decisionFor: a question is answered with its own labels, joined with ", " in option order', () => {
  const r = ok({ payload: ask }).request;
  assert.deepEqual(decisionFor(r, { behavior: 'allow', choices: [[1], [2, 0]] }), { ok: true, decision: { behavior: 'allow',
    updatedInput: { ...ask.tool_input, answers: { 'Which colour?': 'Green', 'Which sides?': 'Rice, Salad' } } } });
  assert.deepEqual(decisionFor(r, { behavior: 'deny' }), { ok: false, reason: 'A question can only be answered here' });
  for (const choices of [undefined, [[1]], [[1], []], [[0, 1], [0]], [[3], [0]], [[-1], [0]], [[1], [0, 0]], [[1.5], [0]], ['1', [0]], [[1], [0], [0]]]) {
    assert.deepEqual(decisionFor(r, { behavior: 'allow', choices }), { ok: false, reason: 'Choices incomplete or invalid' });
  }
});
