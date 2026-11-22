// The timer: launchd, the Mac's own scheduler, runs one WhatsApp check every few hours, with no Claude session and no
// Claude model. The person turns it on and off by asking Claude, through whatsapp_timer.
//
// Turning it on writes two files and loads one job:
// - the launcher, ~/.config/fabrik/whatsapp/timed-check.mjs. On each run it reads the plugin's current folder from
//   Claude's installed_plugins.json and runs that folder's timed-check.mjs, so an update needs no new timer. It names
//   the fabrik folder that turned the timer on, whose sign-in the check uses.
// - the job, ~/Library/LaunchAgents/tech.fabrik.whatsapp-check.plist, which runs `node <launcher>` every `hours`.
//   renderPlist is lifted from maxy-code's create-maxy-code/src/launchd-plist.ts.
//
// Every launchctl call goes through `launchctl`, a function the tests replace, so no test loads a real job.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const LABEL = "tech.fabrik.whatsapp-check";
export const DEFAULT_HOURS = 6;
/** The lines the log keeps. */
export const LOG_LINES = 500;

/** Where the timer's files live under `home`. */
export function timerPaths(home = homedir(), label = LABEL) {
  return {
    plist: join(home, "Library", "LaunchAgents", `${label}.plist`),
    launcher: join(home, ".config", "fabrik", "whatsapp", "timed-check.mjs"),
    state: join(home, ".config", "fabrik", "whatsapp", "timer.json"),
    log: join(home, "Library", "Logs", "fabrik", "whatsapp-check.log"),
  };
}

const xmlEscape = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * A launchd job as plist XML: { label, programArguments, stdoutPath, stderrPath, keepAlive, runAtLoad,
 * workingDirectory?, startInterval? }. Pure, and in the key order of Apple's examples.
 */
