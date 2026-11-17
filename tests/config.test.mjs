import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A temp root holding a copy of the checked-in config, plus an optional local file. */
async function makeRoot(localText) {
  const root = await mkdtemp(path.join(tmpdir(), 'tower-config-'));
  await mkdir(path.join(root, 'config'));
  await copyFile(path.join(REPO, 'config/tower.config.json'), path.join(root, 'config/tower.config.json'));
  if (localText !== undefined) await writeFile(path.join(root, 'config/tower.local.json'), localText);
  return root;
}

test('defaults', async () => {
  const root = await makeRoot();
  const cfg = await loadConfig({ root, env: { HOME: '/home/u' }, argv: [] });
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.port, 4188);
  assert.equal(cfg.pollMs, 1000);
  assert.equal(cfg.idleAfterMinutes, 240);
  assert.equal(cfg.promptAfterSeconds, 60);
  assert.equal(cfg.claudeDir, '/home/u/.claude');
  assert.equal(cfg.colonyHookDir, '/tmp/agent-colony');
  assert.equal(cfg.stateDir, '/home/u/.local/state/agent-tower');
  assert.equal(cfg.vscodeCli, null);
  assert.equal(cfg.wslDistro, null);
  assert.deepEqual(cfg.fallback, { workingMinutes: 3, promptMinutes: 1, waitingMinutes: 90 });
});

test('environment fills the nulls', async () => {
  const root = await makeRoot();
  const cfg = await loadConfig({
    root,
    argv: [],
    env: { HOME: '/home/u', XDG_RUNTIME_DIR: '/run/user/1000', XDG_STATE_HOME: '/s', WSL_DISTRO_NAME: 'Ubuntu' },
  });
  assert.equal(cfg.colonyHookDir, '/run/user/1000/agent-colony');
  assert.equal(cfg.stateDir, '/s/agent-tower');
  assert.equal(cfg.wslDistro, 'Ubuntu');
});

test('local file overrides top-level keys, fallback merges per key', async () => {
  const root = await makeRoot(JSON.stringify({ port: 4200, fallback: { waitingMinutes: 30 } }));
  const cfg = await loadConfig({ root, env: { HOME: '/h' }, argv: [] });
  assert.equal(cfg.port, 4200);
  assert.deepEqual(cfg.fallback, { workingMinutes: 3, promptMinutes: 1, waitingMinutes: 30 });
});

test('configured paths expand ~ and resolve to absolute paths', async () => {
  const root = await makeRoot(JSON.stringify({ claudeDir: 'data/claude', colonyHookDir: '~/hooks', wslDistro: 'Debian' }));
  const cfg = await loadConfig({ root, env: { HOME: '/h', WSL_DISTRO_NAME: 'Ubuntu' }, argv: [] });
  assert.equal(cfg.claudeDir, path.join(root, 'data/claude'));
  assert.equal(cfg.colonyHookDir, '/h/hooks');
  assert.equal(cfg.wslDistro, 'Debian');
});

test('port precedence: --port, then TOWER_PORT, then config', async () => {
  const root = await makeRoot();
  assert.equal((await loadConfig({ root, env: { HOME: '/h', TOWER_PORT: '4300' }, argv: ['--port', '0'] })).port, 0);
  assert.equal((await loadConfig({ root, env: { HOME: '/h', TOWER_PORT: '4300' }, argv: [] })).port, 4300);
  assert.equal((await loadConfig({ root, env: { HOME: '/h' }, argv: ['node', 'server.mjs', '--port', '4400'] })).port, 4400);
});

test('an invalid port is refused', async () => {
  const root = await makeRoot();
  await assert.rejects(loadConfig({ root, env: { HOME: '/h' }, argv: ['--port', 'abc'] }), /port/);
  await assert.rejects(loadConfig({ root, env: { HOME: '/h', TOWER_PORT: '70000' }, argv: [] }), /port/);
});

test('a missing local file is normal; invalid JSON in it throws an error that names the file', async () => {
  const fine = await makeRoot();
  await assert.doesNotReject(loadConfig({ root: fine, env: { HOME: '/h' }, argv: [] }));
  const broken = await makeRoot('{ "port": ');
  await assert.rejects(
    loadConfig({ root: broken, env: { HOME: '/h' }, argv: [] }),
    (err) => err.message.startsWith(path.join(broken, 'config/tower.local.json') + ': '),
  );
});

async function usersRoot(names) {
  const r = await mkdtemp(path.join(tmpdir(), 'tower-users-'));
  for (const n of names) await mkdir(path.join(r, n, '.claude', 'sessions'), { recursive: true });
  await mkdir(path.join(r, 'Public')); // no .claude: never a candidate
  return r;
}

test('windowsClaudeDir null finds the one Windows user with a sessions folder', async () => {
  const root = await makeRoot();
  const users = await usersRoot(['sam']);
  const cfg = await loadConfig({ root, env: { HOME: '/home/u' }, argv: [], windowsUsersRoot: users });
  assert.equal(cfg.windowsClaudeDir, path.join(users, 'sam', '.claude'));
});

test('windowsClaudeDir null with no candidate, two candidates or no users folder is null', async () => {
  const root = await makeRoot();
  for (const users of [await usersRoot([]), await usersRoot(['a', 'b']), '/nonexistent/Users']) {
    const cfg = await loadConfig({ root, env: { HOME: '/home/u' }, argv: [], windowsUsersRoot: users });
    assert.equal(cfg.windowsClaudeDir, null, users);
  }
});

test('windowsClaudeDir false is off, a string is taken as is', async () => {
  const users = await usersRoot(['sam']);
  const off = await loadConfig({ root: await makeRoot('{"windowsClaudeDir":false}'), env: { HOME: '/home/u' }, argv: [], windowsUsersRoot: users });
  assert.equal(off.windowsClaudeDir, null);
  const set = await loadConfig({ root: await makeRoot('{"windowsClaudeDir":"/mnt/x/.claude"}'), env: { HOME: '/home/u' }, argv: [], windowsUsersRoot: users });
  assert.equal(set.windowsClaudeDir, '/mnt/x/.claude');
});

test('vscodeStateDb null sits next to the Windows .claude folder; false is off, a string is taken as is', async () => {
  const users = await usersRoot(['sam']);
  const found = await loadConfig({ root: await makeRoot(), env: { HOME: '/home/u' }, argv: [], windowsUsersRoot: users });
  assert.equal(found.vscodeStateDb, path.join(users, 'sam', 'AppData/Roaming/Code/User/globalStorage/state.vscdb'));
  const noWindows = await loadConfig({ root: await makeRoot(), env: { HOME: '/home/u' }, argv: [], windowsUsersRoot: '/nonexistent/Users' });
  assert.equal(noWindows.vscodeStateDb, null);
  const off = await loadConfig({ root: await makeRoot('{"vscodeStateDb":false}'), env: { HOME: '/home/u' }, argv: [], windowsUsersRoot: users });
  assert.equal(off.vscodeStateDb, null);
  const set = await loadConfig({ root: await makeRoot('{"vscodeStateDb":"/mnt/x/state.vscdb"}'), env: { HOME: '/home/u' }, argv: [], windowsUsersRoot: users });
  assert.equal(set.vscodeStateDb, '/mnt/x/state.vscdb');
});
