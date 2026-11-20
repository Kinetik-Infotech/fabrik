// fabrik.mjs setup, run as a person runs it, with a home folder in a scratch folder. A stand-in for `claude`
// first on the PATH keeps the plugins it is given, answers their list, and records each call. A
// stand-in sign-in records its arguments and saves a session, and the folder's actor file, as the
// fabrik plugin's sign-in does.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installCommand, NODE_MAJOR } from "../cli/node-version.mjs";
import { MARKETPLACE } from "../cli/setup.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FABRIK = resolve(HERE, "../cli/fabrik.mjs");
// A client's project, as the person copies its address and publishable key from the dashboard.
const URL_ = "https://abcdefghijklmnopqrst.supabase.co", KEY = "sb_publishable_client";

const CLAUDE = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const state = new URL("claude-state.json", import.meta.url);
const s = existsSync(state) ? JSON.parse(readFileSync(state, "utf8")) : { marketplaces: ["fabrik"], plugins: [], fail: null };
const args = process.argv.slice(2);
appendFileSync(new URL("claude.log", import.meta.url), JSON.stringify(args) + "\\n");
const save = () => writeFileSync(state, JSON.stringify(s));
if (s.fail && args.join(" ").includes(s.fail)) { console.error("✘ Failed to install plugin: " + s.fail); process.exit(1); }
// A marketplace is its name, or { name, source, path } as Claude Code lists one added from a folder.
const listed = m => typeof m === "string" ? { name: m, source: "github", repo: "Kinetik-Infotech/fabrik" } : m;
const names = () => s.marketplaces.map(m => listed(m).name);
if (args.join(" ") === "plugin marketplace list --json") console.log(JSON.stringify(s.marketplaces.map(listed)));
else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "remove") {
  s.marketplaces = s.marketplaces.filter(m => listed(m).name !== args[3]);
  s.plugins = s.plugins.filter(id => !id.endsWith("@" + args[3]));
  console.log("✔ Successfully removed marketplace: " + args[3]);
  save();
}
else if (args.join(" ") === "plugin list --json") console.log(JSON.stringify(s.plugins.map(id => ({ id }))));
else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "add") {
  const file = args[3] + "/.claude-plugin/marketplace.json";
  const name = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).name : args[3].split("/")[1];
  console.log(names().includes(name) ? "Adding marketplace…✔ Marketplace '" + name + "' already on disk" : "Adding marketplace…✔ Successfully added marketplace: " + name);
  if (!names().includes(name)) s.marketplaces.push(name);
  save();
} else if (args[0] === "plugin" && args[1] === "install") {
  const id = args[2];
  console.log(s.plugins.includes(id) ? 'Installing plugin "' + id + '"...✔ Plugin "' + id + '" is already installed (scope: user)' : 'Installing plugin "' + id + '"...✔ Successfully installed plugin: ' + id + " (scope: user)");
  console.log("1 userConfig option not yet set — run /plugin configure " + id + " in Claude Code, or pass --config KEY=VALUE.");
  if (!s.plugins.includes(id)) s.plugins.push(id);
  save();
} else { console.error("unexpected: " + args.join(" ")); process.exit(9); }
`;

const SIGN_IN = `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const args = process.argv.slice(2);
appendFileSync(new URL("sign-in.log", import.meta.url), JSON.stringify(args) + "\\n");
const value = name => args[args.indexOf(name) + 1];
const ref = args.includes("--url") ? new URL(value("--url")).hostname.split(".")[0] : value("--project");
const email = value("--email");
mkdirSync(join(homedir(), ".config", "supabase-auth", ref), { recursive: true });
writeFileSync(join(homedir(), ".config", "supabase-auth", ref, email + ".json"), "{}");
if (args.includes("--folder")) writeFileSync(join(value("--folder"), ".fabrik-actor.json"), JSON.stringify({ auth_email: email, project_ref: ref }));
console.log("Signed in as " + email + ".");
`;

function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), "fabrik-setup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), home = join(root, "home");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(bin, "claude.mjs"), CLAUDE);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, "claude.mjs")}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "claude.cmd"), `@"${process.execPath}" "${join(bin, "claude.mjs")}" %*\r\n`);
  writeFileSync(join(bin, "sign-in.mjs"), SIGN_IN);
  const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: home, USERPROFILE: home, FABRIK_SETUP_SIGN_IN: join(bin, "sign-in.mjs"),
    // The needed Node version stands in for this one, so the tests run on any Node; one test gives another.
    FABRIK_NODE_VERSION: `${NODE_MAJOR}.0.0` };
  const lines = file => existsSync(join(bin, file)) ? readFileSync(join(bin, file), "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  const s = {
    home, bin,
    setup: (...args) => s.setupOn({}, ...args),
    setupOn: (extra, ...args) => {
      for (const file of ["claude.log", "sign-in.log"]) rmSync(join(bin, file), { force: true });
      const ran = spawnSync(process.execPath, [FABRIK, "setup", ...args], { env: { ...env, ...extra }, encoding: "utf8" });
      return { status: ran.status, out: ran.stdout, err: ran.stderr, claude: lines("claude.log"), signIn: lines("sign-in.log") };
    },
    failOn: text => {
      const file = join(bin, "claude-state.json");
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), fail: text }));
    },
  };
  return s;
}

const EMAIL = "negotiator@example.com";
const CLIENT = ["--url", URL_, "--key", KEY];

test("setup needs the email, and the project's address with its key", t => {
  const s = scratch(t);
  for (const [args, problem] of [
    [["--folder", join(s.home, "x")], /^--email is needed\.\nUsage: /],
    [["--folder", join(s.home, "x"), "--email", EMAIL, "--url", URL_], /^--url and --key go together\.\nUsage: /],
    [["--folder", join(s.home, "x"), "--email", EMAIL, "--production"], /^--production is not an option of setup\.\nUsage: /],
  ]) {
    const ran = s.setup(...args);
    assert.equal(ran.status, 2, args.join(" "));
    assert.match(ran.err, problem);
  }
  assert.deepEqual(readdirSync(s.home), []);
});

test("setup on another Node version stops before any step, names the version, and gives the install command", t => {
  const s = scratch(t);
  const ran = s.setupOn({ FABRIK_NODE_VERSION: "24.21.0" }, "--folder", join(s.home, "fabrik"), "--email", EMAIL);
  assert.equal(ran.status, 1, ran.out);
  assert.equal(ran.err, `Node is not version 26. This computer has Node.js 24.21.0, and fabrik needs Node.js 26. Install it with:\n  ${installCommand()}\nThen open a new terminal, and check it with: node -v\n`);
  assert.equal(ran.out, "");
  assert.deepEqual(ran.claude, []);
  assert.deepEqual(ran.signIn, []);
  assert.deepEqual(readdirSync(s.home), []);
});

test("setup on another Node version with a mistyped option gives the usage first, with exit code 2", t => {
  const s = scratch(t);
  const ran = s.setupOn({ FABRIK_NODE_VERSION: "24.21.0" }, "--emial", EMAIL);
  assert.equal(ran.status, 2, ran.err);
  assert.match(ran.err, /^--emial is not an option of setup\.\nUsage: /);
  assert.doesNotMatch(ran.err, /Node is not version/);
});

test("the install command is the user guide's for each system", () => {
  assert.equal(installCommand("darwin"), `cd "\$(mktemp -d)" && curl -fsSLO https://nodejs.org/dist/latest-v26.x/SHASUMS256.txt && f=\$(awk '/\\.pkg$/{print $2}' SHASUMS256.txt) && curl -fsSLO "https://nodejs.org/dist/latest-v26.x/$f" && grep " $f$" SHASUMS256.txt | shasum -a 256 -c && sudo installer -pkg "$f" -target /`);
  assert.equal(installCommand("win32"), "winget install OpenJS.NodeJS");
  assert.equal(installCommand("linux", 26, "ubuntu"), "sudo snap install node --channel=26/stable --classic");
  assert.equal(installCommand("linux", 26, "debian"), "curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash - && sudo apt-get install -y nodejs");
  assert.equal(installCommand("linux", 26, null), "Install Node.js 26 from https://nodejs.org.");
});