export function renderPlist(spec) {
  const lines = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`, `  <string>${xmlEscape(spec.label)}</string>`,
    `  <key>ProgramArguments</key>`, `  <array>`, ...spec.programArguments.map(a => `    <string>${xmlEscape(a)}</string>`), `  </array>`,
    `  <key>StandardOutPath</key>`, `  <string>${xmlEscape(spec.stdoutPath)}</string>`,
    `  <key>StandardErrorPath</key>`, `  <string>${xmlEscape(spec.stderrPath)}</string>`,
  ];
  if (spec.workingDirectory !== undefined) lines.push(`  <key>WorkingDirectory</key>`, `  <string>${xmlEscape(spec.workingDirectory)}</string>`);
  lines.push(`  <key>KeepAlive</key>`, `  ${spec.keepAlive ? "<true/>" : "<false/>"}`);
  lines.push(`  <key>RunAtLoad</key>`, `  ${spec.runAtLoad ? "<true/>" : "<false/>"}`);
  if (spec.startInterval !== undefined) lines.push(`  <key>StartInterval</key>`, `  <integer>${spec.startInterval}</integer>`);
  lines.push(`</dict>`, `</plist>`);
  return lines.join("\n") + "\n";
}

/**
 * The launcher's source. It finds the whatsapp plugin's current folder in installed_plugins.json on each run, so the
 * timer keeps working across plugin updates, and runs its timed-check.mjs for `folder`.
 */
export function renderLauncher({ folder, log }) {
  return `#!/usr/bin/env node
// Written by the whatsapp plugin's whatsapp_timer. launchd runs it, as ${LABEL}, to check WhatsApp with no Claude
// session. It runs the installed plugin's timed check for the fabrik folder below. Turn the timer off by asking
// Claude to stop checking WhatsApp on a timer.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const FOLDER = ${JSON.stringify(folder)};
const LOG = ${JSON.stringify(log)};

function stop(reason) {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, \`\${new Date().toISOString()} stopped: \${reason}\\n\`);
  process.exit(1);
}

let installed;
try { installed = JSON.parse(readFileSync(join(homedir(), ".claude", "plugins", "installed_plugins.json"), "utf8")); }
catch { stop("Claude's list of installed plugins couldn't be read, so the whatsapp plugin wasn't found."); }
const entries = [].concat(installed?.plugins?.["whatsapp@fabrik"] ?? []).filter(e => e?.installPath);
entries.sort((a, b) => String(b.lastUpdated ?? "").localeCompare(String(a.lastUpdated ?? "")));
if (!entries.length) stop("The whatsapp plugin isn't installed.");
const { runTimedCheck } = await import(pathToFileURL(join(entries[0].installPath, "mcp", "timed-check.mjs")).href)
  .catch(() => stop(\`The whatsapp plugin at \${entries[0].installPath} has no timed check. Update the plugin.\`));
process.exit(await runTimedCheck({ folder: FOLDER, log: LOG }));
`;
}

/** Runs launchctl and answers { status, stderr, stdout }. */
export function launchctl(args) {
  const r = spawnSync("launchctl", args, { encoding: "utf8", timeout: 15_000 });
  return { status: r.status, stderr: (r.stderr ?? "").trim(), stdout: r.stdout ?? "" };
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const readJson = file => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

/**
 * Removes the job from launchd, waiting until launchd no longer lists it. bootout answers as soon as launchd takes the
 * request, and a bootstrap while the old job is still listed fails with an input/output error.
 */
function unload(run, target, sleep) {
  run(["bootout", target]);
  for (let i = 0; i < 20; i += 1) {
    if (run(["print", target]).status !== 0) return;
    sleep(250);
  }
}

/**
 * Turns the timer on, or replaces it: writes the launcher and the job, readable by the person alone, and loads the
 * job. `hours` is a whole number from 1 to 24. Answers { ok, hours, next } or { ok: false, problem }.
 */
export function turnOn({ hours = DEFAULT_HOURS, folder, home = homedir(), node = process.execPath, run = launchctl, uid = process.getuid?.(), platform = process.platform, now = Date.now, sleep = pause, label = LABEL }) {
  if (platform !== "darwin") return { ok: false, problem: "The timer works on a Mac only, through launchd. On this computer, check WhatsApp in a Claude session." };
  if (!Number.isInteger(hours) || hours < 1 || hours > 24) return { ok: false, problem: `hours is a whole number from 1 to 24, not ${hours}.` };
  if (!folder) return { ok: false, problem: "The timer needs the fabrik folder whose sign-in it checks with." };
  const paths = timerPaths(home, label);
  mkdirSync(dirname(paths.launcher), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(paths.plist), { recursive: true });
  mkdirSync(dirname(paths.log), { recursive: true });
  writeFileSync(paths.launcher, renderLauncher({ folder, log: paths.log }), { mode: 0o600 });
  writeFileSync(paths.plist, renderPlist({
    label, programArguments: [node, paths.launcher], stdoutPath: paths.log, stderrPath: paths.log,
    keepAlive: false, runAtLoad: false, startInterval: hours * 3600,
  }), { mode: 0o600 });
  const target = `gui/${uid}/${label}`;
  unload(run, target, sleep);
  let boot;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    boot = run(["bootstrap", `gui/${uid}`, paths.plist]);
    // Only an input/output error, 5, is worth another try.
    if (boot.status !== 5) break;
    sleep(500);
  }
  if (boot.status !== 0) {
    rmSync(paths.plist, { force: true });
    return { ok: false, problem: `launchd didn't load the timer (launchctl bootstrap answered ${boot.status}${boot.stderr ? `: ${boot.stderr}` : ""}).` };
  }
  const since = new Date(now()).toISOString();
  writeFileSync(paths.state, JSON.stringify({ hours, folder, since }, null, 1), { mode: 0o600 });
  return { ok: true, hours, next: nextRun({ hours, since }, null, now) };
}

/** Turns the timer off: unloads the job and deletes its files. Answers { wasOn }. */
export function turnOff({ home = homedir(), run = launchctl, uid = process.getuid?.(), sleep = pause, label = LABEL } = {}) {
  const paths = timerPaths(home, label);
  const wasOn = existsSync(paths.plist);
  if (wasOn) unload(run, `gui/${uid}/${label}`, sleep);
  for (const file of [paths.plist, paths.launcher, paths.state]) rmSync(file, { force: true });
  return { wasOn };
}

/** The log's last line, or null. */
export function lastLogLine(log) {
  let text = "";
  try { text = readFileSync(log, "utf8"); } catch { return null; }
  const lines = text.split("\n").filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

/** The time a log line starts with, in ms, or null. */
const lineTime = line => { const t = Date.parse(line?.split(" ")[0] ?? ""); return Number.isNaN(t) ? null : t; };

/** The next run: an interval after the last run, or after the timer was turned on, moved past now. */
export function nextRun({ hours, since }, last, now = Date.now) {
  const every = hours * 3600_000;
  const at = now();
  let next = Math.max(Date.parse(since) || at, lineTime(last) ?? 0) + every;
  while (next <= at) next += every;
  return new Date(next).toISOString();
}

/** How the timer stands: { on, hours, folder, since, next, last } or { on: false, last }. */
export function timerStatus({ home = homedir(), now = Date.now, label = LABEL } = {}) {
  const paths = timerPaths(home, label);
  const last = lastLogLine(paths.log);
  const state = readJson(paths.state);
  if (!existsSync(paths.plist) || !state) return { on: false, last };
  return { on: true, hours: state.hours, folder: state.folder, since: state.since, next: nextRun(state, last, now), last };
}

/** Adds one line to the log, keeping its last LOG_LINES lines. */
export function writeLog(log, line, keep = LOG_LINES) {
  mkdirSync(dirname(log), { recursive: true });
  let lines = [];
  try { lines = readFileSync(log, "utf8").split("\n").filter(Boolean); } catch { /* new */ }
  lines.push(line);
  // Written in place, not renamed, so launchd's handle on the file for a failed start's output stays good.
  writeFileSync(log, lines.slice(-keep).join("\n") + "\n");
}
