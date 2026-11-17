// Copied from agent-colony@7da77bb: src/sources/hookStatus.mjs
// Changed: renamed to loadColonyHook, reads cfg.colonyHookDir, returns sinceMs
// (parseMs) instead of the since string, dropped the subagent counting and the
// CLI entry point.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMs } from '../fallbackState.mjs';

/** What the sessions say about their own state, via the hook status files
 *  Colony's hook writes (one tiny JSON per session id).
 *
 *  Not checked here: whether the process behind a session id is still alive.
 *  A killed window leaves a "working" entry behind; the caller drops it.
 *
 *  `null` instead of an empty map when the folder is unreadable: empty would
 *  mean "nobody works", unknown means "ask the fallback". */

// The four words of the map (R24).
const STATES = new Set(['working', 'prompt', 'waiting', 'idle']);

export async function loadColonyHook(cfg) {
  const dir = cfg.colonyHookDir;

  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null; // hook not installed, or tmpfs empty after a reboot
  }

  const out = new Map();
  await Promise.all(
    names
      .filter((n) => n.endsWith('.json') && !n.startsWith('.'))
      .map(async (n) => {
        let rec;
        try {
          rec = JSON.parse(await readFile(join(dir, n), 'utf8'));
        } catch {
          return; // half written or just replaced; the next poll has it
        }
        if (!rec || !rec.sessionId || !STATES.has(rec.status)) return;
        out.set(rec.sessionId, { status: rec.status, sinceMs: parseMs(rec.since) });
      }),
  );
  return out;
}
