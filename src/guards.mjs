// Guards for every POST (spec section 12). Pure: no I/O, no request object.
import { UUID } from './vscode.mjs';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const refuse = (status, reason) => ({ ok: false, status, reason });

/** The checks every POST needs, with or without a session: loopback, origin, content type. */
export function checkPostOrigin({ remoteAddress, headers = {}, port }) {
  if (!LOOPBACK.has(remoteAddress ?? '')) return refuse(403, 'nur lokal');
  const origin = headers.origin;
  if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    return refuse(403, 'fremde Herkunft');
  }
  if ((headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return refuse(415, 'content-type muss application/json sein');
  }
  return { ok: true };
}

/** The checks that need no snapshot: the origin checks plus the UUID form. */
export function checkPostRequest(request) {
  const pre = checkPostOrigin(request);
  if (!pre.ok) return pre;
  if (!UUID.test(request.sessionId ?? '')) return refuse(400, 'keine gültige Session-ID');
  return { ok: true };
}

export function checkPost({ knownIds, ...request }) {
  const pre = checkPostRequest(request);
  if (!pre.ok) return pre;
  if (!knownIds.has(request.sessionId)) return refuse(404, 'unbekannte Session');
  return { ok: true };
}

/** DNS-rebinding guard for every request: the Host must be our own loopback origin. */
export function checkHost({ headers = {}, port }) {
  const host = headers.host;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}
