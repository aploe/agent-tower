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
import { checkHookRequest, checkHost, checkPost, checkPostOrigin, checkPostRequest } from './guards.mjs';
import { defaultsOf, limitsOf, loadSettings, updateSettings, validatePatch } from './settings.mjs';
import { say, setLanguage as setMessageLanguage } from './messages.mjs';
import { createRequests, eligibility } from './requests.mjs';

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
// An answer from the page: a request id, allow or deny, a few option indices.
const MAX_ANSWER_BODY = 4096;
// A hook call carries the tool's whole input (a Write call: the file). Beyond this it is not
// read into memory and not offered for answering.
const MAX_HOOK_BODY = 1024 * 1024;

// How long a shutdown waits between answering the held hook calls and closing the connections.
const SHUTDOWN_FLUSH_MS = 100;

/** "No decision" for a hook call: Claude Code carries on as it does without the hook. */
function noDecision(res) {
  res.writeHead(200);
  res.end();
}

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
  // The daemon's own refusals follow the language setting too.
  const useOverrides = (o) => {
    overrides = o;
    effective = { ...cfg, ...o };
    setMessageLanguage({ ...defaults, ...o }.language);
  };
  setMessageLanguage(defaults.language);
  const settingsReady = loadSettings(cfg).then(useOverrides);
  const settingsBody = () => ({
    values: { ...defaults, ...overrides },
    defaults,
    limits: limitsOf(),
  });

  // --- snapshot cache ---------------------------------------------------------------
  let cache = { at: 0, snap: null };
  let inflight = null;
  let generation = 0; // bumped by invalidate(); a collect that started earlier is not cached

  // --- held permission requests ---------------------------------------------------------
  // Hook calls that wait for an answer in the widget (src/requests.mjs). Every ending is one
  // log line without any text of the request, and makes the next snapshot a new one.
  const logLine = d.log ?? ((line) => console.log(line));
  const requests = createRequests({
    graceMs: d.graceMs,
    log: ({ ending, behavior, tool, heldMs, session }) => {
      invalidate();
      logLine(`request: ${tool} ${ending}${behavior ? ` ${behavior}` : ''} after ${Math.round(heldMs / 1000)} s (session ${session})`);
    },
  });
  const answering = () => ({ ...defaults, ...overrides }).answerInWidget === true;
  const withRequests = (snap) => ({
    ...snap,
    sessions: snap.sessions.map((s) => ({ ...s, requests: requests.listFor(s.id) })),
  });

  function getState({ fresh = false } = {}) {
    if (!fresh && cache.snap && Date.now() - cache.at < cfg.pollMs) return Promise.resolve(cache.snap);
    if (inflight && !fresh) return inflight;
    const gen = generation;
    const p = Promise.resolve(d.collect(effective)).then((collected) => {
      const snap = withRequests(collected);
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

  // While a request is held, look at the sessions every pollMs, with or without a page
  // listening: a request whose session is gone or no longer asks was answered elsewhere.
  let watch = null;
  function watchRequests() {
    if (watch || requests.size === 0) return;
    watch = setTimeout(async () => {
      watch = null;
      try {
        requests.reconcile(await getState({ fresh: true }));
      } catch (err) {
        logLine(`held requests: collect failed: ${err?.message ?? err}`); // retried next tick
      }
      watchRequests();
    }, cfg.pollMs);
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

  /** The body as text, or null when it is larger than `limit`. A larger body is read to its
   *  end without being kept: leaving the loop early would reset the connection under a caller
   *  that is still sending, and it would never see the answer. */
  async function readBody(req, limit) {
    let chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) chunks = [];
      else chunks.push(chunk);
    }
    return size > limit ? null : Buffer.concat(chunks).toString('utf8');
  }

  /** POST /api/hook/permission-request: Claude Code asks whether a tool call may run. Held for
   *  the widget when eligible; everything else, and every error, is "no decision". */
  async function handleHook(req, res) {
    const pre = checkHookRequest({ remoteAddress: req.socket.remoteAddress, headers: req.headers });
    if (!pre.ok) {
      req.resume();
      return json(res, pre.status, { ok: false, reason: pre.reason });
    }
    try {
      const text = await readBody(req, MAX_HOOK_BODY);
      if (text === null) return noDecision(res);
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        return noDecision(res);
      }
      // The session's row: the cached snapshot when it knows the id, else one fresh look
      // (a session that started a moment ago).
      const id = payload?.session_id;
      let session = null;
      if (answering() && typeof id === 'string') {
        const find = (snap) => snap.sessions.find((s) => s.id === id) ?? null;
        session = find(await getState()) ?? find(await getState({ fresh: true }));
      }
      const verdict = eligibility({ payload, session, enabled: answering(), heldCount: requests.size });
      if (!verdict.hold) return noDecision(res);

      const requestId = requests.hold(verdict.request, (decision) => {
        if (decision === null) return noDecision(res);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }));
      });
      // Claude Code gave up on the call (hook timeout, session ended, "No" in its own dialog).
      // After an answer of ours this is a no-op: the request is already gone.
      res.on('close', () => requests.drop(requestId));
      invalidate();
      watchRequests();
      return undefined;
    } catch (err) {
      logLine(`hook call passed through: ${err?.message ?? err}`);
      if (!res.headersSent) noDecision(res);
      return undefined;
    }
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
    const text = await readBody(req, MAX_BODY);
    if (text === null) return json(res, 413, { ok: false, reason: 'Request too large' });
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return json(res, 400, { ok: false, reason: 'Not valid JSON' });
    }
    const verdict = validatePatch(body);
    if (!verdict.ok) return json(res, 400, { ok: false, reason: verdict.reason });
    useOverrides(await updateSettings(cfg, defaults, verdict.patch));
    if (!answering()) requests.endAll('E5'); // switched off: hand every held request back
    invalidate(); // the event stream picks up the new snapshot on its next tick
    return json(res, 200, settingsBody());
  }

  async function handlePost(req, res, id, action) {
    // Only an answer has a body we use; for the rest it is drained unread (never take cwd or
    // anything else from it).
    if (action !== 'answer') req.resume();
    const request = {
      remoteAddress: req.socket.remoteAddress,
      headers: req.headers,
      sessionId: id,
      port: req.socket.localPort,
    };
    // Everything that needs no snapshot first: a collect error must not turn a 403 into a 500.
    const refuse = (status, reason) => {
      req.resume();
      return json(res, status, { ok: false, reason });
    };
    const pre = checkPostRequest(request);
    if (!pre.ok) return refuse(pre.status, pre.reason);
    const snap = await getState();
    const verdict = checkPost({ ...request, knownIds: new Set(snap.sessions.map((s) => s.id)) });
    if (!verdict.ok) return refuse(verdict.status, verdict.reason);
    const session = snap.sessions.find((s) => s.id === id);

    if (action === 'answer') {
      // The user's click on a held permission request. The store checks that the request is
      // held for this session and builds the decision; the page only names what was clicked.
      const text = await readBody(req, MAX_ANSWER_BODY);
      if (text === null) return json(res, 413, { ok: false, reason: 'Request too large' });
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return json(res, 400, { ok: false, reason: 'Not valid JSON' });
      }
      const answered = requests.answer(id, body?.requestId, body);
      if (!answered.ok) return json(res, answered.status, { ok: false, reason: answered.reason });
      return json(res, 200, { ok: true });
    }

    if (action === 'open') {
      // Server-side: a live CLI session must never be "restored" in the extension (it would
      // start twice), and a row without a proven jump gets none. The page hides the arrow, but
      // the guard belongs here.
      const noJump = { ok: false, reason: say('noJump') };
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
        if (!registry) return json(res, 200, { ok: false, reason: say('registryUnreadable') });
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
            return json(res, 404, { ok: false, reason: say('unknownSession') });
          }
          return json(res, 200, await d.stepsFor(effective, id));
        }
        if (pathname.startsWith('/api/')) return json(res, 404, { ok: false, reason: 'not found' });
        return await serveStatic(pathname, res);
      }
      if (req.method === 'POST') {
        if (pathname === '/api/settings') return await handleSettingsPost(req, res);
        if (pathname === '/api/hook/permission-request') return await handleHook(req, res);
        const m = pathname.match(/^\/api\/sessions\/([^/]+)\/(open|dismiss|restore|answer)$/);
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
    clearTimeout(watch);
    watch = null;
  });
  /** Every held hook call gets "no decision" instead of a reset. */
  server.endHeldRequests = () => requests.endAll('E7');
  /** Stops the server. Held hook calls are answered first; the connections are closed a
   *  moment later, so that those answers still leave. */
  server.shutdown = (done = () => {}) => {
    server.endHeldRequests();
    setTimeout(() => {
      server.closeAllConnections();
      server.close(() => done());
    }, SHUTDOWN_FLUSH_MS);
  };
  return server;
}
