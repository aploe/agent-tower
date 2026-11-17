// Everything the daemon asks of Windows itself (spec §11). Like src/vscode.mjs, a place that
// starts foreign processes: always `execFile`, never a shell, and every value that goes into a
// command is validated first.
//
// Liveness of Windows sessions: the registry entry's `procStart` is the process start time as a
// FILETIME (F27). /proc does not see Windows processes and `tasklist.exe` has no start time, so
// one PowerShell `Get-Process` call asks for all candidate PIDs at once. It costs about 0.4 s
// (F31 c), hence the cache: one query per `ttlMs`, and an early one when a PID shows up that the
// last query did not cover, so a new session is listed at the next poll.
//
// `Get-Process` exits 1 when none of the ids exists (F31 c). The script therefore ends with
// `exit 0`: a non-zero exit then means PowerShell itself failed, which reads as "unknown" (null),
// while an empty answer means "none alive".
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { say } from './messages.mjs';

export const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
/** The desktop app's own session id, as its claude:// handler accepts it (F30). */
export const DESKTOP_ID = /^local_[A-Za-z0-9-]{1,64}$/;

/* The query takes about 0.4 s (F31 c). The snapshot waits for it, so a hanging PowerShell must
 * not hold the WSL rows for long: a short budget, and after a failure a long pause. */
const QUERY_TIMEOUT_MS = 3_000;
const FAIL_TTL_MS = 30_000;

/* Get-Process binds ids to Int32; one id beyond that fails the whole call (exit 0, no output),
 * which would read as "every Windows session ended". */
const validPid = (p) => Number.isInteger(p) && p > 0 && p <= 0x7fffffff;

export function startTimesScript(pids) {
  return `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTimeUtc() }; exit 0`;
}

export function parseStartTimes(stdout) {
  const out = new Map();
  for (const line of String(stdout).split(/\r?\n/)) {
    const m = line.trim().match(/^(\d+) (\d+)$/);
    if (m) out.set(Number(m[1]), m[2]);
  }
  return out;
}

/** (pids) => Promise<Map pid -> FILETIME string | null>. null: PowerShell could not answer. */
export function createStartTimeCheck({ run = promisify(execFile), ttlMs = 5000, now = Date.now } = {}) {
  let cache = null; // { at, asked: Set<number>, result: Map | null }

  return async (pids) => {
    const wanted = [...new Set(pids.filter(validPid))];
    if (!wanted.length) return new Map();
    const age = cache ? now() - cache.at : Infinity;
    const fresh = cache && (cache.result === null
      ? age < FAIL_TTL_MS // failed: no new attempt for a while, not even for a new PID
      : age < ttlMs && wanted.every((p) => cache.asked.has(p)));
    if (!fresh) {
      let result;
      try {
        const { stdout } = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', startTimesScript(wanted)], {
          timeout: QUERY_TIMEOUT_MS,
        });
        result = parseStartTimes(stdout);
      } catch {
        result = null;
      }
      cache = { at: now(), asked: new Set(wanted), result };
    }
    if (cache.result === null) return null;
    return new Map(wanted.filter((p) => cache.result.has(p)).map((p) => [p, cache.result.get(p)]));
  };
}

/** `/mnt/c/Users/sam` → `C:\Users\sam`; null for a path outside a /mnt drive. */
export function windowsPathOf(wslPath) {
  const m = /^\/mnt\/([a-z])(\/.*)?$/.exec(wslPath ?? '');
  if (!m) return null;
  return `${m[1].toUpperCase()}:${(m[2] ?? '/').replaceAll('/', '\\')}`;
}

/** The daemon's shared check: one cache for every snapshot. */
export const windowsStartTimes = createStartTimeCheck();

/* Same budget as the VS Code opener: `wslview` round-trips through PowerShell. */
const LINK_TIMEOUT_MS = 20_000;

/** Bring the desktop app to the front on one local session (F30). The handler only navigates
 *  to a session it knows and starts nothing. `wslview` hands the link to PowerShell's `Start`
 *  (F31 d). The id is checked here even though the snapshot already checked it: this is the
 *  line that builds the link. */
export async function openDesktopSession({ hostSessionId }, deps = { run: promisify(execFile) }) {
  if (!DESKTOP_ID.test(hostSessionId ?? '')) throw new Error('Not a valid desktop session id');
  const url = `claude://code/continue?session=${hostSessionId}`;
  try {
    await deps.run('wslview', [url], { timeout: LINK_TIMEOUT_MS });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(say('noWslview'));
    throw err;
  }
  return { url };
}
