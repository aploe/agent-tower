import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collect, explain, stepsFor, titleOf, projectOf, sortSessions } from '../src/collect.mjs';

const T = Date.parse('2026-11-16T12:00:00Z');
const M = 60000;
const iso = (ms) => new Date(ms).toISOString();

test('titleOf', () => {
  assert.equal(titleOf({ name: 'Mein Titel', nameSource: 'user', aiTitle: 'KI-Titel', cwd: '/a/b' }), 'Mein Titel');
  assert.equal(titleOf({ name: 'Auto', nameSource: 'auto', aiTitle: 'KI-Titel', cwd: '/a/b' }), 'Auto');
  assert.equal(titleOf({ name: 'websites-43', nameSource: 'derived', aiTitle: 'KI-Titel', cwd: '/a/b' }), 'KI-Titel');
  assert.equal(titleOf({ name: 'websites-43', nameSource: 'derived', aiTitle: null, cwd: '/a/b' }), 'websites-43');
  assert.equal(titleOf({ name: null, nameSource: null, aiTitle: null, cwd: '/a/b' }), 'b');
});
test('projectOf is the last path segment', () => {
  assert.equal(projectOf('/home/u/vereinsblog'), 'vereinsblog');
  assert.equal(projectOf('/home/u/x/'), 'x');
});

test('sortSessions: prompt (longest waiting first), waiting (most recent first), working, idle', () => {
  const s = (id, state, since) => ({ id, state, stateSince: since === null ? null : iso(T - since * M) });
  const sorted = sortSessions([
    s('i-new', 'idle', 1), s('w-old', 'working', 9), s('w-new', 'working', 2), s('wa-old', 'waiting', 8),
    s('wa-new', 'waiting', 3), s('p-new', 'prompt', 1), s('p-old', 'prompt', 7), s('wa-null', 'waiting', null),
    s('b-tie', 'idle', 1), s('i-old', 'idle', 5), s('p-null', 'prompt', null),
  ]);
  assert.deepEqual(sorted.map((x) => x.id), [
    'p-old', 'p-new', 'p-null', 'wa-new', 'wa-old', 'wa-null', 'w-new', 'w-old', 'b-tie', 'i-new', 'i-old',
  ]);
});

