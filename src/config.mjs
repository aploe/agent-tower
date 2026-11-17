// Config loader: config/tower.config.json merged with the optional config/tower.local.json,
// then the environment fills the nulls and --port / TOWER_PORT override the port.
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

async function readJson(file, { optional = false } = {}) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (optional && err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: ${err.message}`);
  }
}

function expandHome(value, home) {
  if (value === '~') return home;
  if (value.startsWith('~/')) return path.join(home, value.slice(2));
  return value;
}

/** `~` expands with HOME, a relative path resolves against the repo root. */
function absolute(value, { home, root }) {
  return path.resolve(root, expandHome(value, home));
}

function parsePort(raw, origin) {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port from ${origin}: ${raw}`);
  }
  return port;
}

function portOverride(argv, env) {
  const i = argv.indexOf('--port');
  if (i !== -1) return parsePort(argv[i + 1], '--port');
  if (env.TOWER_PORT !== undefined && env.TOWER_PORT !== '') return parsePort(env.TOWER_PORT, 'TOWER_PORT');
  return null;
}

/** The Windows `.claude` folder seen from WSL (spec §11): the one user folder under `usersRoot`
 *  that has `.claude/sessions`. Zero or several candidates give null; the user then sets
 *  `windowsClaudeDir` in `config/tower.local.json`. */
export async function findWindowsClaudeDir(usersRoot) {
  let names;
  try {
    names = await readdir(usersRoot);
  } catch {
    return null;
  }
  const hits = [];
  for (const n of names) {
    const dir = path.join(usersRoot, n, '.claude');
    try {
      if ((await stat(path.join(dir, 'sessions'))).isDirectory()) hits.push(dir);
    } catch {
      // no .claude here, or not readable: not a candidate
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

/** null: look for it; false: off; a string: that folder. */
async function windowsClaudeDirOf(value, at, usersRoot) {
  if (value === false) return null;
  if (typeof value === 'string' && value) return absolute(value, at);
  return findWindowsClaudeDir(usersRoot);
}

/** VS Code's global state on Windows (F34): null derives it from the Windows `.claude` folder,
 *  false is off, a string is that file. */
function vscodeStateDbOf(value, at, windowsClaudeDir) {
  if (value === false) return null;
  if (typeof value === 'string' && value) return absolute(value, at);
  if (!windowsClaudeDir) return null;
  return path.join(path.dirname(windowsClaudeDir), 'AppData/Roaming/Code/User/globalStorage/state.vscdb');
}

export async function loadConfig({ root, env = process.env, argv = process.argv, windowsUsersRoot = '/mnt/c/Users' }) {
  const base = await readJson(path.join(root, 'config/tower.config.json'));
  const local = (await readJson(path.join(root, 'config/tower.local.json'), { optional: true })) ?? {};
  const merged = { ...base, ...local, fallback: { ...base.fallback, ...local.fallback } };

  const home = env.HOME ?? homedir();
  const at = { home, root };
  const runtimeDir = env.XDG_RUNTIME_DIR || '/tmp';
  const stateHome = env.XDG_STATE_HOME || path.join(home, '.local/state');

  const windowsClaudeDir = await windowsClaudeDirOf(merged.windowsClaudeDir ?? null, at, windowsUsersRoot);
  return {
    host: merged.host,
    port: portOverride(argv, env) ?? parsePort(merged.port, 'config'),
    pollMs: merged.pollMs,
    idleAfterMinutes: merged.idleAfterMinutes,
    promptAfterSeconds: merged.promptAfterSeconds,
    claudeDir: absolute(merged.claudeDir, at),
    windowsClaudeDir,
    vscodeStateDb: vscodeStateDbOf(merged.vscodeStateDb ?? null, at, windowsClaudeDir),
    colonyHookDir: merged.colonyHookDir ? absolute(merged.colonyHookDir, at) : path.join(runtimeDir, 'agent-colony'),
    stateDir: merged.stateDir ? absolute(merged.stateDir, at) : path.join(stateHome, 'agent-tower'),
    vscodeCli: merged.vscodeCli ? absolute(merged.vscodeCli, at) : null,
    wslDistro: merged.wslDistro ?? env.WSL_DISTRO_NAME ?? null,
    fallback: merged.fallback,
  };
}
