// Session figure: a stable hue per session id. The drawing itself lives in render.mjs.

/** Number of figure hues; tower.css defines --hue-0 … --hue-(HUE_COUNT-1). */
export const HUE_COUNT = 12;

/** FNV-1a (32 bit) over the id's UTF-16 code units, modulo n. Same id, same colour. */
export function hueIndex(sessionId, n = HUE_COUNT) {
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % n;
}

/** Shown before hidden, then oldest first: who claims a colour first on a fresh page. */
function byClaim(a, b) {
  return Number(Boolean(a.dismissed)) - Number(Boolean(b.dismissed))
    || String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? ''))
    || a.id.localeCompare(b.id);
}

/**
 * Colour per session (id → hue index) for the sessions in a snapshot, two the same only when
 * there are more sessions than hues. A session keeps the colour it holds in `held` for as
 * long as it is listed; a new one takes its hash colour, or the next one not in use.
 * Sessions no longer listed drop out and free their colour. After a page reload the hash
 * colours are handed out afresh, so a session that had to move may get another one.
 */
export function assignHues(sessions, held = new Map(), n = HUE_COUNT) {
  const hues = new Map();
  for (const s of sessions) if (held.has(s.id)) hues.set(s.id, held.get(s.id));
  const used = new Set(hues.values());
  for (const s of [...sessions].sort(byClaim)) {
    if (hues.has(s.id)) continue;
    let i = hueIndex(s.id, n);
    if (used.size < n) while (used.has(i)) i = (i + 1) % n;
    hues.set(s.id, i);
    used.add(i);
  }
  return hues;
}