async function world() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-collect-'));
  const cfg = {
    host: '127.0.0.1', port: 0, pollMs: 1000, idleAfterMinutes: 240, promptAfterSeconds: 60,
    claudeDir: path.join(root, 'claude'), colonyHookDir: path.join(root, 'hook'), stateDir: path.join(root, 'state'),
    vscodeCli: null, wslDistro: null, fallback: { workingMinutes: 3, promptMinutes: 1, waitingMinutes: 90 },
  };
  const procRoot = path.join(root, 'proc');
  await fs.mkdir(path.join(cfg.claudeDir, 'sessions'), { recursive: true });
  await fs.mkdir(path.join(cfg.claudeDir, 'projects', 'p'), { recursive: true });
  await fs.mkdir(cfg.colonyHookDir, { recursive: true });
  await fs.mkdir(procRoot, { recursive: true });
  let nextPid = 1000;
  const w = {
    root, cfg, procRoot,
    async session(id, o = {}) {
      const pid = nextPid++;
      const procStart = String(5000 + pid);
      await fs.mkdir(path.join(procRoot, String(pid)), { recursive: true });
      await fs.writeFile(path.join(procRoot, String(pid), 'stat'), `${pid} (node) S${' 0'.repeat(18)} ${procStart} 0`);
      await fs.writeFile(path.join(cfg.claudeDir, 'sessions', `${pid}.json`), JSON.stringify({
        pid, sessionId: id, procStart, cwd: '/home/u/proj', startedAt: iso(T - 60 * M), entrypoint: 'claude-vscode',
        name: 'sess-' + id, nameSource: 'derived', status: 'busy', statusUpdatedAt: T - 5 * M, ...o,
      }));
    },
    async hook(id, status, sinceMs) {
      await fs.writeFile(path.join(cfg.colonyHookDir, `${id}.json`), JSON.stringify({ sessionId: id, status, since: iso(sinceMs) }));
    },
    async transcript(id, lines, dir = path.join(cfg.claudeDir, 'projects', 'p')) {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    },
  };
  return w;
}
const use = (id, name, input, atMs, extra = {}) => ({
  type: 'assistant', timestamp: iso(atMs), ...extra, message: { content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id, atMs, text = 'ok') => ({
  type: 'user', timestamp: iso(atMs), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const text = (type, atMs) => ({ type, timestamp: iso(atMs), message: { content: [{ type: 'text', text: 'x' }] } });

test('snapshot of a world with one session per state', async () => {
  const w = await world();
  await w.session('p1', { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: T - 5 * M });
  await w.hook('p1', 'prompt', T - 5 * M);
  await w.transcript('p1', [use('c1', 'Bash', { command: 'rm -rf x' }, T - 5 * M)]);
  await w.session('w1', { status: 'busy' });
  await w.transcript('w1', [text('assistant', T - M)]);
  await w.session('wa1', { status: 'idle', statusUpdatedAt: T - 10 * M });
  await w.session('i1', { status: 'idle', statusUpdatedAt: T - 300 * M });
  const snap = await collect(w.cfg, { now: T, procRoot: w.procRoot });
  assert.deepEqual(snap.counts, { total: 4, prompt: 1, working: 1, waiting: 1, idle: 1, dismissed: 0 });
  assert.deepEqual(snap.sessions.map((s) => s.id), ['p1', 'wa1', 'w1', 'i1']);
  assert.deepEqual(snap.sources, { registry: true, colonyHook: true, windows: null, vscodeUnread: null });
  assert.equal(snap.generatedAt, iso(T));
  const p = snap.sessions[0];
  assert.deepEqual([p.ask.kind, p.ask.tool, p.ask.summary, p.ask.certain, p.ask.via, p.ask.questions, p.canOpen],
    ['permission', 'Bash', 'rm -rf x', true, 'main', null, true]);
  assert.equal(p.stateSince, iso(T - 5 * M));
  assert.deepEqual(p.current, { tool: 'Bash', label: 'rm -rf x', since: iso(T - 5 * M) });
  assert.equal(snap.sessions[1].ask, null);
  assert.equal(snap.sessions[1].current, null);
  assert.equal(p.pid >= 1000, true);
  assert.equal(p.project, 'proj');
});

test('a question session carries questions and a plan its summary; hook missing gives colonyHook false', async () => {
  const w = await world();
  await fs.rm(w.cfg.colonyHookDir, { recursive: true });
  await w.session('q1');
  await w.transcript('q1', [use('c1', 'AskUserQuestion', { questions: [{ question: 'Wohin?', header: 'Ziel', options: [{ label: 'A' }, { label: 'B' }] }] }, T - M)]);
  const snap = await collect(w.cfg, { now: T, procRoot: w.procRoot });
  assert.equal(snap.sources.colonyHook, false);
  const s = snap.sessions[0];
  assert.equal(s.ask.kind, 'question');
  assert.deepEqual(s.ask.questions, [{ question: 'Wohin?', header: 'Ziel', options: ['A', 'B'], multiSelect: false }]);
});

test('a row carries the registry status as it is, next to the state derived from everything', async () => {
  const w = await world();
  // A dialog is open: the registry says so.
  await w.session('p1', { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: T - M });
  await w.transcript('p1', [use('c1', 'Bash', { command: 'ls' }, T - M)]);
  // A run without a dialog asks a question: the transcript makes it "prompt", the registry stays busy.
  await w.session('q1', { status: 'busy' });
  await w.transcript('q1', [use('c2', 'AskUserQuestion', { questions: [{ question: 'Wohin?', options: [{ label: 'A' }, { label: 'B' }] }] }, T - M)]);
  await w.session('n1', { status: undefined });
  const snap = await collect(w.cfg, { now: T, procRoot: w.procRoot });
  const row = (id) => snap.sessions.find((x) => x.id === id);
  assert.deepEqual([row('p1').state, row('p1').registryStatus], ['prompt', 'waiting']);
  assert.deepEqual([row('q1').state, row('q1').registryStatus], ['prompt', 'busy']);
  assert.equal(row('n1').registryStatus, null);
});

test('a dismissed finished session stays in the array with dismissed true and counts as dismissed', async () => {
  const w = await world();
  await w.session('wa1', { status: 'idle', statusUpdatedAt: T - 10 * M });
  await w.session('w1', { status: 'busy' });
  await fs.mkdir(w.cfg.stateDir, { recursive: true });
  await fs.writeFile(path.join(w.cfg.stateDir, 'dismissed.json'), JSON.stringify([
    { sessionId: 'wa1', group: 'finished' }, { sessionId: 'gone', group: 'working' },
  ]));
  const snap = await collect(w.cfg, { now: T, procRoot: w.procRoot });
  assert.deepEqual(snap.counts, { total: 2, prompt: 0, working: 1, waiting: 1, idle: 0, dismissed: 1 });
  assert.equal(snap.sessions.find((s) => s.id === 'wa1').dismissed, true);
  assert.equal(snap.sessions.find((s) => s.id === 'w1').dismissed, false);
  // reconciled list was saved: the entry of the vanished session is gone
  const saved = JSON.parse(await fs.readFile(path.join(w.cfg.stateDir, 'dismissed.json'), 'utf8'));
  assert.deepEqual(saved, [{ sessionId: 'wa1', group: 'finished' }]);
});

test('unreadable registry: empty snapshot with sources.registry false', async () => {
  const w = await world();
  await fs.rm(path.join(w.cfg.claudeDir, 'sessions'), { recursive: true });
  const snap = await collect(w.cfg, { now: T, procRoot: w.procRoot });
  assert.deepEqual(snap.sessions, []);
  assert.equal(snap.sources.registry, false);
  assert.deepEqual(snap.counts, { total: 0, prompt: 0, working: 0, waiting: 0, idle: 0, dismissed: 0 });
});

test('a session without a transcript still appears, with title from the registry and current null', async () => {
  const w = await world();
  await w.session('n1', { name: 'Mein Name', nameSource: 'user' });
  const snap = await collect(w.cfg, { now: T, procRoot: w.procRoot });
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].title, 'Mein Name');
  assert.equal(snap.sessions[0].current, null);
  assert.equal(snap.sessions[0].state, 'working');
});

test('a transcript read error for one session does not fail the snapshot', async () => {
  const w = await world();
  await w.session('bad1');
  await w.transcript('bad1', [text('assistant', T - M)]);
  await fs.chmod(path.join(w.cfg.claudeDir, 'projects', 'p', 'bad1.jsonl'), 0o000);
  await w.session('ok1');
  const snap = await collect(w.cfg, { now: T, procRoot: w.procRoot });
  assert.equal(snap.sessions.length, 2);
  const bad = snap.sessions.find((x) => x.id === 'bad1');
  assert.equal(bad.current, null);
  assert.equal(bad.state, 'working');
});

test('title falls back to the latest aiTitle for derived names', async () => {
  const w = await world();
  await w.session('t1');
  await w.transcript('t1', [{ type: 'ai-title', aiTitle: 'Schöner Titel' }, text('assistant', T - M)]);
  const snap = await collect(w.cfg, { now: T, procRoot: w.procRoot });
  assert.equal(snap.sessions[0].title, 'Schöner Titel');
});

test('an open Agent call is the current step', async () => {
  const w = await world();
  await w.session('a1');
  await w.transcript('a1', [use('c1', 'Agent', { description: 'Explore code' }, T - 3 * M)]);
  const snap = await collect(w.cfg, { now: T, procRoot: w.procRoot });
  assert.deepEqual(snap.sessions[0].current, { tool: 'Agent', label: 'Explore code', since: iso(T - 3 * M) });
  assert.equal(snap.sessions[0].state, 'working');
});

test("a subagent's open call counts only when the registry says waiting", async () => {
  async function build(status, waitingFor = null) {
    const w = await world();
    await w.session('s1', { status, waitingFor });
    const file = path.join(w.cfg.claudeDir, 'projects', 'p', 's1.jsonl');
    await w.transcript('s1', [use('a1', 'Agent', { description: 'sub' }, T - 6 * M)]);
    await w.transcript('agent-x', [use('b1', 'Bash', { command: 'ls' }, T - 5 * M, { isSidechain: true })],
      path.join(path.dirname(file), 's1', 'subagents'));
    await w.hook('s1', 'prompt', T - 5 * M + 500);
    return w;
  }
  const w1 = await build('busy');
  const s1 = (await collect(w1.cfg, { now: T, procRoot: w1.procRoot })).sessions[0];
  assert.equal(s1.state, 'working');
  const w2 = await build('waiting', 'permission prompt');
  const s2 = (await collect(w2.cfg, { now: T, procRoot: w2.procRoot })).sessions[0];
  assert.equal(s2.state, 'prompt');
  assert.equal(s2.ask.via, 'subagent');
  assert.equal(s2.ask.tool, 'Bash');
  assert.equal(s2.ask.certain, true);
});

test('registry waiting without any open call: ask.summary is the registry waitingFor', async () => {
  const w = await world();
  await w.session('q1', { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: T - M });
  await w.transcript('q1', [text('assistant', T - M)]);
  const s = (await collect(w.cfg, { now: T, procRoot: w.procRoot })).sessions[0];
  assert.deepEqual([s.state, s.ask.tool, s.ask.summary, s.ask.certain], ['prompt', null, 'permission prompt', true]);
});

test('explain returns the inputs and the decision for one id prefix; unknown gives null', async () => {
  const w = await world();
  await w.session('abc123');
  await w.transcript('abc123', [use('c1', 'Bash', { command: 'ls' }, T - 10 * 1000)]);
  const e = await explain(w.cfg, 'abc', { now: T, procRoot: w.procRoot });
  assert.equal(e.registry.sessionId, 'abc123');
  assert.equal(e.hook, null);
  assert.equal(e.open.length, 1);
  assert.deepEqual(e.subOpen, []);
  assert.equal(e.lastType, 'assistant');
  assert.equal(e.lastMs, T - 10 * 1000);
  assert.equal(e.decision.state, 'working');
  assert.equal(await explain(w.cfg, 'zzz', { now: T, procRoot: w.procRoot }), null);
});

test('stepsFor returns the last calls and the terminal; an unknown session gives empty steps', async () => {
  const w = await world();
  const lines = [];
  for (let i = 0; i < 35; i++) {
    lines.push(use(`c${i}`, 'Bash', { command: `echo ${i}` }, T - (40 - i) * 1000));
    lines.push(result(`c${i}`, T - (40 - i) * 1000 + 100, `line\nout ${i}`));
  }
  await w.transcript('st1', lines);
  const r = await stepsFor(w.cfg, 'st1');
  assert.equal(r.steps.length, 30);
  assert.equal(r.steps[0].label, 'echo 5');
  assert.equal(r.steps.at(-1).label, 'echo 34');
  assert.deepEqual(r.terminal, { command: 'echo 34', lastLine: 'out 34' });
  assert.deepEqual(await stepsFor(w.cfg, 'nope'), { steps: [], terminal: null });
});

test('ask.summary of a question is the first question text, not a JSON blob', async () => {
  const w = await world();
  await w.session('q1');
  await w.transcript('q1', [use('c1', 'AskUserQuestion', { questions: [{ question: 'Wohin?', header: 'Ziel', options: [{ label: 'A' }] }, { question: 'Wann?', options: [] }] }, T - M)]);
  const snap = await collect(w.cfg, { now: T, procRoot: w.procRoot });
  assert.equal(snap.sessions[0].ask.kind, 'question');
  assert.equal(snap.sessions[0].ask.summary, 'Wohin?');
});

test('a failing hidden-rows save does not fail the snapshot (one stderr line, entry reconciled in memory)', async () => {
  const w = await world();
  await w.session('wa1', { status: 'idle', statusUpdatedAt: T - 10 * M });
  await fs.mkdir(w.cfg.stateDir, { recursive: true });
  await fs.writeFile(path.join(w.cfg.stateDir, 'dismissed.json'), JSON.stringify([
    { sessionId: 'wa1', group: 'finished' }, { sessionId: 'gone', group: 'working' },
  ]));
  // a file where the state folder's tmp file must go: make the folder read-only
  await fs.chmod(w.cfg.stateDir, 0o500);
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const snap = await collect(w.cfg, { now: T, procRoot: w.procRoot });
    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.sessions[0].dismissed, true);
    assert.equal(snap.counts.dismissed, 1);
  } finally {
    console.error = orig;
    await fs.chmod(w.cfg.stateDir, 0o700);
  }
  if (process.getuid?.() !== 0) assert.equal(logged.length, 1);
});

