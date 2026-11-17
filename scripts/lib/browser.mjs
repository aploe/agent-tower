// Copied from agent-colony@7da77bb: scripts/drive.mjs
// Changed: kept only nvmModuleDirs, loadPlaywright and findChrome (override variable TOWER_CHROME).
//
// Playwright and Chromium for the scripts that need a browser. Playwright is not in
// package.json; it is resolved from the global nvm install.
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

function nvmModuleDirs() {
  const base = join(homedir(), '.nvm/versions/node');
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .sort()
    .reverse()
    .flatMap((v) => [
      join(base, v, 'lib/node_modules/@playwright/test'),
      join(base, v, 'lib/node_modules'),
    ]);
}

export function loadPlaywright() {
  const paths = [root, ...nvmModuleDirs()];
  for (const name of ['playwright-core', 'playwright']) {
    try {
      return require(require.resolve(name, { paths }));
    } catch {
      // next candidate
    }
  }
  throw new Error('playwright-core not found. Searched: ' + paths.join(', ') + '\nInstall globally: npm i -g @playwright/test');
}

export function findChrome() {
  if (process.env.TOWER_CHROME) return process.env.TOWER_CHROME;
  const base = join(homedir(), '.cache/ms-playwright');
  if (!existsSync(base)) throw new Error('No Chromium under ' + base + ' — set TOWER_CHROME.');
  const dirs = readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const d of dirs) {
    const bin = join(base, d, 'chrome-linux64/chrome');
    if (existsSync(bin)) return bin;
  }
  throw new Error('No chrome-linux64/chrome under ' + base);
}
