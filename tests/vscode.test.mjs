// Copied from agent-colony@7da77bb: tests/vscodeWindows.test.mjs
// Changes: path/knownPaths naming kept for pickWindow; English test names for the new cases;
// added orderSockets and openSession cases with a fake `deps` (nothing real is started).
/* Window choice from `code -s`: pure functions of their input, so fixtures. The titles come
 * from real runs on 2026-09-14. What matters is the refusal, not the hit: a wrongly chosen
 * window pushes a fresh Claude instance onto a foreign project. */
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { openSession, orderSockets, pickWindow, resetSocketCache, twinsOf, windowsFor } from '../src/vscode.mjs';

const LIST = [
  { id: 11, title: 'Weekly report flow… - automation [WSL: Ubuntu] - Visual Studio Code' },
  { id: 4, title: '● Ich möchte … • Untitled-1 - Visual Studio Code' },
  { id: 10, title: 'Agent sessions anklickba… - agent-colony [WSL: Ubuntu] - Visual Studio Code' },
];

test('findet das Fenster mit dem Ordner im Titel', () => {
  const hits = windowsFor('/home/user/projects/agent-colony', 'Ubuntu', LIST);
  assert.deepEqual(hits.map((w) => w.id), [10]);
});

test('Fenster ohne Tab im Titel zaehlt ebenfalls', () => {
  const list = [{ id: 7, title: 'agent-colony [WSL: Ubuntu] - Visual Studio Code' }];
  assert.deepEqual(windowsFor('/x/agent-colony', 'Ubuntu', list).map((w) => w.id), [7]);
});

test('ein Fenster ohne WSL-Remote kommt nie in Frage', () => {
  const list = [{ id: 4, title: 'x - agent-colony - Visual Studio Code' }];
  assert.deepEqual(windowsFor('/x/agent-colony', 'Ubuntu', list), []);
});

test('eine fremde Distro kommt nie in Frage', () => {
  assert.deepEqual(windowsFor('/x/automation', 'Debian', LIST), []);
});

test('ein Praefix des Ordnernamens trifft nicht', () => {
  const list = [{ id: 3, title: 'a - mein-agent-colony [WSL: Ubuntu] - Visual Studio Code' }];
  assert.deepEqual(windowsFor('/x/agent-colony', 'Ubuntu', list), []);
});

test('kein Fenster: null, damit der Aufrufer es melden kann', () => {
  assert.equal(pickWindow('/x/frisch', 'Ubuntu', LIST, []), null);
});

test('zwei Fenster gleichen Namens: lieber gar nichts', () => {
  const list = [
    { id: 1, title: 'a - production [WSL: Ubuntu] - Visual Studio Code' },
    { id: 2, title: 'b - production [WSL: Ubuntu] - Visual Studio Code' },
  ];
  assert.throws(() => pickWindow('/c/deployments/production', 'Ubuntu', list, []), /2 Fenster/);
});

test('ein Treffer, aber der Name ist auf der Karte doppelt: lieber gar nichts', () => {
  const list = [{ id: 1, title: 'a - production [WSL: Ubuntu] - Visual Studio Code' }];
  assert.throws(
    () =>
      pickWindow('/c/deployments/production', 'Ubuntu', list, [
        '/c/deployments/production',
        '/c/deployments/shared/production',
      ]),
    /so heisst auch/,
  );
});

test('Zwillinge stoeren nur, wenn ein Fenster offen ist', () => {
  assert.equal(
    pickWindow('/c/deployments/production', 'Ubuntu', [], [
      '/c/deployments/production',
      '/c/deployments/shared/production',
    ]),
    null,
  );
});

test('twinsOf nennt nur die anderen', () => {
  assert.deepEqual(twinsOf('/a/production', ['/a/production', '/b/production', '/c/x']), ['/b/production']);
});

// ---- openSession with fake deps ----

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SOCK_NEW = '/run/user/1000/vscode-ipc-new.sock';
const SOCK_OLD = '/run/user/1000/vscode-ipc-old.sock';
const WIN_TITLE = 'x - agent-tower [WSL: Ubuntu] - Visual Studio Code';

/** `code -s` output: process noise plus window lines, like the real one. */
function listing(windows) {
  const lines = ['CPU %  Mem MB  PID  Process', '  0  50  123  code main'];
  for (const w of windows) lines.push(`    window [${w.id}] (${w.title})`);
  return lines.join('\n');
}

