// fabrik setup --owner's sign-in page step: puts the folder build.mjs sign-in made up on the owner's Cloudflare Pages
// with Wrangler, Cloudflare's command-line tool, and returns the page's address. fabrik chat-page puts the chat page up
// the same way, with putUpPage.
//
// Wrangler runs with XDG_CONFIG_HOME set to ~/.config/fabrik/wrangler, so fabrik's Cloudflare sign-in is its own and
// never another Wrangler sign-in on the computer. When no one is signed in there, `wrangler login` opens the browser
// for the owner's Cloudflare sign-in or a new free account. The Pages project is fabrik-sign-in-<ref>, created when it
// is missing, and the address is read from `wrangler pages project list --json`.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

/** The Wrangler setup runs, through npx, at a fixed version. */
export const WRANGLER = ["npx", "--yes", "wrangler@4.123.0"];
/** The folder that holds fabrik's own Cloudflare sign-in, as XDG_CONFIG_HOME. */
export const wranglerHome = (home = homedir()) => join(home, ".config", "fabrik", "wrangler");
/** The folder setup makes one fabrik project's sign-in page in, beside fabrik's Cloudflare sign-in, never in the owner's folder. */
export const pageFolder = (ref, home = homedir()) => join(home, ".config", "fabrik", "sign-in", ref);
/** The Pages project of one fabrik project's sign-in page. */
export const pagesProject = ref => `fabrik-sign-in-${ref}`;

class PageStopped extends Error {}

/** Wrangler's last lines, with its colour codes taken out, as one sentence's worth of text. */
function lastLines(text, count = 6) {
  return text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-count).join("\n");
}

/**
 * Puts the sign-in page in `folder` up on Cloudflare Pages for the project `ref`, and returns its https address.
 * `ask(prompt)` answers a question and `say` prints a line. `wrangler` is the command that runs Wrangler; a test passes
 * a stand-in. Throws a PageStopped whose message is one plain line, with Wrangler's own last lines where it failed.
 */
export function putUpSignInPage({ ref, folder }, options = {}) {
  return putUpPage({ name: pagesProject(ref), folder, what: "sign-in page" }, options);
}

/** Puts the page in `folder` up on Cloudflare Pages as the project `name`, and returns its https address. `what` names
 * the page in what it says, such as "chat page". The options are putUpSignInPage's. */
export async function putUpPage({ name, folder, what }, { ask, say, wrangler = WRANGLER, home = homedir(), env = process.env } = {}) {
  // WRANGLER_NO_SKILLS_UPDATE_PROMPTS, and no terminal on Wrangler's input, keep Wrangler from asking questions of its own.
  const base = { ...env, XDG_CONFIG_HOME: wranglerHome(home), WRANGLER_SEND_METRICS: "false", WRANGLER_NO_SKILLS_UPDATE_PROMPTS: "true" };
  // npx and Wrangler read config files, such as .npmrc and wrangler.toml, from the folder they run in, and keep a
  // .wrangler cache there. They run in an empty folder only fabrik makes, never the owner's folder an agent can write to.
  const runFolder = join(wranglerHome(home), "run");
  mkdirSync(runFolder, { recursive: true, mode: 0o700 });
  let accountId = null;
  const run = (args, { terminal = false } = {}) => {
    const ran = spawnSync(wrangler[0], [...wrangler.slice(1), ...args], {
      cwd: runFolder, encoding: "utf8", env: accountId ? { ...base, CLOUDFLARE_ACCOUNT_ID: accountId } : base,
      stdio: terminal ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
    });
    if (ran.error?.code === "ENOENT") throw new PageStopped("npx was not found. It comes with Node.js: install Node.js again, then run this command again.");
    return { ok: ran.status === 0, out: ran.stdout ?? "", text: `${ran.stdout ?? ""}${ran.stderr ?? ""}` };
  };
  const json = ran => { try { return JSON.parse(ran.out); } catch { return null; } };
  const whoami = () => { const ran = run(["whoami", "--json"]); return json(ran) ?? { loggedIn: false }; };
  const failed = (what, ran) => new PageStopped(`${what} failed. Cloudflare's Wrangler said:\n${lastLines(ran.text) || "nothing"}`);

  say(`Putting your ${what} up on Cloudflare Pages. The first time, this downloads Cloudflare's Wrangler tool, which takes a minute.`);
  let me = whoami();
  if (!me.loggedIn) {
    say("A browser window opens for Cloudflare. Sign in, or make a free account, and allow Wrangler. Then come back here.");
    // Only the access the page needs; Wrangler adds offline_access itself.
    run(["login", "--scopes", "account:read", "user:read", "pages:write"], { terminal: true });
    me = whoami();
    if (!me.loggedIn) throw new PageStopped("Cloudflare's sign-in did not finish. Wrangler waits two minutes for you to sign in and allow it in the browser.");
  }
  const accounts = Array.isArray(me.accounts) ? me.accounts : [];
  if (accounts.length > 1) {
    accounts.forEach((a, i) => say(`${i + 1}. ${a.name}`));
    while (!accountId) {
      const n = Number((await ask(`Which Cloudflare account is for fabrik's ${what}? Type its number: `)).trim());
      if (Number.isInteger(n) && n >= 1 && n <= accounts.length) accountId = accounts[n - 1].id;
    }
  } else if (accounts.length === 1) accountId = accounts[0].id;
  say(`Signed in to Cloudflare as ${me.email ?? "you"}.`);

  const listed = () => {
    const ran = run(["pages", "project", "list", "--json"]);
    const rows = json(ran);
    if (!ran.ok || !Array.isArray(rows)) throw failed("Listing your Cloudflare Pages projects", ran);
    return rows.find(r => r["Project Name"] === name);
  };
  if (!listed()) {
    const made = run(["pages", "project", "create", name, "--production-branch", "main"]);
    if (!made.ok) throw failed(`Creating the Pages project ${name}`, made);
  }
  const deployed = run(["pages", "deploy", folder, "--project-name", name, "--branch", "main"]);
  if (!deployed.ok) throw failed(`Putting your ${what} up`, deployed);
  const domain = String(listed()?.["Project Domains"] ?? "").split(",").map(d => d.trim()).find(d => /^[a-z0-9-]+\.pages\.dev$/.test(d));
  if (!domain) throw new PageStopped(`Cloudflare shows no pages.dev address for ${name}.`);
  return `https://${domain}`;
}
