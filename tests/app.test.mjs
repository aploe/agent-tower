import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { loadDismissed } from '../src/dismissed.mjs';

const A = '123e4567-e89b-42d3-a456-426614174000';
const B = '123e4567-e89b-42d3-a456-426614174001';
const C = '123e4567-e89b-42d3-a456-426614174099';
const D = '123e4567-e89b-42d3-a456-426614174002'; // a desktop-app session on Windows

function snapshot(dismissedIds = []) {
  const sessions = [
    { id: A, cwd: '/work/alpha', state: 'waiting', host: 'wsl', opensIn: 'vscode', hostSessionId: null, canOpen: true, dismissed: dismissedIds.includes(A) },
    { id: B, cwd: '/work/beta', state: 'working', host: 'wsl', opensIn: null, hostSessionId: null, canOpen: false, dismissed: dismissedIds.includes(B) },
    { id: D, cwd: 'C:\\Users\\sam\\notes', state: 'waiting', host: 'windows', opensIn: 'desktop', hostSessionId: 'local_c1', canOpen: true, dismissed: dismissedIds.includes(D) },
  ];
  return { generatedAt: new Date().toISOString(), sources: {}, counts: { total: 2 }, sessions };
}

async function start(extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-app-'));
  const cfg = { host: '127.0.0.1', port: 0, pollMs: 50, stateDir: path.join(root, 'state'), wslDistro: 'Ubuntu', idleAfterMinutes: 240, ...extra.cfgOverrides };
  const calls = { open: [], desktop: [], registry: 0, collect: 0, idle: [] };
  const deps = {
    // like the real collect: the hidden-rows file decides `dismissed`
    collect: async (c) => {
      calls.collect++;
      calls.idle.push(c.idleAfterMinutes);
      return snapshot((await loadDismissed(c)).map((e) => e.sessionId));
    },
    stepsFor: async () => ({ steps: [], terminal: null }),
    loadRegistry: async () => { calls.registry++; return { live: new Map(), knownCwds: ['/work/alpha', '/work/beta'] }; },
    openSession: async (args) => { calls.open.push(args); return { window: 1, title: 't' }; },
    openDesktop: async (args) => { calls.desktop.push(args); return { url: 'x' }; },
    ...extra,
  };
  const server = createApp(cfg, deps);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const stop = async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await fs.rm(root, { recursive: true, force: true });
  };
  const post = (p, { origin = base, type = 'application/json', body = '{}' } = {}) => {
    const headers = { 'content-type': type };
    if (origin) headers.origin = origin;
    return fetch(base + p, { method: 'POST', headers, body });
  };
  return { cfg, calls, base, port, post, stop };
}

test('GET /api/health names the app', async () => {
  const t = await start();
  try {
    const body = await (await fetch(`${t.base}/api/health`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.name, 'agent-tower');
    assert.equal(body.pid, process.pid);
    assert.equal(typeof body.version, 'string');
  } finally { await t.stop(); }
});

test('GET /api/state returns what collect returned', async () => {
  const t = await start();
  try {
    const body = await (await fetch(`${t.base}/api/state`)).json();
    assert.deepEqual(body.sessions.map((s) => s.id), [A, B, D]);
    await fetch(`${t.base}/api/state`);
    assert.equal(t.calls.collect, 1, 'second call inside pollMs comes from the cache');
  } finally { await t.stop(); }
});

test('GET /api/events sends the snapshot as the first event', async () => {
  const t = await start();
  const ctl = new AbortController();
  try {
    const res = await fetch(`${t.base}/api/events`, { signal: ctl.signal });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /^event: state\ndata: /);
    const data = JSON.parse(text.split('data: ')[1]);
    assert.equal(data.sessions.length, 3);
  } finally { ctl.abort(); await t.stop(); }
});

test('GET /api/events sends a second event only when the snapshot changed', async () => {
  const t = await start();
  const ctl = new AbortController();
  try {
    const res = await fetch(`${t.base}/api/events`, { signal: ctl.signal });
    const reader = res.body.getReader();
    let seen = '';
    const readUntil = async (n) => {
      const dec = new TextDecoder();
      while ((seen.match(/event: state/g) ?? []).length < n) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += dec.decode(value);
      }
    };
    await readUntil(1);
    await new Promise((r) => setTimeout(r, 300)); // several polls, only generatedAt differs
    assert.equal((seen.match(/event: state/g) ?? []).length, 1);
    assert.equal((await t.post(`/api/sessions/${A}/dismiss`)).status, 200);
    await readUntil(2);
    assert.equal((seen.match(/event: state/g) ?? []).length, 2);
  } finally { ctl.abort(); await t.stop(); }
});

