#!/usr/bin/env node
// Checks a job before it is rendered. Prints one line per failure and exits 1 on any failure; prints nothing and
// exits 0 when everything passes.
//
//   node check.mjs <job-dir>                  every check
//   node check.mjs <job-dir> --before-voice   every check except the clips and the text layout, which need
//                                             audio/ and page.html
//
// The job folder holds request.json and script.json, and after narration and building, audio/durations.json and
// page.html.
//
// Checks:
//   uses       each ingredient's per-scene uses add up to its grams, within 1 g
//   us         each US amount is within 10% of the grams, through gPerCup or gPerTsp
//   allergens  no excluded allergen in ingredients, narration, captions or drawing text
//   rules      no banned ingredient (data/rules.json); wheat flour that isn't wholemeal says "unfortified"
//   clips      every scene has its clip, and a -us clip where its US narration differs
//   layout     at the last frame of each scene, no two visible texts overlap and none crosses the frame's edge
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { svgProblems } from './lib/svg-safe.mjs';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const ALLERGENS = JSON.parse(readFileSync(path.join(DATA, 'allergens.json'), 'utf8'));
const RULES = JSON.parse(readFileSync(path.join(DATA, 'rules.json'), 'utf8'));
const SETTLED = 0.35, TOLERANCE_G = 1, TOLERANCE_US = 0.10, OVERLAP_PX = 2, OVERLAP_SHARE = 0.2, FRAME = { w: 1600, h: 760 };

const fails = [];
const fail = (check, msg) => fails.push(`${check}: ${msg}`);
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---- text the cook sees or hears -------------------------------------------------------------------------------
// Entities are decoded, not dropped, so "sun&#102;lower oil" is read as "sunflower oil".
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', zwj: '', zwnj: '' };
const codePoint = (n, gap) => Number.isInteger(n) && n >= 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF) ? String.fromCodePoint(n) : gap;
// Zero-width characters (soft hyphens, zero-width spaces and joiners, format marks, variation selectors) are removed.
// Invalid, unassigned and private-use codes show as a glyph, so they are read both as a gap and as nothing: the text
// comes back in both readings, and a word found in either one is caught.
const reading = (t, gap) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#'
  ? codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)), gap)
  : ENTITIES[e.toLowerCase()] ?? gap).normalize('NFKC').replace(/[\p{Cf}\u00AD\uFE00-\uFE0F]/gu, '')
  .replace(/[\p{Cn}\p{Cs}\p{Co}\uFFFD]/gu, gap);
