// Copied from agent-colony@7da77bb: src/vscode.mjs
// Changes: English comments; `path`/`knownPaths` renamed `cwd`/`knownCwds` in openSession;
// removed the branch that opens a new window and waits for it (the session is live, a second
// window would start it twice); added socket discovery (the daemon runs outside any VS Code
// terminal) with a cached socket; injectable `deps` so tests start nothing; Windows windows
// (host "windows": no [WSL] tag, link only, one folderless window for the home folder, spec §11).
/* Open a live agent session in VS Code. The only place in the project that starts foreign
 * processes (always `execFile`, never a shell). Three steps, each one needed:
 *
 *   1. `code <folder>` brings the window that already has this folder to the front. Never
 *      with `-r`/`--reuse-window`: that would repurpose a foreign window and lose the session
 *      in it. Without a switch VS Code never repurposes. (Here it only runs after exactly one
 *      window matched, so it cannot open a new one.)
 *   2. `code -s` lists the open windows as `window [n] (<title>)`. The number is the window id
 *      step 3 needs.
 *   3. `vscode://anthropic.claude-code/open?session=<uuid>&windowId=<n>`: the Claude Code
 *      extension registers this UriHandler and opens the session as a tab.
 *
 * Why `windowId` is indispensable (measured 2026-09-14, extension 2.1.270): without it VS Code
 * delivers the URI to an arbitrary window. In the test one project's session landed in a
 * completely different window, restoring failed ("restore_declined") and the extension started
 * a FRESH Claude instance in that window's cwd. With `windowId=<n>` the call hits exactly the
 * intended window. `windowId=_blank` exists, but forces an empty window without WSL remote,
 * where the extension cannot find the session.
 *
 * The remote CLI only works with `VSCODE_IPC_HOOK_CLI` set to a live VS Code socket (F14); the
 * daemon is started by `wsl.exe` and has none, so it picks one itself (spec 7.9).
 */

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { say } from './messages.mjs';

const execFileP = promisify(execFile);

/* `code <folder>` and `wslview` round-trip through wsl.exe to the Windows instance and need
 * one to two seconds under load. */
const CLI_TIMEOUT_MS = 20_000;
/* `code -s` against a socket: a dead socket must fail fast so the next one gets its turn. */
const LIST_TIMEOUT_MS = 8_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* The remote CLI of the WSL server, not `code` from PATH: the daemon runs detached where the
 * PATH of a VS Code terminal is missing. The folder under bin/ carries the commit hash of the
 * VS Code version and changes on every update, hence the newest instead of a fixed path.
 * `vscodeCli` in the config wins over the search. */
async function findCli(cfg) {
  if (cfg?.vscodeCli) return cfg.vscodeCli;
  const base = join(homedir(), '.vscode-server', 'bin');
  let entries = [];
  try {
    entries = await readdir(base);
  } catch {
    throw new Error(say('noVsCodeServer', { base }));
  }
  const found = [];
  for (const e of entries) {
    const cli = join(base, e, 'bin', 'remote-cli', 'code');
    try {
      found.push({ cli, at: (await stat(cli)).mtimeMs });
    } catch {
      // folder without remote-cli (leftover of an old version): skip silently
    }
  }
  if (!found.length) throw new Error(say('noRemoteCli', { base }));
  found.sort((a, b) => b.at - a.at);
  return found[0].cli;
}

/* `vscode-ipc-*.sock` files in the runtime dir, with their mtime. Unreadable ones are skipped. */
async function listSockets() {
  const dir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!/^vscode-ipc-.*\.sock$/.test(n)) continue;
    const p = join(dir, n);
    try {
      out.push({ path: p, mtimeMs: (await stat(p)).mtimeMs });
    } catch {
      // vanished between readdir and stat
    }
  }
  return out;
}

const defaultDeps = {
  run: (file, args, opts) => execFileP(file, args, opts),
  sockets: listSockets,
  findCli,
};

/* Socket paths, newest first. */
function orderSockets(entries) {
  return [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs).map((e) => e.path);
}

/* The socket that worked last time. Dropped when it stops listing windows. */
let cachedSocket = null;

function resetSocketCache() {
  cachedSocket = null;
}

/* Windows as [{ id, title }]. `code -s` also prints the whole process list; only the lines
 * with `window [n] (...)` count. Never throws: a socket that errors or lists no window is dead
 * and gives null. */
async function windowsVia(deps, cli, socket) {
  let stdout;
  try {
    ({ stdout } = await deps.run(cli, ['-s'], {
      env: { ...process.env, VSCODE_IPC_HOOK_CLI: socket },
      timeout: LIST_TIMEOUT_MS,
    }));
  } catch {
    return null;
  }
  const out = [];
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/window \[(\d+)\] \((.*)\)\s*$/);
    if (m) out.push({ id: Number(m[1]), title: m[2] });
  }
  return out.length ? out : null;
}

/* Cached socket first; if it is dead, drop it and try the others newest first. */
async function findWindows(deps, cli) {
  if (cachedSocket) {
    const list = await windowsVia(deps, cli, cachedSocket);
    if (list) return { socket: cachedSocket, list };
  }
  const dead = cachedSocket;
  cachedSocket = null;
  for (const socket of orderSockets(await deps.sockets())) {
    if (socket === dead) continue;
    const list = await windowsVia(deps, cli, socket);
    if (list) {
      cachedSocket = socket;
      return { socket, list };
    }
  }
  throw new Error(say('vscodeUnreachable'));
}

