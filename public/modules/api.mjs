// Talks to the daemon: the event stream, the steps of one session, the three actions.
import { S } from '../strings.mjs';

const SILENCE_MS = 5000; // the daemon sends a ping every 2 s
const RETRY_MS = 3000;

/**
 * Subscribes to /api/events. onSnapshot(snapshot) for every state event; onStatus('online' |
 * 'offline') whenever that changes. Offline means: the stream reported an error, or neither a
 * state nor a ping arrived for 5 s. Returns a function that ends the subscription.
 */
export function subscribe(onSnapshot, onStatus) {
  let source = null;
  let status = null;
  let silence = null;
  let retry = null;
  let ended = false;

  const set = (next) => {
    if (next === status) return;
    status = next;
    onStatus(next);
  };
  const armSilence = () => {
    clearTimeout(silence);
    silence = setTimeout(() => set('offline'), SILENCE_MS);
  };
  const alive = () => {
    set('online');
    armSilence();
  };

  function connect() {
    if (ended) return;
    source = new EventSource('/api/events');
    source.addEventListener('state', (e) => {
      let snapshot;
      try {
        snapshot = JSON.parse(e.data);
      } catch {
        return;
      }
      alive();
      onSnapshot(snapshot);
    });
    source.addEventListener('ping', alive);
    source.addEventListener('error', () => {
      clearTimeout(silence);
      set('offline');
      // The browser retries by itself after a dropped connection, but gives up for good after
      // an HTTP error answer; then the stream is closed and we start a new one.
      if (source.readyState === EventSource.CLOSED) {
        clearTimeout(retry);
        retry = setTimeout(connect, RETRY_MS);
      }
    });
  }

  armSilence();
  connect();
  return () => {
    ended = true;
    clearTimeout(silence);
    clearTimeout(retry);
    source?.close();
  };
}

/** The steps answer of one session (spec 7.4). Throws when the daemon does not answer with it. */
export async function getSteps(id) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/steps`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`steps: HTTP ${res.status}`);
  return res.json();
}

/** POST to a session's action with a JSON body. Always resolves with an object: the daemon's
 *  answer, or { ok: false, reason } when it could not be reached or answered with something else. */
async function postJson(id, action, body) {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const answer = await res.json();
    if (answer && typeof answer === 'object') return answer;
  } catch {
    // falls through
  }
  return { ok: false, reason: S.offline };
}

/** POST open | dismiss | restore. */
export function post(id, action) {
  return postJson(id, action, {});
}

/**
 * The user's answer to a held permission request of that session:
 * { requestId, behavior: 'allow' | 'deny', choices? } (choices: option indices per question).
 * Resolves with { ok: true }, or { ok: false, reason }.
 */
export function answer(sessionId, body) {
  return postJson(sessionId, 'answer', body);
}

/** The settings answer of the daemon. Throws when it does not answer with it (an older daemon: 404). */
export async function getSettings() {
  const res = await fetch('/api/settings', { cache: 'no-store' });
  if (!res.ok) throw new Error(`settings: HTTP ${res.status}`);
  return res.json();
}

/**
 * POST /api/settings with a patch such as { idleAfterMinutes: 60 }. Always resolves with an
 * object: the new settings answer, or { ok: false, reason } (the daemon's reason, or "offline").
 */
export async function setSettings(patch) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const body = await res.json();
    if (body && typeof body === 'object') return body;
  } catch {
    // falls through
  }
  return { ok: false, reason: S.offline };
}
