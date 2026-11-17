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

// ---------- the store ----------

const OTHER = '123e4567-e89b-42d3-a456-426614174011';
const GONE = { ok: false, status: 200, reason: 'This request is no longer open' };

/** A store with a clock the test moves, ids r1, r2, …, and everything it said or logged. */
function store(options = {}) {
  const clock = { t: 1000 };
  let n = 0;
  const logged = [];
  const s = requests.createRequests({ now: () => clock.t, newId: () => `r${++n}`, log: (e) => logged.push(e), ...options });
  const said = new Map(); // request id → what respond got
  const hold = (payload = bash) => {
    const answers = [];
    const id = s.hold(ok({ payload }).request, (decision) => answers.push(decision));
    said.set(id, answers);
    return id;
  };
  return { s, clock, logged, said, hold };
}
const snap = (state) => ({ sessions: state === null ? [] : [{ ...row, state }] });

test('hold lists the request for its session, newest first, without internals', () => {
  const { s, clock, hold } = store();
  const first = hold();
  clock.t = 1500;
  const second = hold(ask);
  assert.equal(s.size, 2);
  assert.deepEqual(s.listFor(SID), [
    { id: second, kind: 'question', via: 'main', tool: 'AskUserQuestion', detail: null, extras: [],
      questions: ok({ payload: ask }).request.questions, since: new Date(1500).toISOString() },
    { id: first, kind: 'permission', via: 'main', tool: 'Bash', detail: 'rm -rf build/tmp', extras: [], questions: null,
      since: new Date(1000).toISOString() },
  ]);
  assert.deepEqual(s.listFor(OTHER), []);
});

test('two requests of the same session and agent are both held', () => {
  const { s, said, hold } = store();
  const a = hold();
  const b = hold();
  assert.deepEqual(s.listFor(SID).map((r) => r.id), [b, a]);
  assert.deepEqual(said.get(a), []);
});

test('E1: answer sends the decision once and removes the request', () => {
  const { s, said, hold } = store();
  const id = hold();
  assert.deepEqual(s.answer(SID, id, { behavior: 'allow' }), { ok: true });
  assert.deepEqual(said.get(id), [{ behavior: 'allow' }]);
  assert.equal(s.size, 0);
  assert.deepEqual(s.answer(SID, id, { behavior: 'allow' }), GONE);
  assert.equal(said.get(id).length, 1);
});

test('answer: wrong session and bad body leave the request held', () => {
  const { s, said, hold } = store();
  const id = hold();
  assert.deepEqual(s.answer(OTHER, id, { behavior: 'allow' }), GONE);
  assert.deepEqual(s.answer(SID, 'nope', { behavior: 'allow' }), GONE);
  assert.deepEqual(s.answer(SID, id, { behavior: 'maybe' }), { ok: false, status: 400, reason: 'Unknown answer' });
  assert.equal(s.size, 1);
  assert.deepEqual(said.get(id), []);
});

test('the refusal for a request that is gone follows the language', async () => {
  const { setLanguage } = await import('../src/messages.mjs');
  const { s } = store();
  try {
    setLanguage('de');
    assert.equal(s.answer(SID, 'nope', { behavior: 'allow' }).reason, 'Diese Anfrage ist nicht mehr offen');
  } finally {
    setLanguage('en');
  }
});

test('E3: a session has to be missing for longer than the grace, whatever the reason', () => {
  const { s, clock, said, hold } = store();
  const id = hold(); // received at 1000
  clock.t = 50000;
  assert.equal(s.reconcile(snap(null)), 0); // one snapshot without it can be a torn read
  clock.t = 53000;
  assert.equal(s.reconcile(snap(null)), 0); // missing for exactly the grace
  assert.equal(s.reconcile(snap('prompt')), 0); // back again: the absence starts over
  clock.t = 56001;
  assert.equal(s.reconcile(snap(null)), 0);
  clock.t = 59001;
  assert.equal(s.reconcile(snap(null)), 0);
  clock.t = 59002;
  assert.equal(s.reconcile(snap(null)), 1);
  assert.deepEqual(said.get(id), [null]);

  // A registry that could not be read lists nobody. A short spell of that is ridden out like
  // any other absence. A long one is not: a run without a dialog must not wait for hours on a
  // daemon that cannot see whether it still asks.
  const unreadable = { sources: { registry: false }, sessions: [] };
  const kept = hold(); // at 59002
  clock.t = 60000;
  assert.equal(s.reconcile(unreadable), 0);
  clock.t = 63000;
  assert.equal(s.reconcile(unreadable), 0);
  assert.deepEqual(said.get(kept), []);
  clock.t = 63001;
  assert.equal(s.reconcile(unreadable), 1);
  assert.deepEqual(said.get(kept), [null]);
});