/* All windows whose title matches this folder.
 *
 * The window title is the only information `code -s` gives about a window's content, and it
 * names only the base name of the folder: "<tab> - <folder> [WSL: <distro>] - Visual Studio
 * Code". Hence a list, not a hit: guessing which of two same-named folders is meant pushes a
 * new session onto a foreign project (see header). Decided in pickWindow.
 *
 * A window that has the PARENT folder open counts as "not open".
 *
 * Only WSL windows of our own distro qualify. A window without WSL remote does not see the
 * Linux file system and does not find the session; that is where the wrong fresh session
 * came from in the test. */
function windowsFor(path, distro, list, host = 'wsl') {
  if (host === 'windows') {
    // A Windows window has no [WSL: …] tag (F31 a); a WSL window is never a Windows hit.
    const tail = `${win32.basename(path)} - Visual Studio Code`;
    return list.filter((w) => !w.title.includes('[WSL: ') && (w.title === tail || w.title.endsWith(` - ${tail}`)));
  }
  const tail = `${basename(path)} [WSL: ${distro}] - Visual Studio Code`;
  return list.filter((w) => w.title === tail || w.title.endsWith(` - ${tail}`));
}

/* Same Windows folder? Case and a trailing backslash do not matter on Windows. */
function sameWindowsPath(a, b) {
  const norm = (p) => String(p).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

/* Windows windows that show none of the known Windows folders: a window without a folder
 * ("<tab> - Visual Studio Code", F32, or just "Visual Studio Code" with no editor open), one
 * with a suffix such as "[Administrator]", or one with a folder no session ever ran in. Every
 * Windows window counts, whatever its title looks like: one left out could be the session's
 * own, and then a foreign window would be "the one". More than one means a refusal. */
function folderlessWindows(list, knownPaths) {
  return list.filter((w) => !w.title.includes('[WSL: ')
    && knownPaths.every((k) => windowsFor(k, null, [w], 'windows').length === 0));
}

/* Other known folders with the same base name (on the author's machine e.g.
 * `deployments/production` and `deployments/shared/production`). If they exist, a title hit
 * no longer says which of the two is in the window. */
function twinsOf(path, knownPaths, host = 'wsl') {
  const base = host === 'windows' ? win32.basename : basename;
  const name = base(path);
  return knownPaths.filter((p) => p !== path && base(p) === name);
}

/* Exactly one window, or an error that says why not. */
function pickWindow(path, distro, list, knownPaths, host = 'wsl', home = null) {
  const hits = windowsFor(path, distro, list, host);
  if (!hits.length) {
    // André, 2026-11-17: a session in the Windows home folder may run in a window without a
    // folder; that window is taken only when it is the one such window (spec §11).
    if (host !== 'windows' || !home || !sameWindowsPath(path, home)) return null;
    const free = folderlessWindows(list, knownPaths.filter((k) => !sameWindowsPath(k, home)));
    if (free.length > 1) {
      throw new Error(say('windowsWithoutFolder', { n: free.length }));
    }
    return free[0] ?? null;
  }
  const name = host === 'windows' ? win32.basename(path) : basename(path);
  if (hits.length > 1) {
    throw new Error(say('windowsShowName', { n: hits.length, name }));
  }
  const twins = twinsOf(path, knownPaths, host);
  if (twins.length) {
    throw new Error(say('twinFolders', { name, twins: twins.join(', ') }));
  }
  return hits[0];
}

/* Bring the session's window to the front and open the session as a tab there. Never opens a
 * new window. Returns { window, title }; every failure throws with a German reason. */
async function openSession({ cwd, sessionId, distro, knownCwds = [], cfg, host = 'wsl', home = null }, deps = defaultDeps) {
  if (!UUID.test(sessionId ?? '')) throw new Error('Not a valid session id');
  if (host !== 'windows' && !distro) throw new Error(say('noDistro'));

  const cli = await deps.findCli(cfg);
  const { socket, list } = await findWindows(deps, cli);

  // Check first, then act: with an ambiguous or missing title nothing may happen.
  const win = pickWindow(cwd, distro, list, knownCwds, host, home);
  if (!win) throw new Error(say('windowNotFound'));

  // Without a switch: focuses the existing window (exactly one matches, so no new one opens).
  // On Windows the link alone brings the window up (F32), and the remote CLI would open the
  // folder as a WSL path, so this step is WSL only.
  if (host !== 'windows') {
    await deps.run(cli, [cwd], { env: { ...process.env, VSCODE_IPC_HOOK_CLI: socket }, timeout: CLI_TIMEOUT_MS });
  }

  const uri = `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}&windowId=${win.id}`;
  try {
    await deps.run('wslview', [uri], { timeout: CLI_TIMEOUT_MS });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error(say('noWslview'));
    throw err;
  }

  return { window: win.id, title: win.title };
}

export { defaultDeps, findCli, openSession, orderSockets, pickWindow, resetSocketCache, twinsOf, windowsFor, UUID };
