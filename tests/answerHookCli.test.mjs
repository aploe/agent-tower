// scripts/answer-hook.mjs against made-up settings files in a temp folder. The real
// ~/.claude/settings.json is never touched: every run names its file with --file, and the
// backups go to a temp XDG_STATE_HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceFile } from '../scripts/lib/replaceFile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts/answer-hook.mjs');
// A port nothing listens on, so `status` never talks to a running daemon.
const PORT = '9';
const URL_ = `http://127.0.0.1:${PORT}/api/hook/permission-request`;

const SAMPLE = `${JSON.stringify({
  model: 'demo',
  hooks: {
    PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'bash /opt/demo/status.sh PermissionRequest' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'bash /opt/demo/status.sh Stop' }] }],
  },
}, null, 2)}\n`;

async function sandbox(text = SAMPLE) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-hook-'));
  const file = path.join(dir, 'settings.json');
  if (text !== null) await fs.writeFile(file, text);
  const state = path.join(dir, 'state');
  const env = { ...process.env, XDG_STATE_HOME: state, HOME: path.join(dir, 'home'), TOWER_PORT: PORT };
  const run = (...args) => new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args, '--file', file], { env }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: stdout, err: stderr });
    });
  });
  const backups = async () => {
    try {
      return (await fs.readdir(path.join(state, 'agent-tower', 'backups'))).sort();
    } catch {
      return [];
    }
  };
  const read = () => fs.readFile(file, 'utf8');
  const clean = () => fs.rm(dir, { recursive: true, force: true });
  return { dir, file, state, run, backups, read, clean };
}

const ownHooks = (text) => (JSON.parse(text).hooks?.PermissionRequest ?? [])
  .flatMap((group) => group.hooks).filter((hook) => hook.type === 'http');

test('install adds the entry, keeps the file\'s form, and backs the old file up first', async () => {
  const t = await sandbox();
  try {
    const res = await t.run('install');
    assert.equal(res.code, 0, res.err);
    const text = await t.read();
    assert.deepEqual(ownHooks(text), [{ type: 'http', url: URL_, timeout: 43200 }]);
    assert.equal(text, `${JSON.stringify(JSON.parse(text), null, 2)}\n`); // two spaces, final newline
    assert.equal(JSON.parse(text).hooks.PermissionRequest[0].hooks[0].type, 'command'); // the other tool's hook is still first
    const [backup, ...more] = await t.backups();
    assert.deepEqual(more, []);
    assert.match(backup, /^claude-settings-\d{8}-\d{6}-\d{3}\.json$/);
    assert.equal(await fs.readFile(path.join(t.state, 'agent-tower', 'backups', backup), 'utf8'), SAMPLE);
    assert.match(res.out, /backup/i);
    assert.match(res.out, new RegExp(`127\\.0\\.0\\.1:${PORT}`));
  } finally { await t.clean(); }
});

test('a second install changes nothing and writes no second backup', async () => {
  const t = await sandbox();
  try {
    await t.run('install');
    const once = await t.read();
    const res = await t.run('install');
    assert.equal(res.code, 0);
    assert.match(res.out, /already installed/i);
    assert.equal(await t.read(), once);
    assert.equal((await t.backups()).length, 1);
  } finally { await t.clean(); }
});

test('--dry-run shows the change and writes nothing', async () => {
  const t = await sandbox();
  try {
    const res = await t.run('install', '--dry-run');
    assert.equal(res.code, 0);
    assert.match(res.out, /permission-request/);
    assert.equal(await t.read(), SAMPLE);
    assert.deepEqual(await t.backups(), []);
    await t.run('install');
    const installed = await t.read();
    assert.equal((await t.run('uninstall', '--dry-run')).code, 0);
    assert.equal(await t.read(), installed);
  } finally { await t.clean(); }
});