test("setup --owner takes only --folder, since there is no project to sign in to yet", t => {
  const s = scratch(t);
  for (const [extra, named] of [[["--email", EMAIL], "--email"], [CLIENT, "--url, --key"], [["--agent", "acme:assistant"], "--agent"], [["--new-password"], "--new-password"]]) {
    const ran = s.setup("--owner", "--folder", join(s.home, "fabrik"), ...extra);
    assert.equal(ran.status, 2, extra.join(" "));
    assert.ok(ran.err.startsWith(`--owner takes only --folder, since there is no project to sign in to yet: leave out ${named}.\nUsage: `), ran.err);
  }
  assert.deepEqual(readdirSync(s.home), []);
});

test("setup makes the person's folder and its agent setting, installs the fabrik plugin, and signs in with the folder", t => {
  const s = scratch(t);
  const folder = join(s.home, "fabrik");
  const ran = s.setup("--folder", folder, "--email", EMAIL, ...CLIENT, "--new-password");
  assert.equal(ran.status, 0, ran.err);
  assert.deepEqual(JSON.parse(readFileSync(join(folder, ".claude", "settings.json"), "utf8")), { agent: "fabrik:assistant" });
  assert.deepEqual(ran.claude.filter(args => !args.includes("--json")), [["plugin", "install", "fabrik@fabrik"]]);
  assert.deepEqual(ran.signIn, [["--new-password", ...CLIENT, "--folder", folder, "--email", EMAIL]]);
  assert.deepEqual(JSON.parse(readFileSync(join(folder, ".fabrik-actor.json"), "utf8")), { auth_email: EMAIL, project_ref: "abcdefghijklmnopqrst" });
  assert.doesNotMatch(ran.out, /userConfig/);
  assert.ok(ran.out.endsWith(`Done. Start a new Code session on ${folder}, and type: who am I?\n`), ran.out);
});

