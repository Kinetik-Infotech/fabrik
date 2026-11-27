// The sign-in page step against a stand-in for Cloudflare's Wrangler, which keeps its sign-in, accounts and Pages
// projects in a state file and logs each call with the settings it ran under. It finds its sign-in folder by Wrangler's
// own rule: os.homedir()/.wrangler when that folder exists, otherwise $XDG_CONFIG_HOME/.wrangler. A sign-in folder
// holding a file config/other.json is someone else's Wrangler sign-in, and whoami answers as that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountsFile, pagesProject, putUpSignInPage, wranglerHome } from "../cli/sign-in-page.mjs";
import { workerFolder } from "../cli/chat-domain.mjs";

const REF = "abcdefghijklmnopqrst";
const NAME = pagesProject(REF);

const WRANGLER = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const state = new URL("wrangler-state.json", import.meta.url);
const s = JSON.parse(readFileSync(state, "utf8"));
const args = process.argv.slice(2);
const legacy = join(homedir(), ".wrangler");
const dir = existsSync(legacy) ? legacy : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), ".wrangler");
const other = existsSync(join(dir, "config", "other.json")) ? JSON.parse(readFileSync(join(dir, "config", "other.json"), "utf8")) : null;
appendFileSync(new URL("wrangler.log", import.meta.url), JSON.stringify({ args, tty: Boolean(process.stdin.isTTY), noSkills: process.env.WRANGLER_NO_SKILLS_UPDATE_PROMPTS ?? null, cwd: process.cwd(), xdg: process.env.XDG_CONFIG_HOME, dir, token: process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? null, account: process.env.CLOUDFLARE_ACCOUNT_ID ?? null }) + "\\n");
const save = () => writeFileSync(state, JSON.stringify(s));
const cmd = args.join(" ");
if (cmd === "whoami --json") {
  if (other) { console.log(JSON.stringify({ loggedIn: true, email: other.email, accounts: other.accounts })); process.exit(0); }
  if (!s.signedIn) { console.log(JSON.stringify({ loggedIn: false })); process.exit(1); }
  console.log(JSON.stringify({ loggedIn: true, email: "olive@owner.example", accounts: s.accounts, ...(s.scopes ? { tokenPermissions: s.scopes } : {}) }));
} else if (args[0] === "login") { mkdirSync(join(dir, "config"), { recursive: true }); writeFileSync(join(dir, "config", "default.toml"), "fabrik"); s.signedIn = s.loginWorks; if (s.scopes) s.scopes = [...(s.grants ?? args.slice(2)), "offline_access"]; save(); }
else if (cmd === "pages project list --json") {
  console.log(JSON.stringify(s.projects.map(p => ({ "Project Name": p, "Project Domains": p + "-3x7.pages.dev", "Git Provider": "No" }))));
} else if (args.slice(0, 3).join(" ") === "pages project create") { s.projects.push(args[3]); save(); console.log("Successfully created the project."); }
else if (args.slice(0, 2).join(" ") === "pages deploy") {
  if (s.refuseDeploy) { console.error("\\u001b[31m✘ [ERROR]\\u001b[0m A request to the Cloudflare API failed. Project not found. [code: 8000007]"); process.exit(1); }
  s.deployed = args[2]; save(); console.log("✨ Deployment complete!");
} else { console.error("unexpected: " + cmd); process.exit(9); }
`;

function stage(t, state, env = process.env) {
  const dir = mkdtempSync(join(tmpdir(), "fabrik-wrangler-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "wrangler.mjs"), WRANGLER);
  writeFileSync(join(dir, "wrangler-state.json"), JSON.stringify({ signedIn: true, loginWorks: true, accounts: [{ id: "acc-1", name: "Olive's Account" }], projects: [], ...state }));
  const page = join(dir, "sign-in");
  mkdirSync(page);
  const said = [], asked = [];
  const answers = [];
  const go = () => putUpSignInPage({ ref: REF, folder: page }, {
    say: line => said.push(line), ask: async prompt => { asked.push(prompt); return answers.shift() ?? ""; },
    wrangler: [process.execPath, join(dir, "wrangler.mjs")], home: join(dir, "home"), env,
  });
  const log = () => readFileSync(join(dir, "wrangler.log"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  const st = () => JSON.parse(readFileSync(join(dir, "wrangler-state.json"), "utf8"));
  // Signs the stand-in in, in `folder`, as someone else with their own accounts, as another Wrangler sign-in would.
  const otherSignIn = (folder, who) => { mkdirSync(join(folder, "config"), { recursive: true }); writeFileSync(join(folder, "config", "other.json"), JSON.stringify(who)); };
  return { go, said, asked, answers, log, st, page, home: join(dir, "home"), dir, otherSignIn };
}

test("no one signed in: the browser sign-in runs, the project is made, the page deployed and its address read, all under fabrik's own Wrangler sign-in", async t => {
  const s = stage(t, { signedIn: false });
  assert.equal(await s.go(), `https://${NAME}-3x7.pages.dev`);
  assert.deepEqual(s.log().map(x => x.args.join(" ")), ["whoami --json", "login --scopes account:read user:read pages:write zone:read workers:write workers_scripts:write", "whoami --json", "pages project list --json",
    `pages project create ${NAME} --production-branch main`, `pages deploy ${s.page} --project-name ${NAME} --branch main`, "pages project list --json"]);
  assert.ok(s.log().every(x => x.xdg === wranglerHome(s.home)), "every call uses fabrik's own sign-in");
  // Wrangler asks nothing of its own, such as installing its skills: no call has a terminal to answer on.
  assert.ok(s.log().every(x => x.tty === false && x.noSkills === "true"), JSON.stringify(s.log()));
  // npx and Wrangler read config files where they run, so they run in an empty folder only fabrik makes.
  assert.ok(s.log().every(x => realpathSync(x.cwd) === realpathSync(join(wranglerHome(s.home), "run"))), JSON.stringify(s.log().map(x => x.cwd)));
  assert.equal(s.st().deployed, s.page);
  assert.ok(s.said.includes("A browser window opens for Cloudflare. Sign in, or make a free account, and allow Wrangler. Then come back here."), s.said.join("\n"));
  assert.ok(s.said.includes("Signed in to Cloudflare as olive@owner.example."), s.said.join("\n"));
  assert.deepEqual(s.asked, []);
});

