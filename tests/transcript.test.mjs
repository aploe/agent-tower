import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseTail,
  analyzeTranscript,
  locateTranscript,
  subagentOpenCalls,
} from '../src/sources/transcript.mjs';

const line = (obj) => JSON.stringify(obj) + '\n';
const asst = (id, name, input, ts, extra = {}) =>
  line({
    type: 'assistant',
    timestamp: ts,
    ...extra,
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
const result = (id, content, isError, ts = '2026-11-16T10:00:01.000Z') =>
  line({
    type: 'user',
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }],
    },
  });
const prompt = (text, ts) =>
  line({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const title = (t) => line({ type: 'ai-title', aiTitle: t, sessionId: 's' });

const T0 = '2026-11-16T10:00:00.000Z';
const T1 = '2026-11-16T10:05:00.000Z';
const T2 = '2026-11-16T10:10:00.000Z';

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tower-transcript-'));
}

test('truncated first line and half-written last line are ignored', () => {
  const text = 'cut":true}\n' + asst('t1', 'Bash', { command: 'ls' }, T0) + '{"type":"assis';
  assert.equal(parseTail(text).calls.length, 1);
});

test('result marks done, is_error marks error, text blocks are joined', () => {
  const text =
    asst('a', 'Bash', { command: 'ls' }, T0) +
    result('a', 'file1\nfile2') +
    asst('b', 'Bash', { command: 'x' }, T0) +
    result('b', 'boom', true) +
    asst('c', 'Read', { file_path: '/x' }, T0) +
    result('c', [
      { type: 'text', text: 'one' },
      { type: 'image', source: {} },
      { type: 'text', text: 'two' },
    ]);
  const { calls } = parseTail(text);
  assert.deepEqual(
    calls.map((c) => [c.id, c.status, c.resultText]),
    [
      ['a', 'done', 'file1\nfile2'],
      ['b', 'error', 'boom'],
      ['c', 'done', 'one\ntwo'],
    ],
  );
  assert.equal(calls[0].name, 'Bash');
  assert.deepEqual(calls[0].input, { command: 'ls' });
  assert.equal(calls[0].atMs, Date.parse(T0));
});

test('open call after the last prompt is running; before a later prompt it is error', () => {
  const running = parseTail(prompt('go', T0) + asst('r', 'Bash', {}, T1));
  assert.equal(running.calls[0].status, 'running');
  assert.deepEqual(running.open.map((c) => c.id), ['r']);

  const interrupted = parseTail(prompt('go', T0) + asst('r', 'Bash', {}, T1) + prompt('stop', T2));
  assert.equal(interrupted.calls[0].status, 'error');
  assert.equal(interrupted.open.length, 0);

  // a tool_result for another call is not a real prompt
  const parallel = parseTail(
    asst('p1', 'Bash', {}, T0) + asst('p2', 'Bash', {}, T0) + result('p1', 'ok'),
  );
  assert.deepEqual(
    parallel.calls.map((c) => c.status),
    ['done', 'running'],
  );
});

test('isMeta user records and the interrupt marker are no real prompt', () => {
  const metaStr = line({ type: 'user', isMeta: true, timestamp: T1, message: { role: 'user', content: 'skill body' } });
  const metaBlk = line({ type: 'user', isMeta: true, timestamp: T1, message: { role: 'user', content: [{ type: 'text', text: 'img' }] } });
  const info = parseTail(prompt('go', T0) + asst('q', 'AskUserQuestion', {}, T1) + metaStr + metaBlk);
  assert.deepEqual(info.open.map((c) => c.id), ['q']);
  const marker = line({ type: 'user', timestamp: T2, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
  const info2 = parseTail(prompt('go', T0) + asst('q', 'Bash', {}, T1) + marker);
  assert.equal(info2.calls[0].status, 'running');
});

test('cache is capped: the oldest entry is evicted', async () => {
  const dir = await tmp();
  const files = [];
  for (let i = 0; i < 205; i++) {
    const f = path.join(dir, 's' + i + '.jsonl');
    await fs.writeFile(f, prompt('a', T0));
    files.push(f);
  }
  const first = await analyzeTranscript(files[0]);
  for (const f of files.slice(1)) await analyzeTranscript(f);
  assert.notEqual(await analyzeTranscript(files[0]), first);
});

test('latest ai-title wins; none gives null', () => {
  assert.equal(parseTail(title('Old') + prompt('x', T0) + title('New')).aiTitle, 'New');
  assert.equal(parseTail(prompt('x', T0)).aiTitle, null);
});

test('sidechain records: ignored on main, kept on any', () => {
  const text =
    asst('m', 'Bash', {}, T0) +
    result('m', 'ok') +
    asst('s', 'Read', {}, T1, { isSidechain: true });
  assert.deepEqual(parseTail(text).calls.map((c) => c.id), ['m']);
  assert.deepEqual(parseTail(text, { chain: 'main' }).calls.map((c) => c.id), ['m']);
  assert.deepEqual(parseTail(text, { chain: 'any' }).calls.map((c) => c.id), ['m', 's']);
});

test('lastMs and lastType come from the newest role record', () => {
  const text = prompt('a', T0) + asst('x', 'Bash', {}, T1) + title('t') + result('x', 'ok', false, T2);
  const info = parseTail(text);
  assert.equal(info.lastMs, Date.parse(T2));
  assert.equal(info.lastType, 'user');
  const empty = parseTail(title('only'));
  assert.equal(empty.lastMs, null);
  assert.equal(empty.lastType, null);
});

test('a 200 KB line after the only role record: the window grows', async () => {
  const dir = await tmp();
  const f = path.join(dir, 's.jsonl');
  const big = line({ type: 'prompt_snapshot', blob: 'x'.repeat(200 * 1024) });
  await fs.writeFile(f, prompt('hello', T0) + big);
  const info = await analyzeTranscript(f);
  assert.notEqual(info.lastMs, null);
  assert.equal(info.lastType, 'user');
});

test('minToolCalls 15 over 300 KB of records yields at least 15 calls', async () => {
  const dir = await tmp();
  const f = path.join(dir, 's.jsonl');
  let text = '';
  for (let i = 0; i < 20; i++) {
    text += asst(`t${i}`, 'Bash', { command: 'echo ' + 'y'.repeat(20000) }, T0);
    text += result(`t${i}`, 'z'.repeat(100));
  }
  assert.ok(text.length > 300 * 1024);
  await fs.writeFile(f, text);
  const few = await analyzeTranscript(f);
  assert.ok(few.calls.length > 0 && few.calls.length < 15);
  const info = await analyzeTranscript(f, { minToolCalls: 15 });
  assert.ok(info.calls.length >= 15);
  assert.equal(info.calls.at(-1).id, 't19');
});

test('cache: unchanged file returns the same object', async () => {
  const dir = await tmp();
  const f = path.join(dir, 's.jsonl');
  await fs.writeFile(f, prompt('a', T0));
  const first = await analyzeTranscript(f);
  assert.equal(await analyzeTranscript(f), first);
  await fs.appendFile(f, prompt('b', T1));
  const next = await analyzeTranscript(f);
  assert.notEqual(next, first);
  assert.equal(next.lastMs, Date.parse(T1));
});

test('locateTranscript finds the file in any project folder, null otherwise', async () => {
  const claudeDir = await tmp();
  await fs.mkdir(path.join(claudeDir, 'projects', '-a'), { recursive: true });
  await fs.mkdir(path.join(claudeDir, 'projects', '-b'), { recursive: true });
  const f = path.join(claudeDir, 'projects', '-b', 'sess-1.jsonl');
  await fs.writeFile(f, prompt('a', T0));
  assert.equal(await locateTranscript(claudeDir, 'sess-1'), f);
  assert.equal(await locateTranscript(claudeDir, 'nope'), null);
  const empty = await tmp();
  assert.equal(await locateTranscript(empty, 'sess-1'), null);
});

test('locateTranscript drops a cached path when the file vanished and searches again', async () => {
  const claudeDir = await tmp();
  await fs.mkdir(path.join(claudeDir, 'projects', '-a'), { recursive: true });
  await fs.mkdir(path.join(claudeDir, 'projects', '-b'), { recursive: true });
  const a = path.join(claudeDir, 'projects', '-a', 'sess-mv.jsonl');
  const b = path.join(claudeDir, 'projects', '-b', 'sess-mv.jsonl');
  await fs.writeFile(a, prompt('a', T0));
  assert.equal(await locateTranscript(claudeDir, 'sess-mv'), a);
  await fs.rename(a, b);
  assert.equal(await locateTranscript(claudeDir, 'sess-mv'), b);
  await fs.rm(b);
  assert.equal(await locateTranscript(claudeDir, 'sess-mv'), null);
});

test('subagentOpenCalls skips files older than since minus 60 s', async () => {
  const dir = await tmp();
  const transcript = path.join(dir, 'sess.jsonl');
  await fs.writeFile(transcript, prompt('a', T0));
  const sub = path.join(dir, 'sess', 'subagents');
  await fs.mkdir(sub, { recursive: true });
  const fresh = path.join(sub, 'agent-fresh.jsonl');
  const stale = path.join(sub, 'agent-stale.jsonl');
  await fs.writeFile(fresh, asst('f1', 'Bash', {}, T0, { isSidechain: true }));
  await fs.writeFile(stale, asst('s1', 'Bash', {}, T0, { isSidechain: true }));
  await fs.writeFile(path.join(sub, 'agent-fresh.meta.json'), '{}');
  const since = Date.now();
  const old = new Date(since - 120000);
  await fs.utimes(stale, old, old);

  const calls = await subagentOpenCalls(transcript, 'sess', since);
  assert.deepEqual(calls.map((c) => c.id), ['f1']);
  assert.equal(calls[0].status, 'running');

  const all = await subagentOpenCalls(transcript, 'sess', null);
  assert.deepEqual(all.map((c) => c.id).sort(), ['f1', 's1']);

  assert.deepEqual(await subagentOpenCalls(transcript, 'missing', since), []);
});
