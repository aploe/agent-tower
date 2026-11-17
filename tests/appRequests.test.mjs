// The hook endpoint and what the app does with held permission requests. All sessions, commands
// and questions here are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { UUID } from '../src/vscode.mjs';

const S1 = '123e4567-e89b-42d3-a456-426614174010'; // VS Code in WSL
const S2 = '123e4567-e89b-42d3-a456-426614174011'; // VS Code on Windows
const S3 = '123e4567-e89b-42d3-a456-426614174012'; // terminal CLI in WSL
const NOBODY = '123e4567-e89b-42d3-a456-426614174999';
const KIND = {
  [S1]: { host: 'wsl', entrypoint: 'claude-vscode', opensIn: 'vscode' },
  [S2]: { host: 'windows', entrypoint: 'claude-vscode', opensIn: 'vscode' },
  [S3]: { host: 'wsl', entrypoint: 'cli', opensIn: null },
};
const NO_DECISION = { status: 200, type: null, text: '' };

const bash = (id = S1, command = 'rm -rf build/tmp') =>
  ({ hook_event_name: 'PermissionRequest', session_id: id, tool_name: 'Bash', tool_input: { command } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The daemon's log lines with the seconds blanked: how long a request was held depends on
 *  how busy the machine is. */
const logged = (t) => t.lines.map((line) => line.replace(/after \d+ s/, 'after N s'));
/** 'pending' when the promise has not settled after ms, else its value. */
const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => 'pending')]);
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(10);
  }
}

/**
 * An app whose collect lists S1 to S3 with the states in `states`: change a value to change a
 * session's state, delete a key to end the session. `collect(snapshot)` replaces the stub.
 */
async function start({ cfgOverrides = {}, collect } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-requests-'));
  const cfg = { host: '127.0.0.1', port: 0, pollMs: 30, stateDir: path.join(root, 'state'), idleAfterMinutes: 240, answerInWidget: true, ...cfgOverrides };
  const states = { [S1]: 'prompt', [S2]: 'prompt', [S3]: 'prompt' };
  const registry = {}; // id → the registry status its row carries; a session without an entry has none
  const snapshot = () => ({
    generatedAt: new Date().toISOString(),
    sources: {},
    counts: {},
    sessions: Object.keys(states).map((id) => ({
      id, state: states[id], ...KIND[id], canOpen: KIND[id].opensIn !== null, dismissed: false, cwd: '/work/alpha',
      ...(id in registry ? { registryStatus: registry[id] } : {}),
    })),
  });
  const lines = [];
  const server = createApp(cfg, {
    collect: collect ? async () => collect(snapshot) : async () => snapshot(),
    stepsFor: async () => ({ steps: [], terminal: null }),
    graceMs: 80,
    log: (line) => lines.push(line),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  /** A hook call as Claude Code sends it: JSON, no Origin. Resolves when the daemon answers;
   *  `.request` is the client request (a test destroys it to play a closed connection). */
  function hook(payload, { headers = { 'content-type': 'application/json' }, raw } = {}) {
    const body = raw ?? JSON.stringify(payload);
    let request;
    const answered = new Promise((resolve, reject) => {
      request = http.request({
        host: '127.0.0.1', port, path: '/api/hook/permission-request', method: 'POST',
        headers: { ...headers, 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] ?? null, text }));
      });
      request.on('error', reject);
      request.end(body);
    });
    answered.catch(() => {}); // a call that is still held when the app stops ends with a reset
    answered.request = request;
    return answered;
  }
  const state = async () => (await fetch(`${base}/api/state`)).json();
  const rowOf = async (id) => (await state()).sessions.find((s) => s.id === id);
  /** Resolves with the row once it lists n requests. */
  const held = (n, id = S1) => until(async () => {
    const row = await rowOf(id);
    return row?.requests?.length === n ? row : null;
  });
  /** A POST as the page sends it: JSON with the daemon's own origin. `origin: null` leaves the
   *  header out, `raw` replaces the JSON text. */
  const post = (p, body, { origin = base, raw } = {}) => fetch(base + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: raw ?? JSON.stringify(body),
  });
  const stop = async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(root, { recursive: true, force: true });
  };
  return { cfg, base, port, states, registry, lines, hook, state, rowOf, held, post, server, stop };
}

test('an eligible request is held and shows on its row', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    assert.equal(await within(call, 100), 'pending');
    const [r, ...more] = (await t.rowOf(S1)).requests;
    assert.deepEqual(more, []);
    assert.match(r.id, UUID);
    assert.equal(new Date(r.since).toISOString(), r.since);
    assert.deepEqual({ ...r, id: null, since: null },
      { id: null, kind: 'permission', via: 'main', tool: 'Bash', detail: 'rm -rf build/tmp', extras: [], questions: null, since: null });
    assert.deepEqual((await t.rowOf(S2)).requests, []);
    assert.deepEqual((await t.rowOf(S3)).requests, []);
  } finally { await t.stop(); }
});

