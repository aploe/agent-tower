#!/usr/bin/env node
// Installs or removes the hook that lets Agent Tower answer permission prompts and questions.
//
//   node scripts/answer-hook.mjs                      # status: is the hook in the file?
//   node scripts/answer-hook.mjs install [--dry-run]
//   node scripts/answer-hook.mjs uninstall [--dry-run]
//   … --file <path>                                   # another file than ~/.claude/settings.json
//
// The hook is one entry under hooks.PermissionRequest in Claude Code's settings.json: Claude
// Code then sends every permission request to the daemon, which holds the ones it can show
// until they are answered in the widget and passes the rest through. This script is the only
// thing in Agent Tower that writes that file, and only when it is run by hand. Before a write
// it copies the file to <state folder>/backups/; it writes nothing when the file is not valid
// JSON, has a shape it does not know, or was changed while the script ran.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.mjs';
import { HOOK_PATH, hookEntry, planInstall, planUninstall } from './lib/hookPlan.mjs';
import { readOrNull, replaceFile } from './lib/replaceFile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMANDS = ['status', 'install', 'uninstall'];

function parseArgs(argv) {
  const opts = { command: 'status', dryRun: false, file: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--file') {
      if (i + 1 >= argv.length) throw new Error('--file needs a path');
      opts.file = argv[++i];
    } else if (COMMANDS.includes(a)) opts.command = a;
    else throw new Error(`unknown argument: ${a}\nusage: node scripts/answer-hook.mjs [status | install | uninstall] [--dry-run] [--file <path>]`);
  }
  return opts;
}

/** The file a write goes to: a symlink is followed, so the link itself stays a link. */
async function resolveTarget(file) {
  try {
    return await fs.realpath(file);
  } catch (err) {
    if (err.code === 'ENOENT') return file;
    throw err;
  }
}

function parse(bytes, name) {
  if (bytes === null) return {};
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (err) {
    throw new Error(`${name} is not valid JSON (${err.message}); nothing was changed`);
  }
}

const requestHooks = (settings) => JSON.stringify(settings?.hooks?.PermissionRequest ?? [], null, 2);

async function backup(cfg, bytes) {
  const dir = path.join(cfg.stateDir, 'backups');
  await fs.mkdir(dir, { recursive: true });
  const d = new Date();
  const two = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
    + `-${String(d.getMilliseconds()).padStart(3, '0')}`;
  const file = path.join(dir, `claude-settings-${stamp}.json`);
  await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
  return file;
}

/** Whether an Agent Tower daemon answers on the port the hook points at. */
async function daemonAnswers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return (await res.json())?.name === 'agent-tower';
  } catch {
    return false;
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cfg = await loadConfig({ root, argv: [] });
  const file = await resolveTarget(opts.file ? path.resolve(opts.file) : path.join(cfg.claudeDir, 'settings.json'));
  const name = path.basename(file);
  const bytes = await readOrNull(file);
  const settings = parse(bytes, name);
  const entry = hookEntry(cfg.port);
  const url = entry.hooks[0].url;

  if (opts.command === 'status') {
    const installed = !planUninstall(settings).changed ? null : (settings.hooks.PermissionRequest
      .flatMap((group) => group.hooks ?? []).find((hook) => typeof hook?.url === 'string' && hook.url.includes(HOOK_PATH)));
    console.log(`File:    ${file}`);
    if (installed) {
      console.log(`Hook:    installed (${installed.url}, timeout ${installed.timeout ?? 'default'} s)`);
      if (installed.url !== url) console.log(`         the daemon's configured port is ${cfg.port}; run "install" to point the hook at it`);
    } else {
      console.log('Hook:    not installed');
    }
    console.log(`Daemon:  ${(await daemonAnswers(cfg.port)) ? 'answers' : 'does not answer'} on http://127.0.0.1:${cfg.port}`);
    return;
  }

  const plan = opts.command === 'install' ? planInstall(settings, entry) : planUninstall(settings);
  if (!plan.changed) {
    console.log(opts.command === 'install' ? `Already installed in ${file}; nothing to do.` : `Not installed in ${file}; nothing to do.`);
    return;
  }
  if (opts.dryRun) {
    console.log(`Dry run: ${file} would change, nothing is written.\n`);
    console.log(`hooks.PermissionRequest now:\n${requestHooks(settings)}\n`);
    console.log(`hooks.PermissionRequest after ${opts.command}:\n${requestHooks(plan.next)}`);
    return;
  }

  if (bytes !== null) console.log(`Backup:  ${await backup(cfg, bytes)}`);
  await replaceFile(file, { expected: bytes, text: `${JSON.stringify(plan.next, null, 2)}\n` });
  if (opts.command === 'install') {
    console.log(`Installed in ${file}.`);
    console.log(`Claude Code now sends permission requests to the Agent Tower daemon on http://127.0.0.1:${cfg.port}.`);
    console.log('Running sessions use the hook from their next permission request on; no restart is needed.');
    console.log('While the daemon is not running, sessions behave as they do without the hook.');
  } else {
    console.log(`Removed from ${file}.`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