/**
 * Fake deps. `byWindows` maps a socket path to its windows; a socket missing from the
 * map throws like a dead socket. `calls` records every run.
 */
function fake({ sockets = [], byWindows = {}, wslviewError = null } = {}) {
  const calls = [];
  const deps = {
    sockets: async () => sockets,
    findCli: async () => '/fake/code',
    run: async (file, args, opts = {}) => {
      const socket = opts.env?.VSCODE_IPC_HOOK_CLI;
      calls.push({ file, args, socket });
      if (file === 'wslview') {
        if (wslviewError) throw wslviewError;
        return { stdout: '' };
      }
      if (!(socket in byWindows)) throw new Error('connect ECONNREFUSED');
      if (args[0] === '-s') return { stdout: listing(byWindows[socket]) };
      return { stdout: '' };
    },
  };
  return { deps, calls };
}

const args = {
  cwd: '/home/u/agent-tower',
  sessionId: ID,
  distro: 'Ubuntu',
  knownCwds: ['/home/u/agent-tower'],
  cfg: {},
};

beforeEach(() => resetSocketCache());

test('orderSockets: newest first', () => {
  const out = orderSockets([
    { path: 'a', mtimeMs: 1 },
    { path: 'c', mtimeMs: 3 },
    { path: 'b', mtimeMs: 2 },
  ]);
  assert.deepEqual(out, ['c', 'b', 'a']);
});

test('invalid session id: no run at all', async () => {
  const { deps, calls } = fake({ sockets: [{ path: SOCK_NEW, mtimeMs: 2 }], byWindows: { [SOCK_NEW]: [] } });
  await assert.rejects(openSession({ ...args, sessionId: 'nope' }, deps), /keine gültige Session-ID/);
  assert.equal(calls.length, 0);
});

test('missing distro: throws before any run', async () => {
  const { deps, calls } = fake({ sockets: [{ path: SOCK_NEW, mtimeMs: 2 }] });
  await assert.rejects(openSession({ ...args, distro: null }, deps), /keine WSL-Distro bekannt \(config\.wslDistro\)/);
  assert.equal(calls.length, 0);
});

test('no socket answers: VS Code nicht erreichbar', async () => {
  const { deps, calls } = fake({ sockets: [{ path: SOCK_NEW, mtimeMs: 2 }, { path: SOCK_OLD, mtimeMs: 1 }] });
  await assert.rejects(openSession(args, deps), /VS Code nicht erreichbar/);
  assert.equal(calls.some((c) => c.file === 'wslview'), false);
});

test('no socket files at all: VS Code nicht erreichbar', async () => {
  const { deps } = fake({ sockets: [] });
  await assert.rejects(openSession(args, deps), /VS Code nicht erreichbar/);
});

test('a socket that lists no window line counts as dead', async () => {
  const { deps } = fake({
    sockets: [{ path: SOCK_NEW, mtimeMs: 2 }, { path: SOCK_OLD, mtimeMs: 1 }],
    byWindows: { [SOCK_NEW]: [], [SOCK_OLD]: [{ id: 7, title: WIN_TITLE }] },
  });
  const res = await openSession(args, deps);
  assert.equal(res.window, 7);
});

test('a dead socket is skipped, the next one is used for every following call', async () => {
  const { deps, calls } = fake({
    sockets: [{ path: SOCK_NEW, mtimeMs: 2 }, { path: SOCK_OLD, mtimeMs: 1 }],
    byWindows: { [SOCK_OLD]: [{ id: 7, title: WIN_TITLE }] },
  });
  await openSession(args, deps);
  assert.equal(calls[0].socket, SOCK_NEW); // newest tried first, dead
  assert.equal(calls[1].socket, SOCK_OLD);
  calls.length = 0;
  await openSession(args, deps);
  assert.equal(calls[0].socket, SOCK_OLD); // remembered
  assert.equal(calls.filter((c) => c.socket === SOCK_NEW).length, 0);
});

test('a cached socket that died is dropped and the others are tried newest first', async () => {
  const sockets = [{ path: SOCK_NEW, mtimeMs: 2 }, { path: SOCK_OLD, mtimeMs: 1 }];
  const byWindows = { [SOCK_OLD]: [{ id: 7, title: WIN_TITLE }] };
  const { deps, calls } = fake({ sockets, byWindows });
  await openSession(args, deps); // caches SOCK_OLD
  delete byWindows[SOCK_OLD];
  byWindows[SOCK_NEW] = [{ id: 9, title: WIN_TITLE }];
  calls.length = 0;
  const res = await openSession(args, deps);
  assert.equal(calls[0].socket, SOCK_OLD);
  assert.equal(calls[1].socket, SOCK_NEW);
  assert.equal(res.window, 9);
});