test('requests that are not held get status 200 and an empty body at once', async () => {
  const t = await start();
  try {
    const calls = {
      'a Windows session': t.hook(bash(S2)),
      'a terminal session': t.hook(bash(S3)),
      'an unknown session': t.hook(bash(NOBODY)),
      'a plan approval': t.hook({ ...bash(), tool_name: 'ExitPlanMode', tool_input: { plan: 'Step one' } }),
      'a body that is not JSON': t.hook(null, { raw: '{nope' }),
      'a body over 1 MiB': t.hook({ ...bash(), pad: 'x'.repeat(1024 * 1024) }),
    };
    for (const [name, call] of Object.entries(calls)) assert.deepEqual(await within(call, 1000), NO_DECISION, name);
    assert.deepEqual((await t.rowOf(S1)).requests, []);
  } finally { await t.stop(); }
});

test('with the setting off nothing is held', async () => {
  const t = await start({ cfgOverrides: { answerInWidget: false } });
  try {
    assert.deepEqual(await within(t.hook(bash()), 1000), NO_DECISION);
    assert.deepEqual((await t.rowOf(S1)).requests, []);
  } finally { await t.stop(); }
});

test('hook guard: a call with an Origin is 403, a call that is not JSON is 415; neither is held', async () => {
  const t = await start();
  try {
    const browser = await within(t.hook(bash(), { headers: { 'content-type': 'application/json', origin: t.base } }), 1000);
    assert.equal(browser.status, 403);
    const plain = await within(t.hook(bash(), { headers: { 'content-type': 'text/plain' } }), 1000);
    assert.equal(plain.status, 415);
    assert.deepEqual((await t.rowOf(S1)).requests, []);
  } finally { await t.stop(); }
});

test('E4: the request is released when the session no longer asks', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    await t.held(1);
    t.states[S1] = 'working'; // the user answered in the VS Code dialog
    assert.deepEqual(await within(call, 2000), NO_DECISION);
    assert.deepEqual((await t.rowOf(S1)).requests, []);
  } finally { await t.stop(); }
});

test('a question of a run that shows no dialog is handed back, although its row says prompt', async () => {
  const t = await start();
  try {
    // A headless run asks a question: its transcript makes the row "prompt" for good, but the
    // registry stays busy because no dialog opens. Held for ever, the run would never go on.
    t.registry[S1] = 'busy';
    const question = { hook_event_name: 'PermissionRequest', session_id: S1, tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Where to?', options: [{ label: 'A' }, { label: 'B' }] }] } };
    assert.deepEqual(await within(t.hook(question), 2000), NO_DECISION);
    assert.deepEqual((await t.rowOf(S1)).requests, []);
    assert.deepEqual(logged(t), ['request: AskUserQuestion E4 after N s (session 123e4567)']);
  } finally { await t.stop(); }
});

test('a request stays held while the registry says its session waits for the user', async () => {
  const t = await start();
  try {
    t.registry[S1] = 'waiting';
    const call = t.hook(bash());
    await t.held(1);
    assert.equal(await within(call, 400), 'pending');
  } finally { await t.stop(); }
});

test('a request stays held while its session asks, long after the grace', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    await t.held(1);
    assert.equal(await within(call, 400), 'pending'); // grace 80 ms, poll 30 ms
    assert.equal((await t.rowOf(S1)).requests.length, 1);
  } finally { await t.stop(); }
});

test('E3: the request is released when the session is gone', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    await t.held(1);
    delete t.states[S1];
    assert.deepEqual(await within(call, 2000), NO_DECISION);
  } finally { await t.stop(); }
});

test('E6: the request is dropped when Claude Code closes the connection', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    await t.held(1);
    call.request.destroy();
    await t.held(0);
  } finally { await t.stop(); }
});

test('E5: switching the setting off releases everything and holds nothing new', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    await t.held(1);
    assert.equal((await t.post('/api/settings', { answerInWidget: false })).status, 200);
    assert.deepEqual(await within(call, 1000), NO_DECISION);
    assert.deepEqual(await within(t.hook(bash()), 1000), NO_DECISION);
    assert.deepEqual((await t.rowOf(S1)).requests, []);
    // One line per ended request, and nothing of the command in it.
    assert.deepEqual(logged(t), ['request: Bash E5 after N s (session 123e4567)']);
    assert.equal(t.lines.some((l) => l.includes('rm -rf')), false);
  } finally { await t.stop(); }
});