test("setup adds the fabrik marketplace from GitHub when Claude Code has none, before it installs the plugin", t => {
  const s = scratch(t);
  writeFileSync(join(s.bin, "claude-state.json"), JSON.stringify({ marketplaces: [], plugins: [], fail: null }));
  const folder = join(s.home, "fabrik");
  const ran = s.setup("--folder", folder, "--email", EMAIL, ...CLIENT, "--new-password");
  assert.equal(ran.status, 0, ran.err);
  assert.deepEqual(ran.claude.filter(args => !args.includes("--json")), [["plugin", "marketplace", "add", "Kinetik-Infotech/fabrik"], ["plugin", "install", "fabrik@fabrik"]]);
  assert.match(ran.out, /Adding the fabrik marketplace from GitHub, Kinetik-Infotech\/fabrik\.\n/);
  // Run again, the marketplace is there, so it is not added twice.
  const again = s.setup("--folder", folder, "--email", EMAIL, ...CLIENT);
  assert.ok(!again.claude.some(args => args[2] === "add"), JSON.stringify(again.claude));
});

test("setup turns on updates for the fabrik marketplace in Claude Code's settings, keeping every other setting", t => {
  const s = scratch(t);
  writeFileSync(join(s.bin, "claude-state.json"), JSON.stringify({ marketplaces: [], plugins: [], fail: null }));
  mkdirSync(join(s.home, ".claude"), { recursive: true });
  const settings = join(s.home, ".claude", "settings.json");
  writeFileSync(settings, JSON.stringify({ model: "opus", extraKnownMarketplaces: { other: { source: { source: "github", repo: "a/b" } },
    fabrik: { source: { source: "github", repo: "Kinetik-Infotech/fabrik" } } } }));
  const ran = s.setup("--folder", join(s.home, "fabrik"), "--email", EMAIL, ...CLIENT, "--new-password");
  assert.equal(ran.status, 0, ran.err);
  const kept = JSON.parse(readFileSync(settings, "utf8"));
  assert.deepEqual(kept, { model: "opus", extraKnownMarketplaces: { other: { source: { source: "github", repo: "a/b" } },
    fabrik: { source: { source: "github", repo: "Kinetik-Infotech/fabrik" }, autoUpdate: true } } });
  assert.match(ran.out, /Turned on updates for the fabrik marketplace/);
  const again = s.setup("--folder", join(s.home, "fabrik"), "--email", EMAIL, ...CLIENT);
  assert.match(again.out, /Updates for the fabrik marketplace are on\./);
});

test("setup replaces a fabrik marketplace added from a folder with the one on GitHub, and installs the plugin from it", t => {
  const s = scratch(t);
  writeFileSync(join(s.bin, "claude-state.json"), JSON.stringify({
    marketplaces: [{ name: "fabrik", source: "directory", path: "/Users/someone/fabrik-code" }], plugins: ["fabrik@fabrik"], fail: null }));
  const folder = join(s.home, "fabrik");
  const ran = s.setup("--folder", folder, "--email", EMAIL, ...CLIENT, "--new-password");
  assert.equal(ran.status, 0, ran.err);
  assert.deepEqual(ran.claude.filter(args => !args.includes("--json")),
    [["plugin", "marketplace", "remove", "fabrik"], ["plugin", "marketplace", "add", "Kinetik-Infotech/fabrik"], ["plugin", "install", "fabrik@fabrik"]]);
  assert.match(ran.out, /Replacing the fabrik marketplace from \/Users\/someone\/fabrik-code with the one on GitHub, Kinetik-Infotech\/fabrik\.\n/);
});

test("setup replaces a fabrik marketplace from another GitHub repository, and keeps fabrik's own", t => {
  const s = scratch(t);
  writeFileSync(join(s.bin, "claude-state.json"), JSON.stringify({
    marketplaces: [{ name: "fabrik", source: "github", repo: "someone-else/fabrik" }], plugins: ["fabrik@fabrik"], fail: null }));
  const folder = join(s.home, "fabrik");
  const ran = s.setup("--folder", folder, "--email", EMAIL, ...CLIENT, "--new-password");
  assert.equal(ran.status, 0, ran.err);
  assert.deepEqual(ran.claude.filter(args => !args.includes("--json")),
    [["plugin", "marketplace", "remove", "fabrik"], ["plugin", "marketplace", "add", "Kinetik-Infotech/fabrik"], ["plugin", "install", "fabrik@fabrik"]]);
  assert.match(ran.out, /Replacing the fabrik marketplace from someone-else\/fabrik with the one on GitHub, Kinetik-Infotech\/fabrik\.\n/);
  // Run again, the marketplace is fabrik's own, so it is kept.
  const again = s.setup("--folder", folder, "--email", EMAIL);
  assert.ok(!again.claude.some(args => args[2] === "remove" || args[2] === "add"), JSON.stringify(again.claude));
});