test("signed in, with the project there: no sign-in, no second project, the page deployed again", async t => {
  const s = stage(t, { projects: [NAME] });
  assert.equal(await s.go(), `https://${NAME}-3x7.pages.dev`);
  assert.ok(!s.log().some(x => x.args[0] === "login" || x.args.includes("create")), JSON.stringify(s.log()));
  assert.ok(s.log().every(x => x.account === "acc-1" || x.args[0] === "whoami"), "the one account is named on each call after whoami");
});

test("a sign-in from before fabrik put the chat pages on a Worker signs in again once, asking for the Worker scopes, and a full one doesn't", async t => {
  const s = stage(t, { scopes: ["user:read", "offline_access", "account:read", "pages:write", "zone:read"] });
  await s.go();
  assert.deepEqual(s.log().filter(x => x.args[0] === "login").map(x => x.args.join(" ")), ["login --scopes account:read user:read pages:write zone:read workers:write workers_scripts:write"]);
  assert.ok(s.said.includes("fabrik needs Cloudflare's permission to read your domains and put your chat pages on them. A browser window opens for Cloudflare. Allow Wrangler, then come back here."), s.said.join("\n"));
  await s.go();
  assert.equal(s.log().filter(x => x.args[0] === "login").length, 1, "the second run signs in no more");
});

test("a sign-in that still lacks the Worker scopes stops and says so, rather than going on without them", async t => {
  const s = stage(t, { scopes: ["user:read", "offline_access", "account:read", "pages:write", "zone:read"], grants: ["account:read", "user:read", "pages:write", "zone:read"] });
  await assert.rejects(s.go(), { message: "Cloudflare's sign-in didn't give fabrik workers:write and workers_scripts:write. Run the command again, and allow Wrangler everything it asks for in the browser." });
  assert.ok(!s.log().some(x => x.args[0] === "pages"), "nothing is put up");
});

test("a sign-in that sees two accounts: the owner picks one by number, asked again off the list, and every call after names it", async t => {
  const s = stage(t, { accounts: [{ id: "acc-1", name: "Olive's Account" }, { id: "acc-2", name: "Olive's Business" }] });
  s.answers.push("5", "2");
  await s.go();
  assert.equal(s.asked.length, 2);
  assert.ok(s.said.includes("2. Olive's Business"), s.said.join("\n"));
  assert.ok(s.log().filter(x => x.args[0] === "pages").every(x => x.account === "acc-2"), JSON.stringify(s.log()));
});

test("a browser sign-in that does not finish: one plain line, and nothing created", async t => {
  const s = stage(t, { signedIn: false, loginWorks: false });
  await assert.rejects(s.go(), e => e.message === "Cloudflare's sign-in did not finish. Wrangler waits two minutes for you to sign in and allow it in the browser.");
  assert.ok(!s.log().some(x => x.args[0] === "pages"));
});

test("a deploy Cloudflare refuses: Wrangler's own words, without its colour codes", async t => {
  const s = stage(t, { refuseDeploy: true });
  await assert.rejects(s.go(), e => e.message === "Putting your sign-in page up failed. Cloudflare's Wrangler said:\n✘ [ERROR] A request to the Cloudflare API failed. Project not found. [code: 8000007]");
});

