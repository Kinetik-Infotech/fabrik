// The sign-in page step against a stand-in for Cloudflare's Wrangler, which keeps its sign-in, accounts and Pages
// projects in a state file and logs each call with the settings it ran under.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pagesProject, putUpSignInPage, wranglerHome } from "../cli/sign-in-page.mjs";

const REF = "abcdefghijklmnopqrst";
const NAME = pagesProject(REF);

const WRANGLER = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const state = new URL("wrangler-state.json", import.meta.url);
const s = JSON.parse(readFileSync(state, "utf8"));
const args = process.argv.slice(2);
appendFileSync(new URL("wrangler.log", import.meta.url), JSON.stringify({ args, tty: Boolean(process.stdin.isTTY), noSkills: process.env.WRANGLER_NO_SKILLS_UPDATE_PROMPTS ?? null, cwd: process.cwd(), xdg: process.env.XDG_CONFIG_HOME, account: process.env.CLOUDFLARE_ACCOUNT_ID ?? null }) + "\\n");
const save = () => writeFileSync(state, JSON.stringify(s));
const cmd = args.join(" ");
if (cmd === "whoami --json") {
  if (!s.signedIn) { console.log(JSON.stringify({ loggedIn: false })); process.exit(1); }
  console.log(JSON.stringify({ loggedIn: true, email: "olive@owner.example", accounts: s.accounts }));
} else if (args[0] === "login") { s.signedIn = s.loginWorks; save(); }
else if (cmd === "pages project list --json") {
  console.log(JSON.stringify(s.projects.map(p => ({ "Project Name": p, "Project Domains": p + "-3x7.pages.dev", "Git Provider": "No" }))));
} else if (args.slice(0, 3).join(" ") === "pages project create") { s.projects.push(args[3]); save(); console.log("Successfully created the project."); }
else if (args.slice(0, 2).join(" ") === "pages deploy") {
  if (s.refuseDeploy) { console.error("\\u001b[31m✘ [ERROR]\\u001b[0m A request to the Cloudflare API failed. Project not found. [code: 8000007]"); process.exit(1); }
  s.deployed = args[2]; save(); console.log("✨ Deployment complete!");
} else { console.error("unexpected: " + cmd); process.exit(9); }
`;

function stage(t, state) {
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
    wrangler: [process.execPath, join(dir, "wrangler.mjs")], home: join(dir, "home"),
  });
  const log = () => readFileSync(join(dir, "wrangler.log"), "utf8").trim().split("\n").map(l => JSON.parse(l));
  const st = () => JSON.parse(readFileSync(join(dir, "wrangler-state.json"), "utf8"));
  return { go, said, asked, answers, log, st, page, home: join(dir, "home") };
}

test("no one signed in: the browser sign-in runs, the project is made, the page deployed and its address read, all under fabrik's own Wrangler sign-in", async t => {
  const s = stage(t, { signedIn: false });
  assert.equal(await s.go(), `https://${NAME}-3x7.pages.dev`);
  assert.deepEqual(s.log().map(x => x.args.join(" ")), ["whoami --json", "login --scopes account:read user:read pages:write", "whoami --json", "pages project list --json",
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
