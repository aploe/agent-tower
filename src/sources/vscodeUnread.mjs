// VS Code's own unread marks for Claude sessions (spec §7.10, F34). The Claude extension keeps
// them in VS Code's global state, one list of session keys per workspace folder under
// `sessionUnread:<folder>`; a key is the session id (`remote:<id>` for cloud sessions). It sets
// a mark when a turn ends while the session's tab is not visible and clears it when the tab is
// shown. VS Code on Windows keeps that state in a SQLite file. The reader loads the whole file
// into memory and opens the copy there: nothing is written and the file is never locked.
import { readFile, stat } from 'node:fs/promises';

const EXTENSION_KEY = 'anthropic.claude-code';
const PREFIX = 'sessionUnread:';

/** Session keys with an unread mark, from the extension's parsed state object. */
export function unreadKeysOf(state) {
  const keys = new Set();
  if (!state || typeof state !== 'object') return keys;
  for (const [k, v] of Object.entries(state)) {
    if (!k.startsWith(PREFIX) || !Array.isArray(v)) continue;
    for (const key of v) if (typeof key === 'string' && key) keys.add(key);
  }
  return keys;
}

// node:sqlite is part of Node from 22.13 on; an older Node reads as "unknown", not as a crash.
let sqlite;
const loadSqlite = () => (sqlite ??= import('node:sqlite').catch(() => null));

/** The extension's state object from the bytes of a state.vscdb ({} without an entry). Throws on a broken file. */
async function extensionStateOf(bytes) {
  const mod = await loadSqlite();
  if (!mod) throw new Error('node:sqlite not available');
  const db = new mod.DatabaseSync(':memory:');
  try {
    db.deserialize(bytes);
    const row = db.prepare('SELECT value FROM ItemTable WHERE lower(key) = ?').get(EXTENSION_KEY);
    if (!row) return {};
    const text = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8');
    return JSON.parse(text);
  } finally {
    db.close();
  }
}

const sigOf = (st) => `${st.mtimeMs}:${st.size}`;

/**
 * () => Promise<Set<string> | null>: the marked session keys, null when not known (no file, a
 * broken file, no node:sqlite). The file is read again only when its mtime or size changed. When
 * it changes while being read, the last answer stays until the next call reads it whole.
 */
export function createUnreadReader(file, { fs = { readFile, stat } } = {}) {
  let sig = null;
  let last = null;
  return async function read() {
    if (!file) return null;
    try {
      const before = sigOf(await fs.stat(file));
      if (before === sig) return last;
      const bytes = await fs.readFile(file);
      if (sigOf(await fs.stat(file)) !== before) return last;
      last = unreadKeysOf(await extensionStateOf(bytes));
      sig = before;
    } catch {
      sig = null;
      last = null;
    }
    return last;
  };
}

const readers = new Map();

/** The daemon's reader for `file`, kept across polls so an unchanged file is not read again. */
export function loadUnread(file) {
  if (!readers.has(file)) readers.set(file, createUnreadReader(file));
  return readers.get(file)();
}