test('GET /api/events sends a heartbeat the page can see (a named event, not a comment)', async () => {
  const t = await start({ pingMs: 20 });
  const ctl = new AbortController();
  try {
    const res = await fetch(`${t.base}/api/events`, { signal: ctl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let seen = '';
    while (!seen.includes('event: ping\ndata: 1\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += dec.decode(value);
    }
    assert.match(seen, /event: ping\ndata: 1\n\n/);
  } finally { ctl.abort(); await t.stop(); }
});

test('POST dismiss without origin is 403 and changes nothing', async () => {
  const t = await start();
  try {
    const res = await t.post(`/api/sessions/${A}/dismiss`, { origin: null });
    assert.equal(res.status, 403);
    assert.deepEqual(await loadDismissed(t.cfg), []);
  } finally { await t.stop(); }
});

test('POST guards: wrong content type 415, unknown id 404, bad id 400', async () => {
  const t = await start();
  try {
    assert.equal((await t.post(`/api/sessions/${A}/dismiss`, { type: 'text/plain' })).status, 415);
    assert.equal((await t.post(`/api/sessions/${C}/dismiss`)).status, 404);
    assert.equal((await t.post('/api/sessions/nope/dismiss')).status, 400);
    assert.deepEqual(await loadDismissed(t.cfg), []);
  } finally { await t.stop(); }
});

test('POST dismiss, then the state shows dismissed true; restore undoes it', async () => {
  const t = await start();
  try {
    const fresh = await (await t.post(`/api/sessions/${A}/dismiss`)).json();
    assert.equal(fresh.sessions.find((s) => s.id === A).dismissed, true);
    assert.equal(fresh.sessions.find((s) => s.id === B).dismissed, false);
    assert.deepEqual(await loadDismissed(t.cfg), [{ sessionId: A, group: 'finished' }]);
    const viaState = await (await fetch(`${t.base}/api/state`)).json();
    assert.equal(viaState.sessions.find((s) => s.id === A).dismissed, true);

    const back = await (await t.post(`/api/sessions/${A}/restore`)).json();
    assert.equal(back.sessions.find((s) => s.id === A).dismissed, false);
    assert.deepEqual(await loadDismissed(t.cfg), []);
  } finally { await t.stop(); }
});

test('POST dismiss twice keeps one entry, with the current group', async () => {
  const t = await start();
  try {
    await t.post(`/api/sessions/${B}/dismiss`);
    await t.post(`/api/sessions/${B}/dismiss`);
    assert.deepEqual(await loadDismissed(t.cfg), [{ sessionId: B, group: 'working' }]);
  } finally { await t.stop(); }
});

test('POST open passes cwd from the snapshot, never from the body', async () => {
  const t = await start();
  try {
    const res = await t.post(`/api/sessions/${A}/open`, { body: JSON.stringify({ cwd: '/etc', path: '/etc' }) });
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(t.calls.open.length, 1);
    assert.equal(t.calls.open[0].cwd, '/work/alpha');
    assert.equal(t.calls.open[0].sessionId, A);
    assert.equal(t.calls.open[0].distro, 'Ubuntu');
    assert.deepEqual(t.calls.open[0].knownCwds, ['/work/alpha', '/work/beta']);
  } finally { await t.stop(); }
});

test('POST open answers 200 with ok false and the reason when the opener throws', async () => {
  const t = await start({ openSession: async () => { throw new Error('Window not found'); } });
  try {
    const res = await t.post(`/api/sessions/${A}/open`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, reason: 'Window not found' });
  } finally { await t.stop(); }
});

test('GET steps: 404 for a non-UUID or unknown id, steps for a known one', async () => {
  const t = await start();
  try {
    assert.equal((await fetch(`${t.base}/api/sessions/nope/steps`)).status, 404);
    assert.equal((await fetch(`${t.base}/api/sessions/${C}/steps`)).status, 404);
    const res = await fetch(`${t.base}/api/sessions/${A}/steps`);
    assert.deepEqual(await res.json(), { steps: [], terminal: null });
  } finally { await t.stop(); }
});

function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: rawPath }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

test('malformed percent escape in the session id is 400 for GET steps and POST', async () => {
  const t = await start();
  try {
    assert.equal(await rawGet(t.port, '/api/sessions/%E0%A4%A/steps'), 400);
    const res = await t.post('/api/sessions/%E0%A4%A/dismiss');
    assert.equal(res.status, 400);
    assert.equal((await t.post('/api/sessions/%E0%A4%A/open')).status, 400);
    assert.deepEqual(await loadDismissed(t.cfg), []);
  } finally { await t.stop(); }
});

test('static: .mjs is text/javascript, /../package.json is 404 (temp public folder)', async () => {
  const pub = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-public-'));
  await fs.writeFile(path.join(pub, 'index.html'), '<p>x</p>');
  await fs.writeFile(path.join(pub, 'probe.mjs'), 'export default 1;');
  await fs.writeFile(path.join(path.dirname(pub), 'tower-secret.txt'), 'secret');
  const t = await start({ publicDir: pub });
  try {
    const res = await fetch(`${t.base}/probe.mjs`);
    assert.match(res.headers.get('content-type'), /^text\/javascript/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await rawGet(t.port, '/../package.json'), 404);
    assert.equal(await rawGet(t.port, '/%2e%2e/package.json'), 404);
    assert.equal(await rawGet(t.port, '/..%2ftower-secret.txt'), 404);
    assert.equal((await fetch(`${t.base}/`)).status, 200);
  } finally {
    await fs.rm(path.join(path.dirname(pub), 'tower-secret.txt'), { force: true });
    await fs.rm(pub, { recursive: true, force: true });
    await t.stop();
  }
});

test('POST open of a row without a jump is refused before any opener', async () => {
  const t = await start();
  try {
    const res = await t.post(`/api/sessions/${B}/open`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, reason: 'This session cannot be opened from here' });
    assert.equal(t.calls.open.length, 0);
    assert.equal(t.calls.desktop.length, 0);
    assert.equal(t.calls.registry, 0);
  } finally { await t.stop(); }
});