test('a call that Claude Code closes while the daemon still looks up its session is not held', async () => {
  // No fixed waits: the lookup hangs in a collect that the test lets go on, so the order
  // "looking up, closed, lookup done" does not depend on how busy the machine is.
  let gate = null; // while set, collect waits for it
  let collects = 0;
  const t = await start({
    collect: async (snapshot) => {
      collects++;
      if (gate) await gate.promise;
      return snapshot();
    },
  });
  try {
    await t.state();
    await sleep(60); // past pollMs: the lookup has to collect again
    let open;
    gate = { promise: new Promise((resolve) => { open = resolve; }) };
    const before = collects;
    const call = t.hook(bash());
    await until(() => collects > before); // the daemon is looking the session up
    call.request.destroy(); // Claude Code gives up meanwhile
    // One round trip to the daemon: by the time it has answered, it has seen the closed call too.
    await fetch(`${t.base}/api/health`);
    await sleep(20);
    gate = null;
    open();
    await sleep(50);
    // Nobody waits for an answer any more: no buttons for it, and nothing to log.
    assert.deepEqual((await t.rowOf(S1)).requests, []);
    assert.deepEqual(t.lines, []);
  } finally { await t.stop(); }
});

test('E7: endHeldRequests answers every held call with no decision', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    await t.held(1);
    t.server.endHeldRequests();
    assert.deepEqual(await within(call, 1000), NO_DECISION);
  } finally { await t.stop(); }
});

test('shutdown answers held calls with no decision before it closes the connections', async () => {
  const t = await start();
  try {
    const call = t.hook(bash());
    await t.held(1);
    await new Promise((done) => t.server.shutdown(done));
    assert.equal(t.server.listening, false);
    assert.deepEqual(await within(call, 1000), NO_DECISION); // an answer, not a reset
  } finally {
    if (t.server.listening) await t.stop(); // the shutdown did not happen: do not leave it open
    else await fs.rm(path.dirname(t.cfg.stateDir), { recursive: true, force: true });
  }
});

test('two requests of one session are both held, the newest first', async () => {
  const t = await start();
  try {
    const one = t.hook(bash(S1, 'echo one'));
    await t.held(1);
    const two = t.hook(bash(S1, 'echo two'));
    const row = await t.held(2);
    assert.deepEqual(row.requests.map((r) => r.detail), ['echo two', 'echo one']);
    assert.equal(await within(Promise.race([one, two]), 100), 'pending');
  } finally { await t.stop(); }
});

test('an internal error still answers with no decision', async () => {
  let broken = false;
  const t = await start({ collect: (snapshot) => { if (broken) throw new Error('collect failed'); return snapshot(); } });
  try {
    await t.state();
    broken = true;
    await sleep(60); // past pollMs: the cached snapshot is too old, every lookup collects
    assert.deepEqual(await within(t.hook(bash(NOBODY)), 1000), NO_DECISION);
    assert.deepEqual(await within(t.hook(bash()), 1000), NO_DECISION);
    assert.deepEqual(t.lines, ['hook call passed through: collect failed', 'hook call passed through: collect failed']);
    broken = false;
    assert.equal((await fetch(`${t.base}/api/health`)).status, 200);
    assert.deepEqual((await t.rowOf(S1)).requests, []);
  } finally { await t.stop(); }
});

test('the event stream shows a held request by itself', async () => {
  const t = await start();
  const abort = new AbortController();
  try {
    const res = await fetch(`${t.base}/api/events`, { signal: abort.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    t.hook(bash());
    let seen = '';
    const text = await within((async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return seen;
        seen += decoder.decode(value, { stream: true });
        if (seen.includes('"detail":"rm -rf build/tmp"')) return seen;
      }
    })(), 2000);
    assert.notEqual(text, 'pending');
  } finally {
    abort.abort();
    await t.stop();
  }
});

// ---------- answering ----------

const QUESTIONS = { questions: [
  { question: 'Which colour?', header: 'Colour', multiSelect: false, options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] },
  { question: 'Which sides?', header: 'Sides', multiSelect: true, options: [{ label: 'Rice' }, { label: 'Pasta' }, { label: 'Salad' }] },
] };
const ask = () => ({ hook_event_name: 'PermissionRequest', session_id: S1, tool_name: 'AskUserQuestion', tool_input: QUESTIONS });
const answerPath = (id = S1) => `/api/sessions/${id}/answer`;
const decisionIn = (answer) => JSON.parse(answer.text).hookSpecificOutput.decision;
const GONE = { ok: false, reason: 'This request is no longer open' };

