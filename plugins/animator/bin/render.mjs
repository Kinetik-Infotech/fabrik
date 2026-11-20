#!/usr/bin/env node
// Renders a job, in the style and units its request.json asks for.
//
//   node render.mjs <job-dir> stills   one PNG per scene, at its last fully drawn frame, in stills/<scene>.png
//   node render.mjs <job-dir> video    video.mp4: every frame at 30 fps as H.264 (CRF 18), with one narration
//                                      track that places each scene's clip at its start + 0.5 s, as AAC 192k
//
// Needs Google Chrome (CHROME_PATH) and ffmpeg. Lifted from humantra-marketplace
// plugins/humantra-brand/skills/brand/examples/bilby-demo/record.js and its video-presentations.md.
import { readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { openRecord, scenes, renderAt } from './lib/chrome.mjs';

export const FPS = 30, LEAD = 0.5, SETTLED = 0.35;

function fail(msg) { console.error(`render: ${msg}`); process.exit(1); }

const [dir, mode] = process.argv.slice(2);
if (!dir || !['stills', 'video'].includes(mode)) fail('usage: node render.mjs <job-dir> stills|video');
const request = JSON.parse(readFileSync(path.join(dir, 'request.json'), 'utf8'));
const pageFile = path.resolve(dir, 'page.html');
if (!existsSync(pageFile)) fail(`${pageFile} is missing: run build.mjs first`);
const style = request.style || 'line', units = request.units === 'us' ? 'us' : 'metric';

const { browser, page } = await openRecord(pageFile, { style, units });
try {
  const list = await scenes(page);
  if (mode === 'stills') {
    const out = path.join(dir, 'stills');
    mkdirSync(out, { recursive: true });
    for (const s of list) {
      await renderAt(page, s.start + s.dur - SETTLED); // the last fully drawn frame, before the 0.3 s fade-out
      await page.screenshot({ path: path.join(out, `${s.id}.png`) });
    }
    console.log(`render: ${list.length} stills in ${out}`);
  } else {
    const total = await page.evaluate(() => window.TOTAL);
    const silent = path.join(dir, 'video-silent.mp4');
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-movflags', '+faststart', silent], { stdio: ['pipe', 'ignore', 'inherit'] });
    const closed = new Promise(r => ff.on('close', r));
    const n = Math.ceil(total * FPS), started = Date.now();
    for (let i = 0; i < n; i++) {
      await renderAt(page, i / FPS);
      const buf = await page.screenshot({ type: 'jpeg', quality: 95 });
      if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
      if (i % 900 === 0) console.log(`render: frame ${i} / ${n}`);
    }
    ff.stdin.end();
    if (await closed !== 0) fail('ffmpeg could not encode the frames');

    // One narration track: each scene's clip (the -us one where the units are US and it exists) at start + LEAD.
    const durations = JSON.parse(readFileSync(path.join(dir, 'audio', 'durations.json'), 'utf8'));
    const files = durations.files || durations;
    const clips = list.map(s => {
      const us = `${s.id}-us.mp3`, m = `${s.id}.mp3`;
      const name = units === 'us' && files[us] ? us : m;
      return files[name] ? { file: path.join(dir, 'audio', name), at: s.start + LEAD } : null;
    }).filter(Boolean);
    const inputs = clips.flatMap(c => ['-i', c.file]);
    const delays = clips.map((c, i) => `[${i + 1}:a]aresample=44100,adelay=${Math.round(c.at * 1000)}:all=1[a${i}]`).join(';');
    const mix = `${clips.map((_, i) => `[a${i}]`).join('')}amix=inputs=${clips.length}:normalize=0:dropout_transition=0[a]`;
    const video = path.join(dir, 'video.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', silent, ...inputs, '-filter_complex', `${delays};${mix}`, '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', total.toFixed(3), video], { stdio: 'inherit' });
    rmSync(silent);
    console.log(`render: ${video} (${n} frames, ${clips.length} clips, ${((Date.now() - started) / 1000).toFixed(0)} s)`);
  }
} finally { await browser.close(); }