test('uninstall gives back the settings as they were', async () => {
  const t = await sandbox();
  try {
    await t.run('install');
    const res = await t.run('uninstall');
    assert.equal(res.code, 0, res.err);
    assert.deepEqual(JSON.parse(await t.read()), JSON.parse(SAMPLE));
    assert.equal((await t.backups()).length, 2); // every write has its backup
    assert.match((await t.run('uninstall')).out, /not installed/i);
    assert.equal((await t.backups()).length, 2);
  } finally { await t.clean(); }
});

test('status says whether the hook is in the file', async () => {
  const t = await sandbox();
  try {
    const before = await t.run('status');
    assert.equal(before.code, 0);
    assert.match(before.out, /not installed/i);
    assert.equal(await t.read(), SAMPLE); // status only reads
    await t.run('install');
    const installed = await t.read();
    const after = await t.run(); // status is the default
    assert.match(after.out, /installed/i);
    assert.doesNotMatch(after.out, /not installed/i);
    assert.match(after.out, /43200/);
    assert.match(after.out, /does not answer/); // nothing listens on the test port
    assert.equal(await t.read(), installed);
    assert.equal((await t.backups()).length, 1);
  } finally { await t.clean(); }
});

test('a file that is not valid JSON, or has an odd shape, is left alone with exit code 1', async () => {
  for (const text of ['{nope', '[]', '{"hooks": []}', '{"hooks": {"PermissionRequest": {}}}']) {
    const t = await sandbox(text);
    try {
      for (const command of ['install', 'uninstall']) {
        const res = await t.run(command);
        assert.equal(res.code, 1, `${command} on ${text}`);
        assert.notEqual(res.err.trim(), '');
        assert.equal(await t.read(), text);
      }
      assert.deepEqual(await t.backups(), []);
    } finally { await t.clean(); }
  }
});

test('a missing settings file is created by install; uninstall then leaves an empty object', async () => {
  const t = await sandbox(null);
  try {
    const res = await t.run('install');
    assert.equal(res.code, 0, res.err);
    assert.deepEqual(JSON.parse(await t.read()), { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'http', url: URL_, timeout: 43200 }] }] } });
    assert.deepEqual(await t.backups(), []); // there was nothing to back up
    await t.run('uninstall');
    assert.deepEqual(JSON.parse(await t.read()), {});
  } finally { await t.clean(); }
});

test('a symlinked settings file stays a link and keeps its mode', async () => {
  const t = await sandbox(null);
  try {
    const real = path.join(t.dir, 'dotfiles-settings.json');
    await fs.writeFile(real, SAMPLE, { mode: 0o600 });
    await fs.symlink(real, t.file);
    assert.equal((await t.run('install')).code, 0);
    assert.equal((await fs.lstat(t.file)).isSymbolicLink(), true);
    assert.equal(ownHooks(await fs.readFile(real, 'utf8')).length, 1);
    assert.equal((await fs.stat(real)).mode & 0o777, 0o600);
  } finally { await t.clean(); }
});

test('replaceFile refuses when the file changed since it was read, and leaves no temp file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-replace-'));
  try {
    const file = path.join(dir, 'settings.json');
    await fs.writeFile(file, 'someone else was here\n');
    await assert.rejects(replaceFile(file, { expected: Buffer.from('what we read\n'), text: 'ours\n' }), /changed meanwhile/);
    assert.equal(await fs.readFile(file, 'utf8'), 'someone else was here\n');
    assert.deepEqual(await fs.readdir(dir), ['settings.json']);

    await replaceFile(file, { expected: Buffer.from('someone else was here\n'), text: 'ours\n' });
    assert.equal(await fs.readFile(file, 'utf8'), 'ours\n');
    assert.deepEqual(await fs.readdir(dir), ['settings.json']);

    // expected: null means "there was no file": a file that appeared meanwhile is not overwritten.
    await assert.rejects(replaceFile(file, { expected: null, text: 'again\n' }), /changed meanwhile/);
    const fresh = path.join(dir, 'new.json');
    await replaceFile(fresh, { expected: null, text: '{}\n' });
    assert.equal(await fs.readFile(fresh, 'utf8'), '{}\n');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