// A second claude folder as on Windows: registry files plus transcripts, liveness from a fake
// startTimes (Windows has no /proc).
async function windowsRoot(entries, transcripts = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tower-collect-win-'));
  await fs.mkdir(path.join(dir, 'sessions'), { recursive: true });
  for (const e of entries) {
    await fs.writeFile(path.join(dir, 'sessions', `${e.pid}.json`), JSON.stringify({
      startedAt: T - 60 * M, statusUpdatedAt: T - 5 * M, ...e,
    }));
  }
  for (const [id, lines] of Object.entries(transcripts)) {
    const p = path.join(dir, 'projects', 'C--Users-sam');
    await fs.mkdir(p, { recursive: true });
    await fs.writeFile(path.join(p, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  return dir;
}
const D = 'd0000000-0000-4000-8000-000000000001';
const V = 'e0000000-0000-4000-8000-000000000002';
const DESK = 'local_0b1c2d3e-0000-4000-8000-000000000001';
const winEntries = () => [
  { pid: 51056, procStart: '11', sessionId: D, entrypoint: 'claude-desktop', hostSessionId: DESK,
    cwd: 'C:\\Users\\sam\\notes', name: 'Einkaufsliste', nameSource: 'user', status: 'idle' },
  { pid: 50156, procStart: '12', sessionId: V, entrypoint: 'claude-vscode', cwd: 'C:\\Users\\sam',
    name: 'sam-0a', nameSource: 'derived', status: 'busy' },
];
const winTranscripts = () => ({
  [V]: [{ type: 'ai-title', aiTitle: 'Fotos sortieren', sessionId: V }, use('v1', 'Bash', { command: 'dir' }, T - 20 * 1000)],
});
const bothAlive = async () => new Map([[51056, '11'], [50156, '12']]);

test('Windows sessions join the snapshot with host, opensIn and a project from a backslash path', async () => {
  const w = await world();
  await w.session('wsl1');
  await w.session('wsl2', { entrypoint: 'sdk-cli' });
  const win = await windowsRoot(winEntries(), winTranscripts());
  const snap = await collect({ ...w.cfg, windowsClaudeDir: win }, { now: T, procRoot: w.procRoot, winStartTimes: bothAlive });
  assert.equal(snap.sources.windows, true);
  assert.equal(snap.counts.total, 4);
  const d = snap.sessions.find((s) => s.id === D);
  assert.deepEqual([d.host, d.opensIn, d.canOpen, d.hostSessionId, d.project, d.title],
    ['windows', 'desktop', true, DESK, 'notes', 'Einkaufsliste']);
  const v = snap.sessions.find((s) => s.id === V);
  assert.deepEqual([v.host, v.opensIn, v.canOpen, v.hostSessionId, v.project, v.title],
    ['windows', 'vscode', true, null, 'sam', 'Fotos sortieren']); // title from the Windows transcript; jump since P5 (F32)
  for (const s of snap.sessions.filter((x) => x.host === 'wsl')) {
    assert.equal(s.opensIn, s.entrypoint === 'claude-vscode' ? 'vscode' : null);
    assert.equal(s.canOpen, s.opensIn !== null);
    assert.equal(s.hostSessionId, null);
  }
  assert.deepEqual(snap.sessions.filter((x) => x.host === 'wsl').map((s) => s.id).sort(), ['wsl1', 'wsl2']);
});

test('Windows trouble keeps the WSL rows', async () => {
  const w = await world();
  await w.session('wsl1');
  const win = await windowsRoot(winEntries(), winTranscripts());
  const alone = await collect(w.cfg, { now: T, procRoot: w.procRoot });
  const snap = await collect({ ...w.cfg, windowsClaudeDir: win }, { now: T, procRoot: w.procRoot, winStartTimes: async () => null });
  assert.equal(snap.sources.windows, false);
  assert.equal(snap.sources.registry, true);
  assert.deepEqual(snap.sessions, alone.sessions);
  assert.deepEqual(snap.counts, alone.counts);
  const missing = await collect({ ...w.cfg, windowsClaudeDir: path.join(win, 'nope') }, { now: T, procRoot: w.procRoot, winStartTimes: bothAlive });
  assert.equal(missing.sources.windows, false);
  assert.deepEqual(missing.sessions, alone.sessions);
});

test('no windowsClaudeDir: sources.windows null and winStartTimes is never called', async () => {
  const w = await world();
  await w.session('wsl1');
  const snap = await collect(w.cfg, { now: T, procRoot: w.procRoot, winStartTimes: async () => { throw new Error('called'); } });
  assert.equal(snap.sources.windows, null);
  assert.equal(snap.sessions.length, 1);
});

test('a desktop entry with a malformed hostSessionId has no way to open', async () => {
  const w = await world();
  const entries = winEntries();
  entries[0].hostSessionId = 'local_x&y=1';
  const win = await windowsRoot(entries);
  const snap = await collect({ ...w.cfg, windowsClaudeDir: win }, { now: T, procRoot: w.procRoot, winStartTimes: bothAlive });
  const d = snap.sessions.find((s) => s.id === D);
  assert.deepEqual([d.opensIn, d.canOpen, d.hostSessionId], [null, false, null]);
});

test('projectOf handles Windows paths', () => {
  assert.equal(projectOf('C:\\Users\\sam\\notes'), 'notes');
  assert.equal(projectOf('C:\\'), 'C:');
  assert.equal(projectOf('/home/u/x/'), 'x');
});

test('stepsFor and explain find a Windows session', async () => {
  const w = await world();
  const win = await windowsRoot(winEntries(), winTranscripts());
  const cfg = { ...w.cfg, windowsClaudeDir: win };
  const r = await stepsFor(cfg, V);
  assert.deepEqual(r.steps.map((s) => s.label), ['dir']);
  const e = await explain(cfg, V.slice(0, 8), { now: T, procRoot: w.procRoot, winStartTimes: bothAlive });
  assert.equal(e.registry.origin, 'windows');
  assert.equal(e.registry.sessionId, V);
});

test('review fix: a side that cannot be read keeps its hidden rows', async () => {
  const w = await world();
  await w.session('wsl1');
  const win = await windowsRoot(winEntries(), winTranscripts());
  const cfg = { ...w.cfg, windowsClaudeDir: win };
  await fs.mkdir(cfg.stateDir, { recursive: true });
  const file = path.join(cfg.stateDir, 'dismissed.json');
  await fs.writeFile(file, JSON.stringify([{ sessionId: D, group: 'finished' }, { sessionId: 'wsl1', group: 'working' }]));
  // Windows down: the hidden Windows row survives
  await collect(cfg, { now: T, procRoot: w.procRoot, winStartTimes: async () => null });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).map((e) => e.sessionId).sort(), [D, 'wsl1'].sort());
  // WSL down while Windows answers: the hidden WSL row survives
  await fs.rm(path.join(cfg.claudeDir, 'sessions'), { recursive: true });
  await collect(cfg, { now: T, procRoot: w.procRoot, winStartTimes: bothAlive });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).map((e) => e.sessionId).sort(), [D, 'wsl1'].sort());
  // both up again (WSL folder back, empty): a session that is really gone is pruned as before
  await fs.mkdir(path.join(cfg.claudeDir, 'sessions'));
  const none = await windowsRoot([]);
  await collect({ ...cfg, windowsClaudeDir: none }, { now: T, procRoot: w.procRoot, winStartTimes: bothAlive });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), []);
});