test('POST open refuses when the registry is unreadable', async () => {
  const t = await start({ loadRegistry: async () => null });
  try {
    const res = await t.post(`/api/sessions/${A}/open`);
    assert.deepEqual(await res.json(), { ok: false, reason: 'Registry not readable' });
    assert.equal(t.calls.open.length, 0);
  } finally { await t.stop(); }
});

test('guards run before collect: a collect error does not turn a 403 into a 500', async () => {
  const t = await start({ collect: async () => { throw new Error('boom'); } });
  try {
    assert.equal((await t.post(`/api/sessions/${A}/dismiss`, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await t.post(`/api/sessions/${A}/dismiss`, { type: 'text/plain' })).status, 415);
    assert.equal((await t.post('/api/sessions/nope/dismiss')).status, 400);
    assert.equal((await t.post(`/api/sessions/${A}/dismiss`)).status, 500);
  } finally { await t.stop(); }
});

function getWithHost(port, rawPath, host) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: rawPath, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

test('a foreign Host header is 403 on every route (DNS rebinding); own hosts pass', async () => {
  const t = await start();
  try {
    assert.equal(await getWithHost(t.port, '/api/state', 'evil.example'), 403);
    assert.equal(await getWithHost(t.port, '/api/state', `evil.example:${t.port}`), 403);
    assert.equal(await getWithHost(t.port, '/api/health', `127.0.0.1:${t.port + 1}`), 403);
    assert.equal(await getWithHost(t.port, '/', 'evil.example'), 403);
    assert.equal(await getWithHost(t.port, '/api/state', `127.0.0.1:${t.port}`), 200);
    assert.equal(await getWithHost(t.port, '/api/state', `localhost:${t.port}`), 200);
  } finally { await t.stop(); }
});

test('an SSE client that leaves during the first collect does not keep the poll loop alive', async () => {
  let collects = 0;
  const t = await start({
    collect: async () => {
      collects++;
      await new Promise((r) => setTimeout(r, 300));
      return snapshot();
    },
  });
  try {
    await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: t.port, path: '/api/events' });
      req.on('error', () => {});
      setTimeout(() => { req.destroy(); resolve(); }, 100); // gone while collect runs
    });
    await new Promise((r) => setTimeout(r, 500)); // first collect done
    const settled = collects;
    await new Promise((r) => setTimeout(r, 600)); // pollMs is 50: a live loop would add ~10 more
    assert.equal(collects, settled);
  } finally { await t.stop(); }
});

