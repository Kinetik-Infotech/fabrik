// The timer's parts: the job launchd loads, the launcher that finds the plugin, the timed check and its log. launchctl
// is a stand-in in every test (fakeLaunchctl), so no test loads a real job.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL, renderPlist, timerPaths, turnOff, turnOn, writeLog } from "../mcp/timer.mjs";
import { runTimedCheck } from "../mcp/timed-check.mjs";
import { LOCK } from "../mcp/pull.mjs";
import { fakeLaunchctl } from "./stand-ins.mjs";

const NODE = "/opt/homebrew/bin/node";
const home = () => mkdtempSync(join(tmpdir(), "wa-timer-"));
const on = (h, extra = {}) => {
  const launchd = fakeLaunchctl();
  const r = turnOn({ folder: join(h, "fabrik"), home: h, node: NODE, run: launchd.run, uid: 501, platform: "darwin", sleep: () => {}, ...extra });
  return { r, launchd };
};
const strings = xml => [...xml.matchAll(/<string>(.*?)<\/string>/g)].map(m => m[1]);
const run = (cmd, args, env) => new Promise(res => {
  const c = spawn(cmd, args, { env: { ...process.env, ...env } });
  c.on("exit", status => res(status));
});

test("the job runs the absolute node and the launcher every `hours`, and nothing else", () => {
  const h = home();
  const { r, launchd } = on(h, { hours: 3 });
  assert.equal(r.ok, true);
  const paths = timerPaths(h);
  const xml = readFileSync(paths.plist, "utf8");
  const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)[1];
  assert.deepEqual(strings(args), [NODE, paths.launcher]);
  assert.match(xml, /<key>StartInterval<\/key>\s*<integer>10800<\/integer>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<false\/>/);
  assert.deepEqual(strings(xml), [LABEL, NODE, paths.launcher, paths.log, paths.log]);
  assert.equal(statSync(paths.plist).mode & 0o777, 0o600);
  assert.equal(statSync(paths.launcher).mode & 0o777, 0o600);
  assert.match(readFileSync(paths.launcher, "utf8"), new RegExp(`const FOLDER = ${JSON.stringify(join(h, "fabrik")).replace(/[/.]/g, "\\$&")};`));
  if (process.platform === "darwin") assert.equal(spawnSync("plutil", ["-lint", paths.plist]).status, 0);
  assert.deepEqual(launchd.calls.find(c => c[0] === "bootstrap"), ["bootstrap", "gui/501", paths.plist]);
  assert.deepEqual(launchd.loaded(), [`gui/501/${LABEL}`]);
});

test("hours outside 1 to 24, or not whole, are refused, and nothing is written or loaded", () => {
  for (const hours of [0, 25, 1.5, -3]) {
    const h = home();
    const { r, launchd } = on(h, { hours });
    assert.equal(r.ok, false, String(hours));
    assert.equal(r.problem, `hours is a whole number from 1 to 24, not ${hours}.`);
    assert.equal(existsSync(timerPaths(h).plist), false);
    assert.deepEqual(launchd.calls, []);
  }
});