test("VS Code's unread marks: true or false for VS Code rows, null for the rest (F34)", async () => {
  const w = await world();
  await w.session('wa1', { status: 'idle', statusUpdatedAt: T - 10 * M });
  await w.session('wa2', { status: 'idle', statusUpdatedAt: T - 10 * M });
  await w.session('cli', { status: 'idle', statusUpdatedAt: T - 10 * M, entrypoint: 'sdk-cli' });
  const win = await windowsRoot(winEntries(), winTranscripts());
  const asked = [];
  const loadUnread = async (file) => { asked.push(file); return new Set(['wa1', 'cli', D, V]); };
  const cfg = { ...w.cfg, windowsClaudeDir: win, vscodeStateDb: '/mnt/c/x/state.vscdb' };
  const snap = await collect(cfg, { now: T, procRoot: w.procRoot, winStartTimes: bothAlive, loadUnread });
  assert.deepEqual(asked, ['/mnt/c/x/state.vscdb']);
  assert.equal(snap.sources.vscodeUnread, true);
  const unread = Object.fromEntries(snap.sessions.map((s) => [s.id, s.unread]));
  assert.deepEqual(unread, { wa1: true, wa2: false, cli: null, [D]: null, [V]: true });
});

test('unknown marks give null on every row and sources.vscodeUnread false', async () => {
  const w = await world();
  await w.session('wa1', { status: 'idle', statusUpdatedAt: T - 10 * M });
  const snap = await collect({ ...w.cfg, vscodeStateDb: '/x/state.vscdb' }, { now: T, procRoot: w.procRoot, loadUnread: async () => null });
  assert.equal(snap.sources.vscodeUnread, false);
  assert.equal(snap.sessions[0].unread, null);
});

test('no vscodeStateDb: the marks are not read, sources.vscodeUnread null', async () => {
  const w = await world();
  await w.session('wa1', { status: 'idle', statusUpdatedAt: T - 10 * M });
  const snap = await collect(w.cfg, { now: T, procRoot: w.procRoot, loadUnread: async () => { throw new Error('called'); } });
  assert.equal(snap.sources.vscodeUnread, null);
  assert.equal(snap.sessions[0].unread, null);
});
