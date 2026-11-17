// Copied from agent-colony@7da77bb: src/sources/transcript.mjs
// Changed: kept readTail and the tail-window growth; dropped tailInfo/lastRecordMs/cwd/last-record
// extraction; added tool-call extraction (open/done/error with results), the ai-title, the chain
// filter (isMeta records and "[Request interrupted by user" markers are no real prompt), the per-file cache keyed on chain + minToolCalls, locateTranscript and subagentOpenCalls.
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Transcript tails: never read a whole file. A transcript can reach 9 MB and a
 *  single line 160 KB. Activity is the timestamp of the newest role record
 *  (user/assistant), not the file mtime (a `sed -i` over all transcripts once
 *  made every session look active). */

const TAIL_BYTES = 65536;
const TAIL_MAX_BYTES = 1048576;

/** Reads only the end of the file. `whole` says whether the tail already was the whole file. */
async function readTail(file, bytes) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, size));
    await fh.read(buf, 0, buf.length, start);
    return { text: buf.toString('utf8'), whole: start === 0 };
  } finally {
    await fh.close();
  }
}

/** String content, or the `text` blocks joined with newlines. */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function toMs(ts) {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

/** Typed by the human: not isMeta (skill bodies, image notes, other sessions) and not the
 *  interrupt marker (the interrupted call has its own error result). */
function isRealPrompt(rec, content) {
  if (rec.isMeta === true) return false;
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
        : '';
  return !text.startsWith('[Request interrupted by user');
}

/** Insert with a cap; the oldest insertion is evicted. A hit re-inserts (active files stay). */
const CACHE_MAX = 200;
function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_MAX) map.delete(map.keys().next().value);
}

/**
 * Pure: interpret the text of a transcript tail.
 * The first line of a tail is usually cut and the last may be half written;
 * lines that do not parse are skipped.
 * chain 'main' ignores records with isSidechain === true, 'any' keeps them.
 * @returns {{ lastMs: number|null, lastType: 'user'|'assistant'|null, aiTitle: string|null,
 *   calls: object[], open: object[] }}
 */
export function parseTail(text, { chain = 'main' } = {}) {
  let aiTitle = null;
  let lastMs = null;
  let lastType = null;
  const calls = [];
  const byId = new Map();

  for (const raw of text.split('\n')) {
    const ln = raw.trim();
    if (!ln.startsWith('{')) continue;
    let rec;
    try {
      rec = JSON.parse(ln);
    } catch {
      continue; // cut or broken line
    }
    if (rec.type === 'ai-title') {
      if (typeof rec.aiTitle === 'string') aiTitle = rec.aiTitle;
      continue;
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    if (chain === 'main' && rec.isSidechain === true) continue;

    lastType = rec.type;
    const ms = toMs(rec.timestamp);
    if (ms !== null) lastMs = ms;

    const content = rec.message?.content;
    const blocks = Array.isArray(content) ? content : [];

    if (rec.type === 'assistant') {
      for (const b of blocks) {
        if (b?.type !== 'tool_use') continue;
        const call = {
          id: b.id,
          name: b.name,
          input: b.input ?? null,
          atMs: ms,
          status: 'running',
          resultText: null,
        };
        calls.push(call);
        byId.set(b.id, call);
      }
      continue;
    }

    const results = blocks.filter((b) => b?.type === 'tool_result');
    if (results.length) {
      for (const b of results) {
        const call = byId.get(b.tool_use_id);
        if (!call) continue; // its tool_use lies before the tail
        call.status = b.is_error ? 'error' : 'done';
        call.resultText = resultText(b.content);
      }
    } else if (isRealPrompt(rec, content)) {
      // A real prompt: whatever is still unanswered before it was interrupted.
      for (const c of calls) if (c.status === 'running') c.status = 'error';
    }
  }

  return { lastMs, lastType, aiTitle, calls, open: calls.filter((c) => c.status === 'running') };
}

/** 64 KB tail, x4 up to 1 MB, until the tail holds a role record and at least
 *  `minToolCalls` calls, or the file start is reached. Whatever the cap yields is the answer. */
async function readAnalyzed(file, minToolCalls, chain) {
  for (let bytes = TAIL_BYTES; ; bytes *= 4) {
    const { text, whole } = await readTail(file, bytes);
    const info = parseTail(text, { chain });
    const enough = info.lastType !== null && info.calls.length >= minToolCalls;
    if (enough || whole || bytes >= TAIL_MAX_BYTES) return info;
  }
}

const cache = new Map();

/** Cached per file + chain + minToolCalls while mtimeMs and size are unchanged
 *  (in memory only). A missing file throws; the collector catches per session. */
export async function analyzeTranscript(file, { minToolCalls = 0, chain = 'main' } = {}) {
  const { mtimeMs, size } = await stat(file);
  const key = `${file}\0${chain}\0${minToolCalls}`;
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
    remember(cache, key, hit);
    return hit.info;
  }
  const info = await readAnalyzed(file, minToolCalls, chain);
  remember(cache, key, { mtimeMs, size, info });
  return info;
}

const located = new Map();

/** First `<claudeDir>/projects/*\/<sessionId>.jsonl`; the path is cached once found. */
export async function locateTranscript(claudeDir, sessionId) {
  const key = `${claudeDir}\0${sessionId}`;
  if (located.has(key)) {
    const cached = located.get(key);
    try {
      await stat(cached); // the file may have been moved or deleted since
      return cached;
    } catch {
      located.delete(key);
    }
  }
  const root = path.join(claudeDir, 'projects');
  let dirs;
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const candidate = path.join(root, d, `${sessionId}.jsonl`);
    try {
      if ((await stat(candidate)).isFile()) {
        remember(located, key, candidate);
        return candidate;
      }
    } catch {
      // not in this folder
    }
  }
  return null;
}

/** Running calls of the session's subagents. Only files with mtimeMs >= sinceMs - 60 s
 *  are read (sinceMs null: no filter). A missing subagents folder gives []. */
export async function subagentOpenCalls(transcriptFile, sessionId, sinceMs) {
  const dir = path.join(path.dirname(transcriptFile), sessionId, 'subagents');
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/^agent-.*\.jsonl$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (sinceMs !== null && (await stat(file)).mtimeMs < sinceMs - 60000) continue;
      const info = await analyzeTranscript(file, { chain: 'any' });
      out.push(...info.open);
    } catch {
      // file vanished between readdir and read
    }
  }
  return out;
}
