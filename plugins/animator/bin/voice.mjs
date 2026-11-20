#!/usr/bin/env node
// Makes a job's narration with AssemblyAI text-to-speech: one MP3 per scene, and a -us.mp3 where the scene's US
// narration differs. Writes them to <job-dir>/audio/ with durations.json (each file's length in seconds).
//
//   node voice.mjs <job-dir> <voice-id>            every scene
//   node voice.mjs <job-dir> <voice-id> s1,si      only those scenes, keeping the others' clips and lengths
//   node voice.mjs voices                           the suggested narrator voices
//
// Needs ASSEMBLYAI_API_KEY, in the environment or in a .env file. The key is sent only to the speech endpoint, which is
// https://tts.us.assemblyai.com/v1/speech unless ASSEMBLYAI_TTS_URL says otherwise (the tests point it at a local
// stand-in). Lifted from tools/voice/make-voice.mjs, which made the prototype's narration.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// The key can live in ANIMATOR_ENV_FILE's path or a .env file in the folder the job is made from. A key already set in
// the environment is kept. A .env file beside the plugin is never read: the marketplace that holds it is not the person's.
const ENV_FILE = process.env.ANIMATOR_ENV_FILE || path.resolve('.env');
// Only ASSEMBLYAI_API_KEY is taken from the file: nothing else in it reaches this process or the programs it runs.
if (ENV_FILE && existsSync(ENV_FILE) && !process.env.ASSEMBLYAI_API_KEY) {
  const m = readFileSync(ENV_FILE, 'utf8').match(/^\s*(?:export\s+)?ASSEMBLYAI_API_KEY\s*=\s*["']?([^"'\s#]+)/m);
  if (m) process.env.ASSEMBLYAI_API_KEY = m[1];
}
const URL_SPEECH = process.env.ASSEMBLYAI_TTS_URL || 'https://tts.us.assemblyai.com/v1/speech';
const KEY = process.env.ASSEMBLYAI_API_KEY;

// Calm, even English voices that suit a narrator. The full catalogue is at
// https://www.assemblyai.com/dashboard/text-to-speech/voices
export const SUGGESTED = [
  ['aai-nancy', 'Nancy', 'British woman, middle-aged, fairly even tone'],
  ['aai-carrie', 'Carrie', 'British woman, middle-aged, soft-spoken'],
  ['aai-yasmin', 'Yasmin', 'British woman, middle-aged, expressive'],
  ['aai-audrey', 'Audrey', 'American woman, middle-aged, even and steady'],
  ['aai-peter', 'Peter', 'American man, middle-aged, soft-spoken'],
  ['aai-gunnar', 'Gunnar', 'English, older man, fairly slow pace'],
  ['aai-steven', 'Steven', 'Australian man, middle-aged, fairly even tone'],
  ['aai-troy', 'Troy', 'Scottish man, young, soft-spoken and deep'],
];

function fail(msg) { console.error(`voice: ${msg}`); process.exit(1); }

async function speak(voiceId, text) {
  const res = await fetch(URL_SPEECH, {
    method: 'POST',
    headers: { Authorization: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice_id: voiceId, language: 'english', encoding: 'mp3', bit_rate: 128000, sample_rate: 44100, stream: false }),
  });
  if (!res.ok) fail(`AssemblyAI said ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** A clip's length in seconds, with afinfo on a Mac or ffprobe elsewhere. */
function seconds(file) {
  try { const m = execFileSync('afinfo', [file], { encoding: 'utf8' }).match(/estimated duration:\s*([\d.]+)/); if (m) return +(+m[1]).toFixed(2); } catch {}
  try { return +(+execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim()).toFixed(2); } catch {}
  return null;
}

const [first, voiceId, only] = process.argv.slice(2);
if (first === 'voices') {
  for (const [id, name, desc] of SUGGESTED) console.log(`${id.padEnd(12)} ${name.padEnd(8)} ${desc}`);
  process.exit(0);
}
if (!first || !voiceId) fail('usage: node voice.mjs <job-dir> <voice-id> [scene,ids] | node voice.mjs voices');
if (!KEY) fail('ASSEMBLYAI_API_KEY is not set: put ASSEMBLYAI_API_KEY=<your key> in a .env file in this folder');

const script = JSON.parse(await readFile(path.join(first, 'script.json'), 'utf8'));
const ONLY = only ? new Set(only.split(',')) : null;
for (const s of script.scenes) if (!/^[A-Za-z][\w-]*$/.test(s.id || '')) fail(`scene id ${JSON.stringify(s.id)} must be a letter then letters, digits, - or _`);
if (ONLY) for (const id of ONLY) if (!script.scenes.some(s => s.id === id)) fail(`no scene ${id} in script.json`);
const out = path.join(first, 'audio');
await mkdir(out, { recursive: true });
let durations = { voice_id: voiceId, service: 'assemblyai', files: {} };
if (ONLY) {
  try { durations = JSON.parse(await readFile(path.join(out, 'durations.json'), 'utf8')); }
  catch { fail('no audio/durations.json yet: run without a scene list first'); }
}
for (const [units, field] of [['metric', 'vo'], ['us', 'voUS']]) {
  for (const s of script.scenes) {
    if (ONLY && !ONLY.has(s.id)) continue;
    const text = s[field];
    if (!text || (units === 'us' && text === s.vo)) continue; // same words in both units: the metric clip serves both
    const name = units === 'us' ? `${s.id}-us.mp3` : `${s.id}.mp3`;
    const file = path.join(out, name);
    await writeFile(file, await speak(voiceId, text));
    durations.files[name] = seconds(file);
    if (!durations.files[name]) fail(`could not measure ${name}`);
    console.log(`${name} ${durations.files[name]} s`);
  }
}
await writeFile(path.join(out, 'durations.json'), JSON.stringify(durations, null, 1) + '\n');
console.log(`voice: ${Object.keys(durations.files).length} clips in ${out}`);
