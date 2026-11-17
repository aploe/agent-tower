#!/usr/bin/env node
// Draws the app icon (the figure's head in lime on a dark tile) and writes shell/AgentTower.ico
// with one image per size. Run it again only when the drawing changes; the .ico is committed.
//
// Usage: node scripts/make-icon.mjs [preview.png]     the preview shows every size on light and dark
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, loadPlaywright } from './lib/browser.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 256];
const TILE = '#171719'; // the page's --panel
const LIME = '#d4f53c'; // the page's --accent

// The figure of public/modules/render.mjs (viewBox 40 × 46) without its shadow. Small sizes get
// a tile without a margin and a larger figure, or the eyes fall below one pixel.
function svg(size) {
  const small = size < 32;
  const tile = small
    ? '<rect x="0" y="0" width="64" height="64" rx="13" />'
    : '<rect x="3" y="3" width="58" height="58" rx="14" />';
  const scale = small ? 1.16 : 0.98;
  const dx = (64 - 40 * scale) / 2;
  const dy = (64 - 46 * scale) / 2 + 0.5;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}">
    <g fill="${TILE}">${tile}</g>
    <g transform="translate(${dx} ${dy}) scale(${scale})">
      <g fill="${LIME}">
        <path d="M19 5h2v6h-2z" />
        <circle cx="20" cy="4.5" r="3.2" />
        <rect x="5" y="9.5" width="30" height="28" rx="11" />
      </g>
      <g fill="${TILE}">
        <circle cx="14.5" cy="22.5" r="${small ? 3.4 : 3}" />
        <circle cx="25.5" cy="22.5" r="${small ? 3.4 : 3}" />
      </g>
      <path d="M16 29.2Q20 33 24 29.2" fill="none" stroke="${TILE}" stroke-width="${small ? 2.8 : 2.4}" stroke-linecap="round" />
    </g>
  </svg>`;
}

/** An .ico file from PNG images (Windows reads PNG entries at every size since Vista). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: findChrome(), headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const images = [];
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<body style="margin:0;background:transparent">${svg(size)}</body>`);
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    images.push({ size, png });
  }
  const out = join(root, 'shell/AgentTower.ico');
  writeFileSync(out, ico(images));
  console.log(`${out}  (${SIZES.join(', ')} px)`);

  const preview = process.argv[2];
  if (preview) {
    const row = (bg) => `<div style="display:flex;gap:16px;align-items:flex-end;padding:16px;background:${bg}">${
      SIZES.map((s) => svg(s)).join('')}${SIZES.slice(0, 4).map((s) => svg(s).replace(`width="${s}" height="${s}"`, `width="${s * 4}" height="${s * 4}" style="image-rendering:pixelated"`)).join('')}</div>`;
    await page.setViewportSize({ width: 1000, height: 600 });
    await page.setContent(`<body style="margin:0">${row('#f3f3f3')}${row('#202020')}</body>`);
    const target = resolve(process.cwd(), preview);
    mkdirSync(dirname(target), { recursive: true });
    await page.locator('body').screenshot({ path: target });
    console.log(`preview: ${target}`);
  }
} finally {
  await browser.close();
}