test('code -s runs with the socket in VSCODE_IPC_HOOK_CLI and a timeout', async () => {
  let seen;
  const { deps } = fake({ sockets: [{ path: SOCK_NEW, mtimeMs: 2 }], byWindows: { [SOCK_NEW]: [{ id: 7, title: WIN_TITLE }] } });
  const inner = deps.run;
  deps.run = async (file, a, opts) => {
    if (a[0] === '-s') seen = opts;
    return inner(file, a, opts);
  };
  await openSession(args, deps);
  assert.equal(seen.env.VSCODE_IPC_HOOK_CLI, SOCK_NEW);
  assert.equal(seen.timeout, 8000);
});

test('no matching window: refuses and never runs code <cwd>', async () => {
  const { deps, calls } = fake({
    sockets: [{ path: SOCK_NEW, mtimeMs: 2 }],
    byWindows: { [SOCK_NEW]: [{ id: 3, title: 'a - other [WSL: Ubuntu] - Visual Studio Code' }] },
  });
  await assert.rejects(
    openSession(args, deps),
    /Fenster nicht gefunden: der Ordner ist in keinem VS-Code-Fenster offen/,
  );
  assert.equal(calls.some((c) => c.args[0] === args.cwd), false);
  assert.equal(calls.some((c) => c.file === 'wslview'), false);
});

test('ambiguous windows: the pickWindow error passes through, nothing is opened', async () => {
  const { deps, calls } = fake({
    sockets: [{ path: SOCK_NEW, mtimeMs: 2 }],
    byWindows: {
      [SOCK_NEW]: [
        { id: 1, title: 'a - agent-tower [WSL: Ubuntu] - Visual Studio Code' },
        { id: 2, title: 'b - agent-tower [WSL: Ubuntu] - Visual Studio Code' },
      ],
    },
  });
  await assert.rejects(openSession(args, deps), /2 Fenster/);
  assert.equal(calls.some((c) => c.args[0] === args.cwd || c.file === 'wslview'), false);
});

test('twin folder: the pickWindow error passes through', async () => {
  const { deps, calls } = fake({
    sockets: [{ path: SOCK_NEW, mtimeMs: 2 }],
    byWindows: { [SOCK_NEW]: [{ id: 7, title: WIN_TITLE }] },
  });
  await assert.rejects(
    openSession({ ...args, knownCwds: [args.cwd, '/other/agent-tower'] }, deps),
    /so heisst auch/,
  );
  assert.equal(calls.some((c) => c.file === 'wslview'), false);
});

test('one match: focuses the window, then launches the URI with its window id', async () => {
  const { deps, calls } = fake({
    sockets: [{ path: SOCK_NEW, mtimeMs: 2 }],
    byWindows: { [SOCK_NEW]: [{ id: 7, title: WIN_TITLE }] },
  });
  const res = await openSession(args, deps);
  assert.deepEqual(res, { window: 7, title: WIN_TITLE });
  const focus = calls.find((c) => c.args[0] === args.cwd);
  assert.deepEqual(focus.args, [args.cwd]); // no -r / --reuse-window
  assert.equal(focus.socket, SOCK_NEW);
  const last = calls.at(-1);
  assert.deepEqual({ file: last.file, args: last.args }, {
    file: 'wslview',
    args: ['vscode://anthropic.claude-code/open?session=' + ID + '&windowId=7'],
  });
  assert.ok(calls.indexOf(focus) < calls.length - 1);
});

test('wslview missing: reports the package', async () => {
  const err = Object.assign(new Error('spawn wslview ENOENT'), { code: 'ENOENT' });
  const { deps } = fake({
    sockets: [{ path: SOCK_NEW, mtimeMs: 2 }],
    byWindows: { [SOCK_NEW]: [{ id: 7, title: WIN_TITLE }] },
    wslviewError: err,
  });
  await assert.rejects(openSession(args, deps), /wslview fehlt \(Paket wslu\)/);
});

// ---- VS Code on Windows (spec §11, F32) ----

