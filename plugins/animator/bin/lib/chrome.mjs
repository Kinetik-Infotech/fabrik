// Opens a built page in headless Chrome with puppeteer-core, for the checks and the renderer.
// The Chrome path comes from CHROME_PATH, defaulting to Google Chrome on a Mac.
// Lifted from acme-marketplace plugins/acme-brand/skills/brand/examples/bilby-demo/record.js.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const FONTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
/** Lets the page load only its own job folder's files, inline data and Google's fonts. Every other request, to the
 *  network or to any other file on this computer, is refused. */
export async function confine(page, dir) {
  const own = pathToFileURL(dir).href + '/';
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    let ok = url.startsWith('data:') || url.startsWith('blob:') || (url.startsWith(own) && !url.slice(own.length).split(/[?#]/)[0].split('/').includes('..'));
    if (!ok) try { const u = new URL(url); ok = u.protocol === 'https:' && FONTS.has(u.hostname) && req.method() === 'GET'; } catch {}
    ok ? req.continue() : req.abort('accessdenied');
  });
}

export const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const WIDTH = 1600, HEIGHT = 900;

/** Opens page.html in its ?record frame, in the given style and units, and waits until the player is ready.
 *  Returns { browser, page }; close the browser when done. */
export async function openRecord(file, { style = 'line', units = 'metric' } = {}) {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--hide-scrollbars'] });
  const page = await browser.newPage();
  await confine(page, path.dirname(path.resolve(file)));
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  await page.goto(`${pathToFileURL(file).href}?record&style=${style}&units=${units}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => window.READY || document.fonts.ready);
  return { browser, page };
}

/** The scenes' ids, starts and lengths, as the page timed them. */
export const scenes = page => page.evaluate(() => window.TUTORIAL.scenes.map(s => ({ id: s.id, start: s.start, dur: s.dur })));

/** Draws the frame for time t. */
export const renderAt = (page, t) => page.evaluate(t => window.renderAt(t), t);
