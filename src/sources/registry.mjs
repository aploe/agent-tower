// Copied from agent-colony@7da77bb: src/sources/liveSessions.mjs
// Changed: renamed to registry.mjs; reads <cfg.claudeDir>/sessions; root, origin and liveness check are parameters (spec §11);
// returns full RegistryEntry objects (status, name, entrypoint, ...) plus knownCwds;
// statusUpdatedAt (epoch ms) becomes statusUpdatedAtMs; comments translated to English.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Registry of running Claude Code processes: `<claudeDir>/sessions/<pid>.json`.
 *
 *  A file alone proves nothing: killed processes leave theirs behind. The proof is the
 *  process start time: PID alive and start time equal to `procStart` means the same process,
 *  not a reused PID. In WSL that is field 22 of /proc/<pid>/stat (ticks since boot, below);
 *  on Windows it is the FILETIME from PowerShell (src/windows.mjs, spec F27). */

/** Field 22 (starttime) of <procRoot>/<pid>/stat, or null if the process is gone.
 *  Field 2 is the process name in parentheses and may contain spaces, so count behind the
 *  LAST ')'; field 3 starts there. A zombie (field 3 = 'Z') counts as gone. */
async function procStartOf(procRoot, pid) {
  let text;
  try {
    text = await readFile(join(procRoot, String(pid), 'stat'), 'utf8');
  } catch {
    return null;
  }
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(' ');
  if (fields[0] === 'Z') return null;
  return fields[19] ?? null;
}

function isoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The WSL liveness check: start times of the given PIDs from <procRoot>; gone ones are absent. */
function procStartTimes(procRoot) {
  return async (pids) => {
    const out = new Map();
    await Promise.all(pids.map(async (pid) => {
      const start = await procStartOf(procRoot, pid);
      if (start !== null) out.set(pid, start);
    }));
    return out;
  };
}

/** Live sessions as Map sessionId -> RegistryEntry, plus the distinct cwd of every
 *  parseable file (live or dead). `null` if the sessions folder cannot be read or the
 *  liveness check cannot answer. `startTimes(pids)` resolves Map pid -> start time (or null
 *  for "unknown"); it is called once, with every candidate, and not at all without one. */
export async function loadRegistry(cfg, { claudeDir = cfg.claudeDir, origin = 'wsl', procRoot = '/proc', startTimes } = {}) {
  const dir = join(claudeDir, 'sessions');
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }

  const cwds = new Set();
  const candidates = [];
  await Promise.all(
    names
      .filter((n) => /^\d+\.json$/.test(n))
      .map(async (n) => {
        let rec;
        try {
          rec = JSON.parse(await readFile(join(dir, n), 'utf8'));
        } catch {
          return; // half-written, vanished, or not JSON
        }
        if (!rec || typeof rec !== 'object' || !rec.sessionId) return;
        if (typeof rec.cwd === 'string' && rec.cwd) cwds.add(rec.cwd);
        if (!rec.pid || !rec.procStart) return;
        candidates.push(rec);
      }),
  );

  const live = new Map();
  if (candidates.length) {
    const times = await (startTimes ?? procStartTimes(procRoot))(candidates.map((r) => r.pid));
    if (times === null) return null;
    for (const rec of candidates) {
      if (times.get(rec.pid) !== String(rec.procStart)) continue;
      // A --resume'd session has a dead and a live entry with one sessionId; only the
      // live one gets here, so order does not matter.
      live.set(rec.sessionId, {
        pid: rec.pid,
        sessionId: rec.sessionId,
        cwd: rec.cwd ?? null,
        startedAt: isoOrNull(rec.startedAt),
        kind: rec.kind ?? null,
        entrypoint: rec.entrypoint ?? null,
        name: rec.name ?? null,
        nameSource: rec.nameSource ?? null,
        status: rec.status ?? null,
        statusUpdatedAtMs: Number.isFinite(rec.statusUpdatedAt) ? rec.statusUpdatedAt : null,
        waitingFor: rec.waitingFor ?? null,
        origin,
        hostSessionId: typeof rec.hostSessionId === 'string' ? rec.hostSessionId : null,
      });
    }
  }
  return { live, knownCwds: [...cwds] };
}