const WIN_LIST = [
  { id: 6, title: 'Notizen - Visual Studio Code' }, // no folder open
  { id: 8, title: 'Plan - notes - Visual Studio Code' },
  { id: 5, title: 'Plan - notes [WSL: Ubuntu] - Visual Studio Code' },
];
const HOME = 'C:\\Users\\sam';

test('windowsFor on Windows matches "<tab> - <folder> - Visual Studio Code" and never a WSL window', () => {
  assert.deepEqual(windowsFor('C:\\Users\\sam\\notes', null, WIN_LIST, 'windows').map((w) => w.id), [8]);
  assert.deepEqual(windowsFor('C:\\Users\\sam', null, WIN_LIST, 'windows'), []);
  assert.deepEqual(windowsFor('/home/u/notes', 'Ubuntu', WIN_LIST).map((w) => w.id), [5]); // WSL unchanged
});

test('a home-folder session goes to the one Windows window that shows no known folder', () => {
  const known = [HOME, 'C:\\Users\\sam\\notes'];
  assert.equal(pickWindow(HOME, null, WIN_LIST, known, 'windows', HOME).id, 6);
  assert.equal(pickWindow('c:\\users\\SAM\\', null, WIN_LIST, known, 'windows', HOME).id, 6); // same folder, other spelling
});

test('two Windows windows without a known folder: refusal, not a guess', () => {
  const list = [...WIN_LIST, { id: 9, title: 'Fotos - Visual Studio Code' }];
  assert.throws(() => pickWindow(HOME, null, list, [HOME, 'C:\\Users\\sam\\notes'], 'windows', HOME), /2 Fenster ohne Ordner/);
});

test('the folderless rule is only for the home folder', () => {
  assert.equal(pickWindow('C:\\Users\\sam\\fotos', null, WIN_LIST, [HOME], 'windows', HOME), null);
  assert.equal(pickWindow(HOME, null, WIN_LIST, [HOME], 'windows', null), null); // home unknown: no rule
});

test('Windows twins compare the Windows base name', () => {
  assert.deepEqual(twinsOf('C:\\a\\notes', ['C:\\a\\notes', 'D:\\b\\notes', 'C:\\c\\other'], 'windows'), ['D:\\b\\notes']);
});

const winArgs = { cwd: 'C:\\Users\\sam\\notes', sessionId: ID, distro: null, knownCwds: ['C:\\Users\\sam\\notes'], cfg: {}, host: 'windows', home: HOME };

test('openSession on Windows sends only the link with the window id: no folder step, no distro needed', async () => {
  const { deps, calls } = fake({ sockets: [{ path: SOCK_NEW, mtimeMs: 2 }], byWindows: { [SOCK_NEW]: WIN_LIST } });
  const res = await openSession(winArgs, deps);
  assert.deepEqual(res, { window: 8, title: 'Plan - notes - Visual Studio Code' });
  assert.deepEqual(calls.map((c) => [c.file, c.args]), [
    ['/fake/code', ['-s']],
    ['wslview', [`vscode://anthropic.claude-code/open?session=${ID}&windowId=8`]],
  ]);
});

test('openSession on Windows: no window with the folder means a refusal and nothing but the listing', async () => {
  const { deps, calls } = fake({ sockets: [{ path: SOCK_NEW, mtimeMs: 2 }], byWindows: { [SOCK_NEW]: WIN_LIST } });
  await assert.rejects(openSession({ ...winArgs, cwd: 'C:\\Users\\sam\\fotos' }, deps), /Fenster nicht gefunden/);
  assert.deepEqual(calls.map((c) => c.args[0]), ['-s']);
});

test('review fix: a Windows window titled only "Visual Studio Code" or with a suffix counts as folderless too', () => {
  const known = [HOME, 'C:\\Users\\sam\\notes'];
  const bare = [{ id: 6, title: 'Visual Studio Code' }, { id: 7, title: 'Fotos - Visual Studio Code' }];
  assert.throws(() => pickWindow(HOME, null, bare, known, 'windows', HOME), /2 Fenster ohne Ordner/);
  const admin = [{ id: 6, title: 'Notizen - Visual Studio Code [Administrator]' }, { id: 7, title: 'Fotos - Visual Studio Code' }];
  assert.throws(() => pickWindow(HOME, null, admin, known, 'windows', HOME), /2 Fenster ohne Ordner/);
});