/** Holds one call and gives back the call and the id its row shows. */
async function holdOne(t, payload = bash()) {
  const call = t.hook(payload);
  const [{ id }] = (await t.held(1)).requests;
  return { call, id };
}

test('allow answers the held hook call byte for byte', async () => {
  const t = await start();
  try {
    const { call, id } = await holdOne(t);
    const res = await t.post(answerPath(), { requestId: id, behavior: 'allow' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(await within(call, 1000), {
      status: 200,
      type: 'application/json',
      text: '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}',
    });
    assert.deepEqual((await t.rowOf(S1)).requests, []);
    assert.deepEqual(logged(t), ['request: Bash E1 allow after N s (session 123e4567)']);
  } finally { await t.stop(); }
});

test('deny sends the deny decision', async () => {
  const t = await start();
  try {
    const { DENY } = await import('../src/requests.mjs');
    const { call, id } = await holdOne(t);
    assert.deepEqual(await (await t.post(answerPath(), { requestId: id, behavior: 'deny' })).json(), { ok: true });
    assert.deepEqual(decisionIn(await within(call, 1000)), DENY);
  } finally { await t.stop(); }
});

test('a question is answered with the chosen labels', async () => {
  const t = await start();
  try {
    const { call, id } = await holdOne(t, ask());
    assert.deepEqual(await (await t.post(answerPath(), { requestId: id, behavior: 'allow', choices: [[1], [0, 2]] })).json(), { ok: true });
    assert.deepEqual(decisionIn(await within(call, 1000)), {
      behavior: 'allow',
      updatedInput: { ...QUESTIONS, answers: { 'Which colour?': 'Green', 'Which sides?': 'Rice, Salad' } },
    });
  } finally { await t.stop(); }
});

test('a second answer to the same request is refused and nothing is sent twice', async () => {
  const t = await start();
  try {
    const { call, id } = await holdOne(t);
    await t.post(answerPath(), { requestId: id, behavior: 'allow' });
    const again = await t.post(answerPath(), { requestId: id, behavior: 'deny' }); // a second page
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), GONE);
    assert.equal(decisionIn(await within(call, 1000)).behavior, 'allow');
    assert.equal(t.lines.length, 1);
  } finally { await t.stop(); }
});

test('refusals keep the request held', async () => {
  const t = await start();
  try {
    const { call, id } = await holdOne(t, ask());
    const bad = await t.post(answerPath(), { requestId: id, behavior: 'allow', choices: [[9], [0]] });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { ok: false, reason: 'Choices incomplete or invalid' });
    const elsewhere = await t.post(answerPath(S2), { requestId: id, behavior: 'allow', choices: [[1], [0]] });
    assert.equal(elsewhere.status, 200);
    assert.deepEqual(await elsewhere.json(), GONE);
    for (const body of [{}, { requestId: 7 }, null]) {
      assert.deepEqual(await (await t.post(answerPath(), body)).json(), GONE, JSON.stringify(body));
    }
    assert.equal(await within(call, 100), 'pending');
    assert.equal((await t.rowOf(S1)).requests.length, 1);
  } finally { await t.stop(); }
});

test('answer guards: origin, session, body size, JSON', async () => {
  const t = await start();
  try {
    const { call, id } = await holdOne(t);
    const good = { requestId: id, behavior: 'allow' };
    assert.equal((await t.post(answerPath(), good, { origin: null })).status, 403);
    assert.equal((await t.post(answerPath(), good, { origin: 'http://evil.example' })).status, 403);
    const unknown = await t.post(answerPath(NOBODY), good);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { ok: false, reason: 'Unknown session' });
    const big = await t.post(answerPath(), { ...good, pad: 'x'.repeat(5000) });
    assert.equal(big.status, 413);
    assert.deepEqual(await big.json(), { ok: false, reason: 'Request too large' });
    const broken = await t.post(answerPath(), null, { raw: '{nope' });
    assert.equal(broken.status, 400);
    assert.deepEqual(await broken.json(), { ok: false, reason: 'Not valid JSON' });
    assert.equal(await within(call, 100), 'pending'); // none of them answered it
  } finally { await t.stop(); }
});

test('the session ended while the page still showed the buttons', async () => {
  const t = await start();
  try {
    const { call, id } = await holdOne(t);
    delete t.states[S1];
    assert.deepEqual(await within(call, 2000), NO_DECISION);
    const late = await t.post(answerPath(), { requestId: id, behavior: 'allow' });
    assert.equal(late.status, 404);
    assert.deepEqual(await late.json(), { ok: false, reason: 'Unknown session' });
    assert.equal((await fetch(`${t.base}/api/health`)).status, 200);
  } finally { await t.stop(); }
});