test("setup stops when Claude Code cannot list its marketplaces, and adds and installs nothing", t => {
  const s = scratch(t);
  writeFileSync(join(s.bin, "claude-state.json"), JSON.stringify({ marketplaces: [], plugins: [], fail: "marketplace list" }));
  const ran = s.setup("--folder", join(s.home, "fabrik"), "--email", EMAIL, ...CLIENT, "--new-password");
  assert.equal(ran.status, 1, ran.out);
  assert.ok(!ran.claude.some(args => args[2] === "add" || args[1] === "install"), JSON.stringify(ran.claude));
  assert.match(ran.err, /Claude Code could not list its plugin marketplaces/);
});

test("setup run again says each step is already done, and signs in no more", t => {
  const s = scratch(t);
  const folder = join(s.home, "fabrik");
  assert.equal(s.setup("--folder", folder, "--email", EMAIL, ...CLIENT, "--new-password").status, 0);
  const ran = s.setup("--folder", folder, "--email", EMAIL);
  assert.equal(ran.status, 0, ran.err);
  assert.deepEqual(ran.out.split("\n").slice(0, 5), [
    `${folder} is already there.`,
    `${join(folder, ".claude", "settings.json")} already names the fabrik:assistant agent.`,
    "Updates for the fabrik marketplace are on.",
    "The fabrik plugin is already installed.",
    `${folder} is already signed in as ${EMAIL}.`,
  ]);
  assert.deepEqual(ran.claude.filter(args => args[1] === "install"), []);
  assert.deepEqual(ran.signIn, []);
});

test("setup keeps a settings file's other settings", t => {
  const s = scratch(t);
  const folder = join(s.home, "fabrik");
  const file = join(folder, ".claude", "settings.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ permissions: { allow: ["Read"] }, agent: "other:agent" }));
  assert.equal(s.setup("--folder", folder, "--email", EMAIL, ...CLIENT).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { permissions: { allow: ["Read"] }, agent: "fabrik:assistant" });
});

test("setup --owner makes the owner's folder for the assistant, installs its plugin, then goes on to set fabrik up, which needs a terminal for the token", t => {
  const s = scratch(t);
  const folder = join(s.home, "fabrik");
  const ran = s.setup("--owner", "--folder", folder);
  assert.equal(ran.status, 1, ran.out + ran.err);
  assert.deepEqual(JSON.parse(readFileSync(join(folder, ".claude", "settings.json"), "utf8")), { agent: "fabrik:assistant" });
  assert.deepEqual(ran.claude.filter(args => args[1] === "install"), [["plugin", "install", "fabrik@fabrik"]]);
  assert.deepEqual(ran.signIn, []);
  assert.deepEqual(readdirSync(folder).sort(), [".claude"]);
  assert.ok(ran.out.startsWith(`Made ${folder}.\n`), ran.out);
  assert.ok(ran.out.includes("Make a Supabase access token at https://supabase.com/dashboard/account/tokens"), ran.out);
  assert.ok(ran.out.trimEnd().endsWith("Stopped: This command needs an interactive terminal."), ran.out);
});

test("setup with no --folder sets up ~/fabrik, for the owner and for the person", t => {
  const s = scratch(t);
  const folder = join(s.home, "fabrik");
  const owner = s.setup("--owner");
  assert.ok(owner.out.startsWith(`Made ${folder}.\n`), owner.out);
  const person = s.setup("--email", EMAIL, ...CLIENT);
  assert.equal(person.status, 0, person.err);
  assert.deepEqual(person.signIn, [[...CLIENT, "--folder", folder, "--email", EMAIL]]);
  assert.deepEqual(readdirSync(s.home).filter(n => !n.startsWith(".")), ["fabrik"]);
});

test("setup refuses an agent outside the marketplace, with the list of its agents", t => {
  const s = scratch(t);
  const folder = join(s.home, "other");
  for (const agent of ["someone:else", "acme:database-operator", "trip-agent:travel-agent"]) {
    const ran = s.setup("--folder", folder, "--email", EMAIL, "--agent", agent);
    assert.equal(ran.status, 1);
    assert.equal(ran.err, `${agent} is not an agent that works in fabrik. Its agents are: fabrik:assistant.\n`);
  }
  assert.equal(existsSync(folder), false);
});