test("a ~/.wrangler holding another person's Cloudflare sign-in, and a Cloudflare token in the environment, are never used, read or written", async t => {
  const dir = mkdtempSync(join(tmpdir(), "fabrik-home-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The person's own Wrangler sign-in, in ~/.wrangler, is another business's account.
  const legacy = join(dir, ".wrangler");
  const s = stage(t, { signedIn: false }, { ...process.env, HOME: dir, USERPROFILE: dir, CLOUDFLARE_API_TOKEN: "someone-else's", CF_API_TOKEN: "someone-else's", CLOUDFLARE_ACCOUNT_ID: "acc-other" });
  s.otherSignIn(legacy, { email: "other@else.example", accounts: [{ id: "acc-other", name: "Someone Else's Account" }] });
  const before = readFileSync(join(legacy, "config", "other.json"), "utf8");
  assert.equal(await s.go(), `https://${NAME}-3x7.pages.dev`);
  assert.ok(s.log().every(x => x.dir === join(wranglerHome(s.home), ".wrangler")), JSON.stringify(s.log().map(x => x.dir)));
  assert.ok(s.log().every(x => x.token === null), "no Cloudflare token from the environment reaches Wrangler");
  assert.ok(s.log().some(x => x.args[0] === "login"), "fabrik's own sign-in, empty, signs in through the browser");
  assert.ok(s.log().filter(x => x.args[0] === "pages").every(x => x.account === "acc-1"), JSON.stringify(s.log()));
  assert.equal(readFileSync(join(legacy, "config", "other.json"), "utf8"), before);
  assert.ok(!existsSync(join(legacy, "config", "default.toml")), "the browser sign-in is not written to ~/.wrangler");
  assert.ok(existsSync(join(wranglerHome(s.home), ".wrangler", "config", "default.toml")), "it is written to fabrik's own sign-in folder");
});

test("the account a project's pages go on is saved the first time, and a later sign-in without it stops, naming both, and puts nothing up", async t => {
  const s = stage(t, { projects: [NAME] });
  await s.go();
  assert.deepEqual(JSON.parse(readFileSync(accountsFile(s.home), "utf8")), { [REF]: { id: "acc-1", name: "Olive's Account" } });
  // fabrik's sign-in is now someone else's, on another account.
  s.otherSignIn(join(wranglerHome(s.home), ".wrangler"), { email: "other@else.example", accounts: [{ id: "acc-other", name: "Someone Else's Account" }] });
  const calls = s.log().length;
  await assert.rejects(s.go(), { message: "fabrik's Cloudflare sign-in is other@else.example, with the Cloudflare account Someone Else's Account (acc-other), but this fabrik's pages are on the Cloudflare account Olive's Account (acc-1). fabrik put nothing up. "
    + `To sign fabrik in to Cloudflare as a person on Olive's Account, delete the folder ${join(wranglerHome(s.home), ".wrangler")}, then run this command again in a terminal, and sign in in the browser.` });
  assert.deepEqual(s.log().slice(calls).map(x => x.args.join(" ")), ["whoami --json"]);
});

test("a sign-in that sees several accounts, one of them the saved one: no question, and every call names the saved account", async t => {
  const s = stage(t, { projects: [NAME], accounts: [{ id: "acc-1", name: "Olive's Account" }, { id: "acc-2", name: "Olive's Business" }] });
  mkdirSync(wranglerHome(s.home), { recursive: true });
  writeFileSync(accountsFile(s.home), JSON.stringify({ [REF]: { id: "acc-2", name: "Olive's Business" } }));
  await s.go();
  assert.deepEqual(s.asked, []);
  assert.ok(s.log().filter(x => x.args[0] === "pages").every(x => x.account === "acc-2"), JSON.stringify(s.log()));
});

test("a project put up before accounts were saved keeps its chat Worker's account: a sign-in without it stops, and one with it saves it", async t => {
  const s = stage(t, { projects: [NAME], accounts: [{ id: "acc-1", name: "Olive's Account" }] });
  mkdirSync(workerFolder(REF, s.home), { recursive: true });
  writeFileSync(join(workerFolder(REF, s.home), "wrangler.json"), JSON.stringify({ name: "fabrik-chat-x", account_id: "acc-2" }));
  await assert.rejects(s.go(), { message: "fabrik's Cloudflare sign-in is olive@owner.example, with the Cloudflare account Olive's Account (acc-1), but this fabrik's pages are on the Cloudflare account acc-2. fabrik put nothing up. "
    + `To sign fabrik in to Cloudflare as a person on acc-2, delete the folder ${join(wranglerHome(s.home), ".wrangler")}, then run this command again in a terminal, and sign in in the browser.` });
  assert.ok(!s.log().some(x => x.args[0] === "pages"), "nothing is put up");
  assert.ok(!existsSync(accountsFile(s.home)), "no account is saved");
  writeFileSync(join(s.dir, "wrangler-state.json"), JSON.stringify({ ...s.st(), accounts: [{ id: "acc-1", name: "Olive's Account" }, { id: "acc-2", name: "Olive's Business" }] }));
  await s.go();
  assert.deepEqual(s.asked, []);
  assert.deepEqual(JSON.parse(readFileSync(accountsFile(s.home), "utf8")), { [REF]: { id: "acc-2", name: "Olive's Business" } });
  assert.ok(s.log().filter(x => x.args[0] === "pages").every(x => x.account === "acc-2"), JSON.stringify(s.log()));
});
