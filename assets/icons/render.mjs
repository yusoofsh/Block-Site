// Renders the toolbar and store icons from the SVG sources in this folder.
// Needs playwright-core and a Chromium binary:
//   CHROMIUM=/path/to/chrome bun render.mjs
// At 16px the keyhole is dropped and the shackle drawn thicker so the lock stays legible.
import {chromium} from 'playwright-core';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../../v3/data/icons');
const jobs = [
  ['icon.svg', '', [16, 32, 48, 64, 128, 256]],
  ['blocked.svg', 'blocked/', [16, 32, 256]],
  ['paused.svg', 'paused/', [16, 32, 256]]
];

const browser = await chromium.launch({executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium'});
const page = await browser.newPage({deviceScaleFactor: 1});
for (const [src, dir, sizes] of jobs) {
  const source = readFileSync(join(here, src), 'utf8');
  for (const size of sizes) {
    let svg = source;
    if (size <= 16) {
      svg = svg.replace(/<circle [^>]*\/>\s*<rect x="60.5"[^>]*\/>/, '').replace('stroke-width="11"', 'stroke-width="14"');
    }
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${
      svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}`);
    await page.locator('svg').screenshot({path: join(out, dir + size + '.png'), omitBackground: true});
  }
}
await browser.close();
