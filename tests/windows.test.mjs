import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStartTimeCheck, openDesktopSession, parseStartTimes, startTimesScript, windowsPathOf, POWERSHELL } from '../src/windows.mjs';

test('startTimesScript lists the ids and always exits 0', () => {
  assert.equal(startTimesScript([50156, 51056]),
    "Get-Process -Id 50156,51056 -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1}' -f $_.Id, $_.StartTime.ToFileTimeUtc() }; exit 0");
});

test('parseStartTimes reads "pid filetime" lines and ignores everything else', () => {
  assert.deepEqual(parseStartTimes('50156 134393258502160508\r\n51056 134393895681048400\r\nWARNUNG: x\r\n\r\n'),
    new Map([[50156, '134393258502160508'], [51056, '134393895681048400']]));
});

test('the query runs powershell.exe without a profile and with a timeout', async () => {
  const calls = [];
  const check = createStartTimeCheck({ run: async (file, args, opts) => { calls.push([file, args, opts]); return { stdout: '' }; } });
  await check([51056]);
  assert.deepEqual(calls, [[POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', startTimesScript([51056])], { timeout: 3000 }]]); // review fix: a short budget, a hang must not freeze the WSL rows
  assert.equal(POWERSHELL, '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe');
});

test('one query per TTL, a new PID forces a query, invalid PIDs never reach the script', async () => {
  let t = 0;
  const scripts = [];
  const check = createStartTimeCheck({
    ttlMs: 5000, now: () => t,
    run: async (file, args) => { scripts.push(args.at(-1)); return { stdout: '51056 134393895681048400\r\n' }; },
  });
  assert.deepEqual(await check([51056]), new Map([[51056, '134393895681048400']]));
  t = 4000; await check([51056]);
  assert.equal(scripts.length, 1); // cached
  t = 4500; await check([51056, 53052]);
  assert.equal(scripts.length, 2); // 53052 was not asked before
  t = 9600; await check([51056]);
  assert.equal(scripts.length, 3); // TTL over
  await check([-1, 1.5, '7; Stop-Computer', 51056]);
  assert.equal(scripts.length, 3); // only 51056 is valid, and it is cached
  assert.ok(scripts.every((s) => !s.includes('Stop-Computer')));
});

test('a PID beyond Int32 never reaches the script', async () => {
  // Get-Process fails the whole call on one id it cannot bind to Int32 and still exits 0, so
  // every Windows session would read as ended (checked live 2026-11-17).
  const scripts = [];
  const check = createStartTimeCheck({ run: async (file, args) => { scripts.push(args.at(-1)); return { stdout: '51056 11\r\n' }; } });
  assert.deepEqual(await check([2147483648, 51056]), new Map([[51056, '11']]));
  assert.deepEqual(scripts, [startTimesScript([51056])]);
});

test('the answer holds only the PIDs asked for', async () => {
  const check = createStartTimeCheck({ run: async () => ({ stdout: '51056 11\r\n53052 12\r\n' }) });
  await check([51056, 53052]);
  assert.deepEqual(await check([53052]), new Map([[53052, '12']]));
});

test('no PID: no PowerShell', async () => {
  const check = createStartTimeCheck({ run: async () => { throw new Error('must not run'); } });
  assert.deepEqual(await check([]), new Map());
});

test('no process left: empty output means none alive, not unknown', async () => {
  const check = createStartTimeCheck({ run: async () => ({ stdout: '' }) });
  assert.deepEqual(await check([51056]), new Map());
});

test('PowerShell failing gives null', async () => {
  const check = createStartTimeCheck({ run: async () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); } });
  assert.equal(await check([51056]), null);
});

test('openDesktopSession hands the claude:// link to wslview', async () => {
  const calls = [];
  const r = await openDesktopSession({ hostSessionId: 'local_0b1c2d3e-0000-4000-8000-000000000001' },
    { run: async (f, a, o) => { calls.push([f, a, o.timeout]); return { stdout: '' }; } });
  assert.deepEqual(calls, [['wslview', ['claude://code/continue?session=local_0b1c2d3e-0000-4000-8000-000000000001'], 20000]]);
  assert.equal(r.url, 'claude://code/continue?session=local_0b1c2d3e-0000-4000-8000-000000000001');
});

test('openDesktopSession refuses anything but local_<id> and runs nothing', async () => {
  for (const id of ['last', 'local_', 'local_a b', 'local_x&y=1', `local_${'a'.repeat(65)}`, null, undefined]) {
    await assert.rejects(openDesktopSession({ hostSessionId: id }, { run: async () => { throw new Error('ran'); } }),
      { message: 'Not a valid desktop session id' }, String(id));
  }
});

test('openDesktopSession without wslview says so', async () => {
  await assert.rejects(openDesktopSession({ hostSessionId: 'local_a1' },
    { run: async () => { throw Object.assign(new Error('spawn wslview ENOENT'), { code: 'ENOENT' }); } }),
    { message: 'wslview missing (package wslu)' });
});

test('windowsPathOf turns a /mnt drive path into a Windows path', () => {
  assert.equal(windowsPathOf('/mnt/c/Users/sam'), 'C:\\Users\\sam');
  assert.equal(windowsPathOf('/mnt/d'), 'D:\\');
  assert.equal(windowsPathOf('/home/sam'), null);
  assert.equal(windowsPathOf(null), null);
});

test('review fix: after a failure PowerShell is not asked again for 30 s, not even for a new PID', async () => {
  let t = 0;
  let runs = 0;
  const check = createStartTimeCheck({ now: () => t, run: async () => { runs++; throw new Error('timeout'); } });
  assert.equal(await check([51056]), null);
  t = 10000;
  assert.equal(await check([51056, 53052]), null);
  assert.equal(runs, 1);
  t = 30001;
  await check([51056]);
  assert.equal(runs, 2);
});