// --- settings API ---------------------------------------------------------------------
const DEFAULT_SETTINGS = {
  values: { idleAfterMinutes: 240 },
  defaults: { idleAfterMinutes: 240 },
  limits: { idleAfterMinutes: { min: 5, max: 1440 } },
};
const settingsFile = (t) => path.join(t.cfg.stateDir, 'settings.json');
const exists = (f) => fs.access(f).then(() => true, () => false);

test('GET /api/settings shows values, defaults and limits', async () => {
  const t = await start();
  try {
    const res = await fetch(`${t.base}/api/settings`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), DEFAULT_SETTINGS);
  } finally { await t.stop(); }
});

test('POST /api/settings stores the override and the next collect uses it', async () => {
  const t = await start();
  try {
    await fetch(`${t.base}/api/state`);
    assert.equal(t.calls.idle.at(-1), 240);
    const res = await t.post('/api/settings', { body: '{"idleAfterMinutes":60}' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.values, { idleAfterMinutes: 60 });
    assert.deepEqual(body.defaults, { idleAfterMinutes: 240 });
    await fetch(`${t.base}/api/state`);
    assert.equal(t.calls.idle.at(-1), 60);
  } finally { await t.stop(); }
});

test('stepsFor receives the effective config too', async () => {
  let seen;
  const t = await start({ stepsFor: async (c) => { seen = c.idleAfterMinutes; return { steps: [], terminal: null }; } });
  try {
    await t.post('/api/settings', { body: '{"idleAfterMinutes":60}' });
    assert.equal((await fetch(`${t.base}/api/sessions/${A}/steps`)).status, 200);
    assert.equal(seen, 60);
  } finally { await t.stop(); }
});

test('the override survives a restart of the daemon', async () => {
  const t = await start();
  try {
    assert.equal((await t.post('/api/settings', { body: '{"idleAfterMinutes":60}' })).status, 200);
    const idle = [];
    const second = createApp(t.cfg, {
      collect: async (c) => { idle.push(c.idleAfterMinutes); return snapshot(); },
      stepsFor: async () => ({ steps: [], terminal: null }),
    });
    await new Promise((r) => second.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${second.address().port}`;
      assert.deepEqual((await (await fetch(`${base}/api/settings`)).json()).values, { idleAfterMinutes: 60 });
      await fetch(`${base}/api/state`);
      assert.equal(idle[0], 60);
    } finally {
      second.closeAllConnections();
      await new Promise((r) => second.close(r));
    }
  } finally { await t.stop(); }
});

test('POST back to the default removes the override', async () => {
  const t = await start();
  try {
    await t.post('/api/settings', { body: '{"idleAfterMinutes":60}' });
    const res = await t.post('/api/settings', { body: '{"idleAfterMinutes":240}' });
    assert.deepEqual((await res.json()).values, { idleAfterMinutes: 240 });
    assert.deepEqual(JSON.parse(await fs.readFile(settingsFile(t), 'utf8')), {});
    await t.post('/api/settings', { body: '{"idleAfterMinutes":60}' });
    await t.post('/api/settings', { body: '{"idleAfterMinutes":null}' });
    assert.deepEqual((await (await fetch(`${t.base}/api/settings`)).json()).values, { idleAfterMinutes: 240 });
    await fetch(`${t.base}/api/state`);
    assert.equal(t.calls.idle.at(-1), 240);
  } finally { await t.stop(); }
});

test('POST /api/settings guards: refused requests change and write nothing', async () => {
  const t = await start();
  try {
    const cases = [
      [403, { origin: null, body: '{"idleAfterMinutes":60}' }],
      [403, { origin: 'http://evil.example', body: '{"idleAfterMinutes":60}' }],
      [415, { type: 'text/plain', body: '{"idleAfterMinutes":60}' }],
      [400, { body: '{"pollMs":1}' }],
      [400, { body: '{ nope' }],
      [400, { body: '{"idleAfterMinutes":4}' }],
      [400, { body: '[]' }],
      [413, { body: JSON.stringify({ idleAfterMinutes: 60, pad: 'x'.repeat(2000) }) }],
    ];
    for (const [status, opts] of cases) {
      const res = await t.post('/api/settings', opts);
      assert.equal(res.status, status, JSON.stringify(opts).slice(0, 60));
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.equal(typeof body.reason, 'string');
      assert.deepEqual((await (await fetch(`${t.base}/api/settings`)).json()).values, { idleAfterMinutes: 240 });
      assert.equal(await exists(settingsFile(t)), false);
    }
    assert.equal((await t.post('/api/settings', { body: '{"idleAfterMinutes":60}' })).status, 200);
  } finally { await t.stop(); }
});

test('a foreign Host is refused on /api/settings, GET and POST', async () => {
  const t = await start();
  try {
    assert.equal(await getWithHost(t.port, '/api/settings', 'evil.example'), 403);
    assert.equal(await getWithHost(t.port, '/api/settings', `127.0.0.1:${t.port}`), 200);
  } finally { await t.stop(); }
});

test('GET /api/events sends the new snapshot after a settings change, by itself', async () => {
  const t = await start({
    collect: async (c) => ({ ...snapshot(), counts: { total: 2, idleAfter: c.idleAfterMinutes } }),
  });
  const ctl = new AbortController();
  try {
    const res = await fetch(`${t.base}/api/events`, { signal: ctl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let seen = '';
    const readUntil = async (n) => {
      while ((seen.match(/event: state/g) ?? []).length < n) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += dec.decode(value);
      }
    };
    await readUntil(1);
    assert.equal((await t.post('/api/settings', { body: '{"idleAfterMinutes":60}' })).status, 200);
    await readUntil(2);
    const last = seen.split('event: state\ndata: ').at(-1).split('\n')[0];
    assert.equal(JSON.parse(last).counts.idleAfter, 60);
  } finally { ctl.abort(); await t.stop(); }
});

test('POST open of a desktop row calls only the desktop opener, with the snapshot id', async () => {
  const t = await start();
  try {
    const res = await t.post(`/api/sessions/${D}/open`, { body: JSON.stringify({ hostSessionId: 'last' }) });
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(t.calls.desktop, [{ hostSessionId: 'local_c1' }]);
    assert.equal(t.calls.open.length, 0);
    assert.equal(t.calls.registry, 0);
  } finally { await t.stop(); }
});

test('POST open of a desktop row answers ok false with the reason when the desktop opener throws', async () => {
  const t = await start({ openDesktop: async () => { throw new Error('wslview missing (package wslu)'); } });
  try {
    const res = await t.post(`/api/sessions/${D}/open`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, reason: 'wslview missing (package wslu)' });
  } finally { await t.stop(); }
});

test('POST open of a Windows VS Code row reads the Windows registry for twins and passes host windows and home', async () => {
  const W = '123e4567-e89b-42d3-a456-426614174003';
  const regCalls = [];
  const t = await start({
    cfgOverrides: { windowsClaudeDir: '/mnt/c/Users/sam/.claude' },
    collect: async () => ({ generatedAt: new Date().toISOString(), sources: {}, counts: { total: 1 }, sessions: [
      { id: W, cwd: 'C:\\Users\\sam', state: 'waiting', host: 'windows', opensIn: 'vscode', hostSessionId: null, canOpen: true, dismissed: false },
    ] }),
    loadRegistry: async (c, opts) => { regCalls.push(opts); return { live: new Map(), knownCwds: ['C:\\Users\\sam'] }; },
  });
  try {
    const res = await t.post(`/api/sessions/${W}/open`);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual([regCalls[0]?.claudeDir, regCalls[0]?.origin, typeof regCalls[0]?.startTimes],
      ['/mnt/c/Users/sam/.claude', 'windows', 'function']);
    const o = t.calls.open[0];
    assert.deepEqual([o.cwd, o.sessionId, o.host, o.home, o.knownCwds],
      ['C:\\Users\\sam', W, 'windows', 'C:\\Users\\sam', ['C:\\Users\\sam']]);
  } finally { await t.stop(); }
});
