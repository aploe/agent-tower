// The HTTP app: API (spec 7.5), guarded POST actions, static files from public/.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, stepsFor } from './collect.mjs';
import { loadRegistry } from './sources/registry.mjs';
import { openSession, UUID } from './vscode.mjs';
import { openDesktopSession, windowsPathOf, windowsStartTimes } from './windows.mjs';
import { groupOf, updateDismissed } from './dismissed.mjs';
import { checkHost, checkPost, checkPostOrigin, checkPostRequest } from './guards.mjs';
import { KEYS, defaultsOf, loadSettings, updateSettings, validatePatch } from './settings.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PUBLIC = path.join(ROOT, 'public');
// Heartbeat as a named event: EventSource hides comment lines from the page, and the page
// needs to see that the daemon is alive while nothing changes.
const PING_MS = 2000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // Without this entry modules go out as octet-stream and the browser silently refuses them.
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const defaultDeps = { collect, stepsFor, loadRegistry, openSession, openDesktop: openDesktopSession };

/** Percent-decoding of a path segment; null when it is malformed. */
function decodeId(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

// Settings POST body: a handful of keys; anything bigger is not from the widget.
const MAX_BODY = 1024;

const withoutStamp = (snap) => JSON.stringify({ ...snap, generatedAt: null });

export function createApp(cfg, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const PUBLIC = path.resolve(d.publicDir ?? DEFAULT_PUBLIC);
  const pingMs = d.pingMs ?? PING_MS;
  let version = '0.0.0';
  fs.readFile(path.join(ROOT, 'package.json'), 'utf8')
    .then((t) => { version = JSON.parse(t).version ?? version; })
    .catch(() => {});

  // --- settings: config defaults overlaid with the user's overrides -------------------
  // Requests wait for the first load; `effective` is what collect and stepsFor see.
  const defaults = defaultsOf(cfg);
  let overrides = {};
  let effective = cfg;
  const settingsReady = loadSettings(cfg).then((o) => { overrides = o; effective = { ...cfg, ...o }; });
  const settingsBody = () => ({
    values: { ...defaults, ...overrides },
    defaults,
    limits: Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, { min: v.min, max: v.max }])),
  });

  // --- snapshot cache ---------------------------------------------------------------
  let cache = { at: 0, snap: null };
  let inflight = null;
  let generation = 0; // bumped by invalidate(); a collect that started earlier is not cached

  function getState({ fresh = false } = {}) {
    if (!fresh && cache.snap && Date.now() - cache.at < cfg.pollMs) return Promise.resolve(cache.snap);
    if (inflight && !fresh) return inflight;
    const gen = generation;
    const p = Promise.resolve(d.collect(effective)).then((snap) => {
      if (gen === generation) cache = { at: Date.now(), snap };
      return snap;
    });
    const tracked = p.finally(() => { if (inflight === tracked) inflight = null; });
    inflight = tracked;
    return tracked;
  }
  function invalidate() {
    generation++;
    cache = { at: 0, snap: null };
    inflight = null;
  }

  // --- event stream -----------------------------------------------------------------
  const clients = new Set();
  let lastSig = null;
  let loop = null;

  const frame = (snap) => `event: state\ndata: ${JSON.stringify(snap)}\n\n`;

  async function tick() {
    loop = null;
    if (clients.size === 0) return;
    try {
      const snap = await getState({ fresh: true });
      const sig = withoutStamp(snap);
      if (sig !== lastSig) {
        lastSig = sig;
        for (const c of clients) c.write(frame(snap));
      }
    } catch (err) {
      console.error(`event stream: collect failed: ${err?.message ?? err}`); // retried next tick
    }
    if (clients.size > 0 && !loop) loop = setTimeout(tick, cfg.pollMs);
  }

  function addClient(res, snap) {
    if (clients.size === 0) lastSig = withoutStamp(snap);
    clients.add(res);
    res.write(frame(snap));
    const ping = setInterval(() => res.write('event: ping\ndata: 1\n\n'), pingMs);
    res.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
      if (clients.size === 0) {
        clearTimeout(loop);
        loop = null;
        lastSig = null;
      }
    });
    if (!loop) loop = setTimeout(tick, cfg.pollMs);
  }

  // --- helpers ----------------------------------------------------------------------
  function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function serveStatic(pathname, res) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return json(res, 404, { ok: false, reason: 'not found' });
    }
    if (rel === '/') rel = '/index.html';
    const file = path.resolve(PUBLIC, `.${rel}`);
    if (rel.includes('\0') || !file.startsWith(PUBLIC + path.sep)) {
      return json(res, 404, { ok: false, reason: 'not found' });
    }
    let body;
    try {
      body = await fs.readFile(file);
    } catch {
      return json(res, 404, { ok: false, reason: 'not found' });
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  /** Reads the body up to MAX_BODY bytes; null (after the 413 is sent) when it is larger. */
  async function readBody(req, res) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.resume(); // drain without keeping it; the answer goes out right away
        json(res, 413, { ok: false, reason: 'Request too large' });
        return null;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function handleSettingsPost(req, res) {
    const pre = checkPostOrigin({
      remoteAddress: req.socket.remoteAddress,
      headers: req.headers,
      port: req.socket.localPort,
    });
    if (!pre.ok) {
      req.resume();
      return json(res, pre.status, { ok: false, reason: pre.reason });
    }
    const text = await readBody(req, res);
    if (text === null) return undefined;
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json(res, 400, { ok: false, reason: 'Not valid JSON' });
    }
    const verdict = validatePatch(body);
    if (!verdict.ok) return json(res, 400, { ok: false, reason: verdict.reason });
    overrides = await updateSettings(cfg, defaults, verdict.patch);
    effective = { ...cfg, ...overrides };
    invalidate(); // the event stream picks up the new snapshot on its next tick
    return json(res, 200, settingsBody());
  }

  async function handlePost(req, res, id, action) {
    req.resume(); // the body carries nothing we use; never read cwd or anything else from it
    const request = {
      remoteAddress: req.socket.remoteAddress,
      headers: req.headers,
      sessionId: id,
      port: req.socket.localPort,
    };
    // Everything that needs no snapshot first: a collect error must not turn a 403 into a 500.
    const pre = checkPostRequest(request);
    if (!pre.ok) return json(res, pre.status, { ok: false, reason: pre.reason });
    const snap = await getState();
    const verdict = checkPost({ ...request, knownIds: new Set(snap.sessions.map((s) => s.id)) });
    if (!verdict.ok) return json(res, verdict.status, { ok: false, reason: verdict.reason });
    const session = snap.sessions.find((s) => s.id === id);

    if (action === 'open') {
      // Server-side: a live CLI session must never be "restored" in the extension (it would
      // start twice), and a row without a proven jump gets none. The page hides the arrow, but
      // the guard belongs here.
      const noJump = { ok: false, reason: 'This session cannot be opened from here' };
      if (!session.canOpen) return json(res, 200, noJump);
      try {
        if (session.opensIn === 'desktop') {
          // The id comes from the snapshot, never from the request (spec §11, F30).
          await d.openDesktop({ hostSessionId: session.hostSessionId });
          return json(res, 200, { ok: true });
        }
        if (session.opensIn !== 'vscode') return json(res, 200, noJump);
        const onWindows = session.host === 'windows';
        if (onWindows && !cfg.windowsClaudeDir) return json(res, 200, noJump);
        // The twin check compares folders of the session's own side: WSL or Windows.
        const registry = onWindows
          ? await d.loadRegistry(cfg, { claudeDir: cfg.windowsClaudeDir, origin: 'windows', startTimes: windowsStartTimes })
          : await d.loadRegistry(cfg);
        // Without the registry the twin check (two folders, same name) cannot run: refuse.
        if (!registry) return json(res, 200, { ok: false, reason: 'Registry not readable' });
        await d.openSession({
          cwd: session.cwd,
          sessionId: id,
          distro: cfg.wslDistro,
          knownCwds: [...registry.knownCwds],
          cfg,
          ...(onWindows ? { host: 'windows', home: windowsPathOf(path.dirname(cfg.windowsClaudeDir)) } : {}),
        });
        return json(res, 200, { ok: true });
      } catch (err) {
        // A refusal ("window not found") is a normal answer, not a server error.
        return json(res, 200, { ok: false, reason: err?.message ?? String(err) });
      }
    }
    // dismiss / restore: load, change, save as one step (a reconcile cannot interleave)
    await updateDismissed(cfg, (entries) => {
      const rest = entries.filter((e) => e.sessionId !== id);
      if (action === 'dismiss') rest.push({ sessionId: id, group: groupOf(session.state) });
      return rest;
    });
    invalidate();
    return json(res, 200, await getState({ fresh: true }));
  }

  // --- server -----------------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    try {
      if (!checkHost({ headers: req.headers, port: req.socket.localPort })) {
        req.resume();
        return json(res, 403, { ok: false, reason: 'Foreign host' });
      }
      await settingsReady;
      const { pathname } = new URL(req.url, 'http://localhost');
      if (req.method === 'GET') {
        if (pathname === '/api/health') {
          return json(res, 200, { ok: true, name: 'agent-tower', version, pid: process.pid });
        }
        if (pathname === '/api/settings') return json(res, 200, settingsBody());
        if (pathname === '/api/state') return json(res, 200, await getState());
        if (pathname === '/api/events') {
          // 'close' may fire while the first collect runs; remember it, or the client would
          // be added dead and keep the poll loop alive for good.
          let gone = false;
          res.once('close', () => { gone = true; });
          const snap = await getState();
          if (gone) return;
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-store',
            connection: 'keep-alive',
          });
          return addClient(res, snap);
        }
        const steps = pathname.match(/^\/api\/sessions\/([^/]+)\/steps$/);
        if (steps) {
          const id = decodeId(steps[1]);
          if (id === null) return json(res, 400, { ok: false, reason: 'Not a valid session id' });
          const snap = await getState();
          if (!UUID.test(id) || !snap.sessions.some((s) => s.id === id)) {
            return json(res, 404, { ok: false, reason: 'Unknown session' });
          }
          return json(res, 200, await d.stepsFor(effective, id));
        }
        if (pathname.startsWith('/api/')) return json(res, 404, { ok: false, reason: 'not found' });
        return await serveStatic(pathname, res);
      }
      if (req.method === 'POST') {
        if (pathname === '/api/settings') return await handleSettingsPost(req, res);
        const m = pathname.match(/^\/api\/sessions\/([^/]+)\/(open|dismiss|restore)$/);
        if (m) {
          const id = decodeId(m[1]);
          if (id === null) {
            req.resume();
            return json(res, 400, { ok: false, reason: 'Not a valid session id' });
          }
          return await handlePost(req, res, id, m[2]);
        }
      }
      return json(res, 404, { ok: false, reason: 'not found' });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { ok: false, reason: err?.message ?? String(err) });
      else res.end();
    }
  });

  server.on('close', () => {
    clearTimeout(loop);
    loop = null;
  });
  return server;
}
