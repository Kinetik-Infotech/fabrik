#!/usr/bin/env node
// Builds a playable page from a scene script.
//
//   node build.mjs <script.json> <audio-dir> <out.html>
//
// The page is player/shell.html with the four style sheets, player.js, the script and the clip lengths from
// <audio-dir>/durations.json inlined. It plays the clips from <audio-dir>, by a path relative to <out.html>.
// Open it as is to play it; add ?record for the bare 1600 × 900 frame a recorder steps with window.renderAt(t).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { svgProblems } from './lib/svg-safe.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLAYER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'player');
const STYLES = ['line', 'storyboard', 'comic', 'anime'];
const SHORTHANDS = ['pop', 'fadeUp', 'fadeOut'];

function fail(msg) { console.error(`build: ${msg}`); process.exit(1); }

const [scriptPath, audioDir, outPath] = process.argv.slice(2);
if (!scriptPath || !audioDir || !outPath) fail('usage: node build.mjs <script.json> <audio-dir> <out.html>');

const readJson = (file, what) => {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) { fail(`cannot read ${what} ${file}: ${e.code || e.message}`); }
  try { return JSON.parse(text); } catch (e) { fail(`${what} ${file} is not JSON: ${e.message}`); }
};
const script = readJson(scriptPath, 'script');
const durations = readJson(path.join(audioDir, 'durations.json'), 'clip lengths');

// Only what the player cannot run without; the content checks are check.mjs's job.
const problems = [];
if (typeof script.title !== 'string' || !script.title) problems.push('title is missing');
if (!Array.isArray(script.scenes) || !script.scenes.length) problems.push('scenes is missing or empty');
const ids = new Set();
(script.scenes || []).forEach((s, i) => {
  const at = `scene ${s.id || i + 1}`;
  if (!/^[A-Za-z][\w-]*$/.test(s.id || '')) problems.push(`${at}: id must be a letter then letters, digits, - or _`);
  if (ids.has(s.id)) problems.push(`${at}: id is used twice`);
  ids.add(s.id);
  if (!(s.dur > 0)) problems.push(`${at}: dur must be a positive number of seconds`);
  if (typeof s.svg !== 'string' || !s.svg.trim()) problems.push(`${at}: svg is missing`);
  else for (const p of svgProblems(s.svg)) problems.push(`${at}: svg ${p}`);
  if (!Array.isArray(s.cap) || !s.cap.length) problems.push(`${at}: cap needs at least one caption`);
  else if (s.cap[0][0] !== 0) problems.push(`${at}: the first caption must start at 0`);
  if (s.capUS && (!Array.isArray(s.capUS) || s.capUS.length !== (s.cap || []).length)) problems.push(`${at}: capUS must have one entry per caption`);
  if (!Array.isArray(s.tw)) problems.push(`${at}: tw must be a list`);
  else s.tw.forEach((w, j) => {
    const short = SHORTHANDS.includes(w[0]);
    const ok = Array.isArray(w) && (short ? typeof w[1] === 'string' && typeof w[2] === 'number'
      : typeof w[0] === 'string' && typeof w[1] === 'number' && typeof w[2] === 'number' && w[3] && typeof w[3] === 'object');
    if (!ok) problems.push(`${at}: tween ${j + 1} ${JSON.stringify(w)} is not [id, t0, t1, props, ease?] or [pop|fadeUp|fadeOut, id, t, d?]`);
  });
  if (s.clock !== null && s.clock !== undefined && !Array.isArray(s.clock)) problems.push(`${at}: clock must be null or [[t, minutes], …]`);
});
if (problems.length) fail('the script cannot be played:\n  ' + problems.join('\n  '));

// Inline JSON safely inside <script>: no "</script>" or "<!--" can end or bend the block.
const json = v => JSON.stringify(v).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, c => '\\u' + c.charCodeAt(0).toString(16));
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const outDir = path.dirname(path.resolve(outPath));
let audioRel = path.relative(outDir, path.resolve(audioDir)).split(path.sep).join('/');
audioRel = audioRel ? audioRel + '/' : './';

const styles = STYLES.map(n => `<style data-style="${n}">\n${readFileSync(path.join(PLAYER, 'styles', n + '.css'), 'utf8')}</style>`).join('\n');
const data = `<script type="application/json" id="script-data">${json(script)}</script>\n`
  + `<script type="application/json" id="durations-data">${json(durations)}</script>`;
const fill = {
  '{{TITLE}}': esc(script.title),
  '{{TITLE_LOWER}}': esc(script.title.toLowerCase()),
  '{{STYLES}}': styles,
  '{{DATA}}': data,
  '{{PLAYER}}': readFileSync(path.join(PLAYER, 'player.js'), 'utf8').replace(/<\/script/gi, '<\\/script')
};
let page = readFileSync(path.join(PLAYER, 'shell.html'), 'utf8')
  .replace(/\{\{(TITLE|TITLE_LOWER|STYLES|DATA|PLAYER)\}\}/g, m => fill[m])
  .replace('<body>', `<body data-audio="${esc(audioRel)}">`);

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, page);
const clips = script.scenes.filter(s => durations.files && (durations.files[s.id + '.mp3'] || durations.files[s.id + '-us.mp3'])).length;
console.log(`build: wrote ${outPath} (${script.scenes.length} scenes, ${clips} with clips, audio from ${audioRel})`);