test('E4: reconcile ends requests whose session no longer asks', () => {
  const { s, clock, said, hold } = store();
  assert.equal(requests.GRACE_MS, 3000);
  const id = hold(); // received at 1000
  clock.t = 4000;
  assert.equal(s.reconcile(snap('working')), 0); // exactly the grace: still held
  clock.t = 4001;
  assert.equal(s.reconcile(snap('prompt')), 0); // still asking, however old
  assert.equal(s.reconcile(snap('working')), 1);
  assert.deepEqual(said.get(id), [null]);
  assert.equal(s.size, 0);

  const patient = hold();
  clock.t = 999999;
  assert.equal(s.reconcile(snap('prompt')), 0);
  assert.deepEqual(said.get(patient), []);
});

test('E4 goes by the registry status when the row has one', () => {
  const { s, clock, said, hold } = store();
  const rows = (state, registryStatus) => ({ sessions: [{ ...row, state, registryStatus }] });
  // A run without a dialog asked a question: its transcript makes the row "prompt", but the
  // registry never said "waiting". Nobody can answer it anywhere else, so it must not be kept.
  const lost = hold(ask);
  clock.t = 4000;
  assert.equal(s.reconcile(rows('prompt', 'busy')), 0); // within the grace
  clock.t = 4001;
  assert.equal(s.reconcile(rows('prompt', 'busy')), 1);
  assert.deepEqual(said.get(lost), [null]);

  const open = hold(ask);
  clock.t = 999999;
  assert.equal(s.reconcile(rows('prompt', 'waiting')), 0);
  assert.equal(s.reconcile(rows('working', 'waiting')), 0); // the registry outranks the derived state
  // No status in the registry (an older Claude Code): the derived state decides, as before.
  assert.equal(s.reconcile(rows('prompt', null)), 0);
  assert.deepEqual(said.get(open), []);
  assert.equal(s.reconcile(rows('working', null)), 1);
});

test('reconcile takes its grace from the options', () => {
  const { s, clock, hold } = store({ graceMs: 100 });
  hold();
  clock.t = 1100;
  assert.equal(s.reconcile(snap('waiting')), 0);
  clock.t = 1101;
  assert.equal(s.reconcile(snap('waiting')), 1);
});

test('E5/E7 endAll and E6 drop', () => {
  const { s, said, hold } = store();
  const a = hold();
  const b = hold(ask);
  assert.equal(s.endAll('E5'), 2);
  assert.deepEqual([said.get(a), said.get(b)], [[null], [null]]);
  assert.equal(s.size, 0);
  assert.equal(s.endAll('E7'), 0);

  const c = hold();
  s.drop(c);
  s.drop('nope');
  assert.equal(s.size, 0);
  assert.deepEqual(said.get(c), []); // dropped: Claude Code closed the call, nobody to tell
});

test('a respond that throws does not keep the request or stop the others', () => {
  const s = requests.createRequests({ now: () => 0, newId: (() => { let n = 0; return () => `r${++n}`; })() });
  const answers = [];
  s.hold(ok().request, () => { throw new Error('socket gone'); });
  s.hold(ok().request, (d) => answers.push(d));
  assert.equal(s.endAll('E7'), 2);
  assert.equal(s.size, 0);
  assert.deepEqual(answers, [null]);
});

test('every ending is logged without any text of the request', () => {
  const { s, clock, logged, hold } = store();
  const session = SID.slice(0, 8);
  const a = hold();
  clock.t = 1500;
  s.answer(SID, a, { behavior: 'allow' });
  const b = hold();
  s.answer(SID, b, { behavior: 'deny' });
  const c = hold(ask);
  clock.t = 2500;
  s.answer(SID, c, { behavior: 'allow', choices: [[0], [1]] });
  hold(); // at 2500; its session then goes missing for longer than the grace
  s.reconcile(snap(null));
  clock.t = 5501;
  s.reconcile(snap(null));
  hold();
  clock.t = 9000;
  s.reconcile(snap('working'));
  hold();
  s.endAll('E5');
  hold();
  s.endAll('E7');
  s.drop(hold());
  assert.deepEqual(logged, [
    { ending: 'E1', behavior: 'allow', tool: 'Bash', heldMs: 500, session },
    { ending: 'E1', behavior: 'deny', tool: 'Bash', heldMs: 0, session },
    { ending: 'E1', behavior: 'allow', tool: 'AskUserQuestion', heldMs: 1000, session },
    { ending: 'E3', behavior: null, tool: 'Bash', heldMs: 3001, session },
    { ending: 'E4', behavior: null, tool: 'Bash', heldMs: 3499, session },
    { ending: 'E5', behavior: null, tool: 'Bash', heldMs: 0, session },
    { ending: 'E7', behavior: null, tool: 'Bash', heldMs: 0, session },
    { ending: 'E6', behavior: null, tool: 'Bash', heldMs: 0, session },
  ]);
  assert.equal(JSON.stringify(logged).includes('rm -rf'), false);
});
