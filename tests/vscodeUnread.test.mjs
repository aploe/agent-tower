import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createUnreadReader, unreadKeysOf } from '../src/sources/vscodeUnread.mjs';

/** A state.vscdb as VS Code writes it: one ItemTable, values as text. */
async function stateDb(entries) {
  const dir = await mkdtemp(path.join(tmpdir(), 'tower-vscdb-'));
  const file = path.join(dir, 'state.vscdb');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const put = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(entries)) put.run(k, typeof v === 'string' ? v : JSON.stringify(v));
  db.close();
  return file;
}

test('unreadKeysOf joins the lists of every workspace folder and ignores everything else', () => {
  const keys = unreadKeysOf({
    'sessionUnread:/home/u/a': ['s1', 's2'],
    'sessionUnread:C:\\Users\\sam': ['s3', 42, '', 's1'],
    'sessionUnread:/home/u/b': 'not-a-list',
    sessionGroups: ['s9'],
    hiddenSessionIds: ['s8'],
  });
  assert.deepEqual([...keys].sort(), ['s1', 's2', 's3']);
  assert.deepEqual([...unreadKeysOf(null)], []);
  assert.deepEqual([...unreadKeysOf('x')], []);
});

test('the reader finds the marks in a real state file, whatever the case of the extension key', async () => {
  const file = await stateDb({
    'Anthropic.claude-code': { 'sessionUnread:/home/u/a': ['s1'], 'sessionUnread:/home/u/b': [], other: 1 },
    'workbench.panel': { x: 1 },
  });
  assert.deepEqual([...(await createUnreadReader(file)())], ['s1']);
  const lower = await stateDb({ 'anthropic.claude-code': { 'sessionUnread:/x': ['s2'] } });
  assert.deepEqual([...(await createUnreadReader(lower)())], ['s2']);
});

test('no entry of the extension means no marks; a missing or broken file is unknown (null)', async () => {
  const empty = await stateDb({ 'workbench.panel': { x: 1 } });
  assert.deepEqual([...(await createUnreadReader(empty)())], []);
  assert.equal(await createUnreadReader(path.join(tmpdir(), 'nope', 'state.vscdb'))(), null);
  const broken = path.join(await mkdtemp(path.join(tmpdir(), 'tower-vscdb-')), 'state.vscdb');
  await writeFile(broken, 'this is not sqlite');
  assert.equal(await createUnreadReader(broken)(), null);
  assert.equal(await createUnreadReader(null)(), null);
});

test('the file is read again only when its mtime or size changed', async () => {
  const file = await stateDb({ 'Anthropic.claude-code': { 'sessionUnread:/a': ['s1'] } });
  let reads = 0;
  const fs = { stat, readFile: async (f) => { reads++; return readFile(f); } };
  const read = createUnreadReader(file, { fs });
  await read();
  await read();
  assert.equal(reads, 1);
  const next = await stateDb({ 'Anthropic.claude-code': { 'sessionUnread:/a': ['s1', 's2'] } });
  await writeFile(file, await readFile(next));
  assert.deepEqual([...(await read())].sort(), ['s1', 's2']);
  assert.equal(reads, 2);
});

test('a file that changes while it is read keeps the last answer and is read again next time', async () => {
  const file = await stateDb({ 'Anthropic.claude-code': { 'sessionUnread:/a': ['s1'] } });
  let torn = false;
  let size = 0;
  const fs = {
    readFile,
    // the second stat of a read (the one after the bytes) reports another size while `torn`
    stat: async (f) => {
      const st = await stat(f);
      size++;
      return torn && size % 2 === 0 ? { mtimeMs: st.mtimeMs, size: st.size + 1 } : st;
    },
  };
  const read = createUnreadReader(file, { fs });
  assert.deepEqual([...(await read())], ['s1']);
  const next = await stateDb({ 'Anthropic.claude-code': { 'sessionUnread:/a': ['s2'] } });
  await writeFile(file, await readFile(next));
  torn = true;
  size = 0;
  assert.deepEqual([...(await read())], ['s1']); // the old answer, not a guess
  torn = false;
  assert.deepEqual([...(await read())], ['s2']);
});