test("a bootstrap launchd refuses leaves no job file, and says what launchd answered", () => {
  const h = home();
  const launchd = fakeLaunchctl({ bootstrapStatus: 5 });
  const r = turnOn({ folder: h, home: h, node: NODE, run: launchd.run, uid: 501, platform: "darwin", sleep: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.problem, /launchctl bootstrap answered 5: Bootstrap failed: 5: Input\/output error/);
  assert.equal(launchd.calls.filter(c => c[0] === "bootstrap").length, 3);
  assert.equal(existsSync(timerPaths(h).plist), false);
});

test("turning it on again replaces the job, and off unloads it and deletes its files", () => {
  const h = home();
  const launchd = fakeLaunchctl();
  const opts = { folder: h, home: h, node: NODE, run: launchd.run, uid: 501, platform: "darwin", sleep: () => {} };
  turnOn({ ...opts, hours: 1 });
  turnOn({ ...opts, hours: 12 });
  assert.match(readFileSync(timerPaths(h).plist, "utf8"), /<integer>43200<\/integer>/);
  assert.deepEqual(launchd.loaded(), [`gui/501/${LABEL}`]);
  assert.deepEqual(turnOff({ home: h, run: launchd.run, uid: 501, sleep: () => {} }), { wasOn: true });
  assert.deepEqual(launchd.loaded(), []);
  for (const f of ["plist", "launcher", "state"]) assert.equal(existsSync(timerPaths(h)[f]), false, f);
  assert.deepEqual(turnOff({ home: h, run: launchd.run, uid: 501, sleep: () => {} }), { wasOn: false });
});

test("the launcher finds the plugin's new folder after an update", async () => {
  const h = home();
  on(h);
  const paths = timerPaths(h);
  const marks = join(h, "marks.txt");
  // Two installed versions, each with a timed check that writes its own name.
  const plugin = version => {
    const dir = join(h, ".claude", "plugins", "cache", "fabrik", "whatsapp", version);
    mkdirSync(join(dir, "mcp"), { recursive: true });
    writeFileSync(join(dir, "mcp", "timed-check.mjs"), `import { appendFileSync } from "node:fs";\nexport async function runTimedCheck({ folder }) { appendFileSync(${JSON.stringify(marks)}, "${version} " + folder + "\\n"); return 0; }\n`);
    return dir;
  };
  const install = dir => {
    mkdirSync(join(h, ".claude", "plugins"), { recursive: true });
    writeFileSync(join(h, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "whatsapp@fabrik": [{ scope: "user", installPath: dir, version: "x", lastUpdated: new Date().toISOString() }] } }));
  };
  install(plugin("0.2.4"));
  assert.equal(await run(process.execPath, [paths.launcher], { HOME: h }), 0);
  install(plugin("0.2.5"));
  assert.equal(await run(process.execPath, [paths.launcher], { HOME: h }), 0);
  assert.deepEqual(readFileSync(marks, "utf8").trim().split("\n"), [`0.2.4 ${join(h, "fabrik")}`, `0.2.5 ${join(h, "fabrik")}`]);

  // With the plugin gone, the launcher says so in the log.
  writeFileSync(join(h, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {} }));
  assert.equal(await run(process.execPath, [paths.launcher], { HOME: h }), 1);
  assert.match(readFileSync(paths.log, "utf8"), /^\S+Z stopped: The whatsapp plugin isn't installed\.$/m);
});

/** A home with a fabrik sign-in, and WhatsApp linked when `linked`. */
function signedIn(linked) {
  const h = home();
  const ref = join(h, ".config", "supabase-auth", "abcdefghijklmnopqrst");
  mkdirSync(ref, { recursive: true });
  writeFileSync(join(ref, "pat@example.com.json"), "{}");
  const keys = join(h, ".config", "fabrik", "whatsapp", "pat@example.com");
  if (linked) {
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(keys, "creds.json"), JSON.stringify({ me: { id: "447700900123:7@s.whatsapp.net" }, account: {} }));
  }
  return { h, keys, log: join(h, "check.log") };
}

test("a timed check skips while another check holds the lock, and connects nothing", async () => {
  const { h, keys, log } = signedIn(true);
  writeFileSync(join(keys, LOCK), String(process.pid));
  let connected = 0;
  const code = await runTimedCheck({ folder: h, home: h, log, hooks: { pullWhatsApp: async () => { connected += 1; return {}; } } });
  assert.equal(code, 0);
  assert.equal(connected, 0);
  assert.match(readFileSync(log, "utf8"), /^\S+Z skipped: another check was connected to WhatsApp\n$/);
});

test("a timed check with the link gone logs why and stops, and never links", async () => {
  const { h, log } = signedIn(false);
  let connected = 0;
  const code = await runTimedCheck({ folder: h, home: h, log, hooks: { pullWhatsApp: async () => { connected += 1; return {}; } } });
  assert.equal(code, 1);
  assert.equal(connected, 0);
  assert.match(readFileSync(log, "utf8"), /^\S+Z stopped: WhatsApp isn't linked on this computer\. Link it again in a Claude session\.\n$/);
});

test("the log keeps its last 500 lines", () => {
  const log = join(home(), "logs", "whatsapp-check.log");
  for (let i = 1; i <= 510; i += 1) writeLog(log, `line ${i}`);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  assert.equal(lines.length, 500);
  assert.equal(lines[0], "line 11");
  assert.equal(lines[499], "line 510");
});
