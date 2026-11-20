#!/usr/bin/env node
// Makes a job's printable recipe card: card.html from script.json and request.json, printed to card.pdf on A4 by
// Chrome. The card has the title and what it makes (script.json's makes, such as "1 loaf", or else the servings), the ingredients in the request's units, what
// was left out and what replaced it, the equipment, and the method, step by step from the narration.
//
//   node card.mjs <job-dir>
//
// Needs Google Chrome (CHROME_PATH). Lifted from bin/lib/chrome.mjs; Chrome's page.pdf comes with puppeteer-core.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { CHROME, confine } from './lib/chrome.mjs';

/** The servings as a whole number from 1 to 12, so nothing else can reach the card's markup. */
const people = n => Math.min(12, Math.max(1, Math.round(Number(n)) || 1));

const NAMES = { celery: 'celery', gluten: 'gluten', crustaceans: 'crustaceans', eggs: 'eggs', fish: 'fish', lupin: 'lupin', milk: 'milk', molluscs: 'molluscs', mustard: 'mustard', nuts: 'tree nuts', peanuts: 'peanuts', sesame: 'sesame', soya: 'soya', sulphites: 'sulphites' };

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fail = msg =>{ console.error(`card: ${msg}`); process.exit(1); };

/** The card's HTML for a script and its request. */
export function cardHtml(script, request) {
  const us = request.units === 'us';
  const amount = i => us ? i.us : (i.grams == null ? (i.us || 'a little') : `${i.grams} g`);
  const left = [...(request.allergens ?? []).map(a => NAMES[a] ?? a), ...(request.allergensOther ?? [])];
  const subs = script.substitutes ?? [];
  const steps = script.scenes.filter(s => !['s1', 'si', 'se'].includes(s.id) && (us ? s.voUS || s.vo : s.vo));
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${esc(script.title)} · animated.recipes</title><style>
@page{size:A4;margin:16mm 16mm 18mm}
body{font:10.5pt/1.5 -apple-system,'Helvetica Neue',Arial,sans-serif;color:#151514;margin:0}
h1{font-size:24pt;line-height:1.05;letter-spacing:-.02em;margin:0 0 4pt;font-weight:600}
h2{font-size:9pt;letter-spacing:.08em;text-transform:uppercase;color:#67655f;margin:16pt 0 6pt;font-weight:600}
.meta{color:#67655f;margin:0 0 6pt}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:0 20pt}
table{width:100%;border-collapse:collapse}
td{padding:4pt 0;border-top:.5pt solid #ddd;vertical-align:top}
td.amt{white-space:nowrap;padding-right:10pt;font-weight:600;width:1%}
a{color:#0a5fa3;text-decoration:none}
.note{background:#f3f2ee;border-radius:6pt;padding:8pt 10pt;margin-top:10pt}
ol{margin:0;padding-left:16pt}
li{margin:0 0 6pt;break-inside:avoid}
li b{display:block}
ul.eq{margin:0;padding-left:14pt}
footer{margin-top:18pt;padding-top:6pt;border-top:.5pt solid #ddd;color:#67655f;font-size:8.5pt}
</style></head><body>
<h1>${esc(script.title)}</h1>
<p class="meta">${script.makes ? `Makes ${esc(script.makes)}` : `For ${people(script.servings)} ${people(script.servings) === 1 ? 'person' : 'people'}`} · ${us ? 'US measures' : 'metric'}</p>
${left.length ? `<div class="note"><strong>Left out:</strong> ${esc(left.join(', '))}.${subs.length ? ` ${subs.map(s => `${esc(s.use)} instead of ${esc(s.for)}`).join('; ')}.` : ''}</div>` : ''}
<div class="cols"><div>
<h2>Ingredients</h2>
<table>${script.ingredients.map(i => `<tr><td class="amt">${esc(amount(i))}</td><td>${esc(i.name)}</td></tr>`).join('')}</table>
</div><div>
<h2>Equipment</h2>
<ul class="eq">${(script.equipment ?? []).map(e => `<li>${esc(e)}</li>`).join('')}</ul>
</div></div>
<h2>Method</h2>
<ol>${steps.map(s => `<li><b>${esc(s.title)}</b>${esc(us ? s.voUS || s.vo : s.vo)}</li>`).join('')}</ol>
<footer>Made with animated.recipes.</footer>
</body></html>`;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2];
  if (!dir) fail('usage: node card.mjs <job-dir>');
  let script, request;
  try { script = JSON.parse(readFileSync(path.join(dir, 'script.json'), 'utf8')); request = JSON.parse(readFileSync(path.join(dir, 'request.json'), 'utf8')); }
  catch (e) { fail(`could not read script.json and request.json in ${dir}: ${e.message}`); }
  const html = path.resolve(dir, 'card.html'), pdf = path.resolve(dir, 'card.pdf');
  writeFileSync(html, cardHtml(script, request));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  try {
    const page = await browser.newPage();
    await confine(page, path.dirname(html));
    await page.goto(pathToFileURL(html).href, { waitUntil: 'load' });
    await page.pdf({ path: pdf, format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally { await browser.close(); }
  console.log(`card: ${pdf}`);
}
