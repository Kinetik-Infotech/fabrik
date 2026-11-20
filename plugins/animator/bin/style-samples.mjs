#!/usr/bin/env node
// Renders one scene of a built job in each of the four styles, as small JPEGs for the request form's style picker.
//   node style-samples.mjs <job-dir> <scene-id> <out-dir>   writes <out-dir>/<style>.jpg at 800 x 450
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { openRecord, scenes, renderAt } from './lib/chrome.mjs';
const SETTLED = 0.35; // as in render.mjs: the last fully drawn frame

const [dir, id, out] = process.argv.slice(2);
if (!dir || !id || !out) { console.error('usage: node style-samples.mjs <job-dir> <scene-id> <out-dir>'); process.exit(1); }
mkdirSync(out, { recursive: true });
for (const style of ['line', 'storyboard', 'comic', 'anime']) {
  const { browser, page } = await openRecord(path.resolve(dir, 'page.html'), { style });
  const s = (await scenes(page)).find(s => s.id === id);
  if (!s) { console.error(`no scene ${id}`); process.exit(1); }
  await renderAt(page, s.start + s.dur - SETTLED);
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 0.5 });
  await renderAt(page, s.start + s.dur - SETTLED);
  await page.screenshot({ path: path.join(out, `${style}.jpg`), type: 'jpeg', quality: 82 });
  await browser.close();
  console.log(`${style}.jpg`);
}