const decode = t => { const a = reading(t, ' '), b = reading(t, ''); return a === b ? a : `${a} | ${b}`; };
const svgText = svg => decode((svg || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const usText = svg => decode([...(svg || '').matchAll(/data-us=(["'])([\s\S]*?)\1/g)].map(m => m[2]).join(' ')).replace(/\s+/g, ' ').trim();
function corpus(script) {
  const items = [['title', script.title || ''], ['makes', script.makes || ''], ['equipment', (script.equipment || []).join(' ')],
    ['substitutes', (script.substitutes || []).map(s => s.use || '').join(' ')]];
  for (const i of script.ingredients || []) items.push([`ingredient ${i.id}`, `${i.name} ${i.us || ''}`]);
  for (const s of script.scenes || []) {
    items.push([`scene ${s.id} narration`, `${s.vo || ''} ${s.voUS || ''}`]);
    items.push([`scene ${s.id} captions`, [...(s.cap || []), ...(s.capUS || [])].map(c => Array.isArray(c) ? c[1] : c).join(' ')]);
    items.push([`scene ${s.id} drawing`, `${svgText(s.svg)} ${usText(s.svg)}`]);
  }
  return items;
}

/** The words of `words` found in `text`, whole-word, unless one of `unless` stands just before. */
function findWords(text, words, unless = []) {
  const not = unless.length ? `(?<!\\b(?:${unless.map(escape).join('|')})[\\s-]+)` : '';
  return words.filter(w => new RegExp(`${not}\\b${escape(w)}\\b`, 'i').test(text));
}

// ---- amounts ---------------------------------------------------------------------------------------------------
const FRACTIONS = { '¼': .25, '½': .5, '¾': .75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': .125, '⅜': .375, '⅝': .625, '⅞': .875 };
const UNITS = [[/^(cups?)$/, 'cup', 1], [/^(tbsp|tablespoons?)$/, 'tsp', 3], [/^(tsp|teaspoons?)$/, 'tsp', 1], [/^(oz|ounces?)$/, 'oz', 1], [/^(lbs?|pounds?)$/, 'oz', 16]];
/** "1½ cups + 1 tbsp" as { cup, tsp, oz } totals, or null when it is not a measured amount ("a little", "1 large"). */
export function parseUs(us) {
  const out = { cup: 0, tsp: 0, oz: 0 };
  const parts = String(us).split('+').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    const m = part.match(/^(?:scant |heaped |about )?(\d+)?\s*([¼½¾⅓⅔⅛⅜⅝⅞]|\d+\/\d+)?\s+([a-z]+)\b/i) || part.match(/^(\d+)?([¼½¾⅓⅔⅛⅜⅝⅞])\s*([a-z]+)\b/i);
    if (!m || (!m[1] && !m[2])) return null;
    let n = m[1] ? +m[1] : 0;
    if (m[2]) n += m[2].includes('/') ? m[2].split('/').reduce((a, b) => a / b) : FRACTIONS[m[2]];
    const unit = UNITS.find(([re]) => re.test(m[3].toLowerCase()));
    if (!unit) return null;
    out[unit[1]] += n * unit[2];
  }
  return out;
}

function checkUses(script) {
  const byId = new Map((script.ingredients || []).map(i => [i.id, i]));
  const used = new Map();
  for (const s of script.scenes || []) for (const u of s.uses || []) {
    if (!byId.has(u.ingredient)) { fail('uses', `scene ${s.id} uses ${u.ingredient}, which is not in the ingredients`); continue; }
    used.set(u.ingredient, (used.get(u.ingredient) || 0) + u.grams);
  }
  for (const i of byId.values()) {
    if (typeof i.grams !== 'number') continue;
    const n = used.get(i.id) || 0;
    if (Math.abs(n - i.grams) > TOLERANCE_G) fail('uses', `${i.id}: the scenes use ${n} g, the ingredients list says ${i.grams} g`);
  }
}

function checkUs(script) {
  for (const i of script.ingredients || []) {
    if (typeof i.grams !== 'number') continue;
    const us = parseUs(i.us || '');
    if (!us) { fail('us', `${i.id}: "${i.us}" is not a US amount this check can read`); continue; }
    let grams = us.oz * 28.3495;
    if (us.cup) { if (!i.gPerCup) { fail('us', `${i.id}: "${i.us}" is in cups but the ingredient has no gPerCup`); continue; } grams += us.cup * i.gPerCup; }
    if (us.tsp) { if (!i.gPerTsp) { fail('us', `${i.id}: "${i.us}" is in spoons but the ingredient has no gPerTsp`); continue; } grams += us.tsp * i.gPerTsp; }
    if (Math.abs(grams - i.grams) > TOLERANCE_US * i.grams) fail('us', `${i.id}: "${i.us}" is about ${Math.round(grams)} g, not ${i.grams} g`);
  }
}

function checkAllergens(script, request) {
  const excluded = request.allergens || [];
  for (const code of excluded) if (!ALLERGENS[code]) fail('allergens', `the request names "${code}", which is not one of the 14 allergens`);
  const items = corpus(script);
  for (const i of script.ingredients || []) for (const a of i.allergens || []) if (excluded.includes(a)) fail('allergens', `ingredient ${i.id} (${i.name}) contains ${a}`);
  for (const code of excluded) {
    const a = ALLERGENS[code]; if (!a) continue;
    for (const [where, text] of items) for (const w of findWords(text, a.words, a.unless)) fail('allergens', `${code}: "${w}" in ${where}`);
  }
  for (const word of request.allergensOther || []) for (const [where, text] of items) if (findWords(text, [word]).length) fail('allergens', `"${word}" in ${where}`);
}

function checkRules(script) {
  for (const [where, text] of corpus(script)) for (const w of findWords(text, RULES.banned)) fail('rules', `"${w}" in ${where}`);
  for (const i of script.ingredients || []) {
    if (!/\bflour\b/i.test(i.name)) continue;
    if (RULES.flourExempt.some(w => new RegExp(`\\b${escape(w)}\\b`, 'i').test(i.name))) continue;
    if (!new RegExp(`\\b${RULES.flourMustSay}\\b`, 'i').test(i.name)) fail('rules', `ingredient ${i.id} (${i.name}) must say "${RULES.flourMustSay}"`);
  }
}

function checkClips(script, durations) {
  const files = durations.files || durations;
  for (const s of script.scenes || []) {
    if (!files[`${s.id}.mp3`]) fail('clips', `scene ${s.id} has no clip ${s.id}.mp3`);
    if (s.voUS && s.voUS !== s.vo && !files[`${s.id}-us.mp3`]) fail('clips', `scene ${s.id} has US narration but no clip ${s.id}-us.mp3`);
  }
}

async function checkLayout(pageFile) {
  const { openRecord, scenes, renderAt } = await import('./lib/chrome.mjs');
  const { browser, page } = await openRecord(pageFile);
  try {
    for (const s of await scenes(page)) {
      await renderAt(page, s.start + s.dur - SETTLED); // the last fully drawn frame, before the 0.3 s fade-out
      const boxes = await page.evaluate(() => {
        const svg = document.querySelector('svg.art'), inv = svg.getScreenCTM().inverse();
        const seen = el => { for (let e = el; e && e !== svg; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.02) return false; } return true; };
        return [...svg.querySelectorAll('text')].filter(t => t.textContent.trim() && seen(t)).map(t => {
          const r = t.getBoundingClientRect(), a = new DOMPoint(r.left, r.top).matrixTransform(inv), b = new DOMPoint(r.right, r.bottom).matrixTransform(inv);
          return { text: t.textContent.trim(), x1: a.x, y1: a.y, x2: b.x, y2: b.y };
        });
      });
      for (const b of boxes) if (b.x1 < -OVERLAP_PX || b.y1 < -OVERLAP_PX || b.x2 > FRAME.w + OVERLAP_PX || b.y2 > FRAME.h + OVERLAP_PX) fail('layout', `scene ${s.id}: "${b.text}" crosses the frame's edge`);
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1), h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        // A text box includes the font's space above and below the letters, so lines set close together always touch;
        // a clash is an overlap deeper than a fifth of the shorter box (two 84 px title lines touch by 12 of 102 px).
        if (w > OVERLAP_PX && h > OVERLAP_SHARE * Math.min(a.y2 - a.y1, b.y2 - b.y1)) fail('layout', `scene ${s.id}: "${a.text}" overlaps "${b.text}"`);
      }
    }
  } finally { await browser.close(); }
}

// ---- run -------------------------------------------------------------------------------------------------------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, flag] = process.argv.slice(2);
  if (!dir) { console.error('usage: node check.mjs <job-dir> [--before-voice]'); process.exit(2); }
  const read = f => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  const request = read('request.json'), script = read('script.json');
  for (const s of script.scenes || []) for (const p of svgProblems(s.svg)) fail('drawing', `scene ${s.id}: ${p}`);
  checkUses(script); checkUs(script); checkAllergens(script, request); checkRules(script);
  if (flag !== '--before-voice') {
    const d = path.join(dir, 'audio', 'durations.json');
    if (!existsSync(d)) fail('clips', 'audio/durations.json is missing'); else checkClips(script, JSON.parse(readFileSync(d, 'utf8')));
    const p = path.join(dir, 'page.html');
    if (!existsSync(p)) fail('layout', 'page.html is missing'); else if (!fails.some(f => f.startsWith('drawing:'))) await checkLayout(p);
  }
  for (const f of fails) console.log(f);
  process.exit(fails.length ? 1 : 0);
}
