#!/usr/bin/env node
// Starts an own daemon on --port 0, shoots the widget page, stops that daemon by PID.
//
// Usage: node scripts/shot.mjs <out.png> [--fixture <name>] [--detail <sessionId>] [--collapsed] [--settings]
//                              [--lang de] [--width 400] [--height 900] [--eval "<expression>"]
//                              [--hover "<css selector>"]  (rests the mouse there before the shot)
// --lang works with --fixture only; live mode follows the daemon's language setting.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, loadPlaywright } from './lib/browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = { out: null, fixture: null, detail: null, collapsed: false, settings: false, lang: null, width: 400, height: 900, evalExpr: null, hover: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--fixture') opts.fixture = next();
    else if (a === '--detail') opts.detail = next();
    else if (a === '--collapsed') opts.collapsed = true;
    else if (a === '--settings') opts.settings = true;
    else if (a === '--lang') opts.lang = next();
    else if (a === '--width') opts.width = Number(next());
    else if (a === '--height') opts.height = Number(next());
    else if (a === '--eval') opts.evalExpr = next();
    else if (a === '--hover') opts.hover = next();
    else if (!a.startsWith('--') && !opts.out) opts.out = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!opts.out) throw new Error('usage: node scripts/shot.mjs <out.png> [--fixture <name>] [--detail <id>] [--collapsed] [--settings] [--lang de] [--width n] [--height n] [--eval "<expr>"]');
  return opts;
}

/** Starts `node src/server.mjs --port 0` and resolves with the child and the port from its start line. */
function startDaemon() {
  return new Promise((resolveStart, reject) => {
    const child = spawn(process.execPath, [join(root, 'src/server.mjs'), '--port', '0'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(reject, new Error('daemon printed no start line within 10 s:\n' + output));
    }, 10000);
    const onData = (chunk) => {
      output += chunk;
      const m = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) finish(resolveStart, { child, port: Number(m[1]) });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('exit', (code) => finish(reject, new Error(`daemon exited (${code}) before it listened:\n${output}`)));
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outPath = resolve(process.cwd(), opts.out);
  mkdirSync(dirname(outPath), { recursive: true });

  const { chromium } = loadPlaywright();
  const { child, port } = await startDaemon();
  let browser;
  try {
    const query = new URLSearchParams();
    if (opts.fixture) query.set('fixture', opts.fixture);
    if (opts.detail) query.set('detail', opts.detail);
    if (opts.collapsed) query.set('collapsed', '1');
    if (opts.settings) query.set('settings', '1');
    if (opts.lang) query.set('lang', opts.lang);
    const qs = query.toString();
    const url = `http://127.0.0.1:${port}/${qs ? '?' + qs : ''}`;

    browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: opts.width, height: opts.height }, deviceScaleFactor: 2 });
    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });

    await page.goto(url);
    await page.waitForFunction(() => document.body && document.body.dataset.ready === '1', null, { timeout: 15000 });
    if (opts.evalExpr) console.log(await page.evaluate(opts.evalExpr));
    if (opts.hover) {
      await page.hover(opts.hover);
      await page.waitForTimeout(700); // past the tooltip's delay and fade
    }
    await page.screenshot({ path: outPath });
    console.log(`shot: ${outPath}  (${url})`);
    if (problems.length) console.error(problems.join('\n'));
  } finally {
    if (browser) await browser.close();
    child.kill(); // our own daemon, by its PID
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
