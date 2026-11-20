// fabrik.mjs setup: sets up one person's folder from the Terminal. One folder works in one fabrik project as one
// person. It makes the folder, where the person puts files for their agent and the agent keeps its work, writes the
// folder's agent setting, installs the agent's plugin from the fabrik marketplace, and runs the sign-in with --folder,
// which writes the folder's actor file.
//
//   node fabrik.mjs setup [--folder <folder>] --email <email> [--url <project URL> --key <publishable key>] [--agent <plugin>:<agent>] [--new-password]
//   node fabrik.mjs setup --owner [--folder <folder>]
//
// The folder is ~/fabrik unless --folder names another.
//
// --owner is the owner's setup of fabrik: it makes the folder, names the assistant as its agent and installs its
// plugin, then sets fabrik up in the owner's Supabase project in one run, through Supabase's Management API, as
// owner-setup.mjs describes.
//
// Each step prints what it did, or that it was already done, so running it again is safe. A failed step
// stops the run with Claude Code's or the sign-in's message, and every step before it stays done.
import process from "node:process";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountEmail } from "./lib/session.mjs";
import { readActor } from "./lib/actor-file.mjs";
import { nodeMismatch } from "./node-version.mjs";
import { osMismatch } from "./os-version.mjs";
import { ASSISTANT, FABRIK_PLUGIN, fabrikAgents } from "./lib/session-folder.mjs";
import { ownerSetup } from "./owner-setup.mjs";
import { holdTyping } from "./management.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The marketplace this command runs from, such as Claude Code's copy of the fabrik marketplace. */
export const MARKETPLACE = resolve(HERE, "../../..");
/** The marketplace's name in Claude Code, which each plugin's id ends with. */
export const MARKETPLACE_NAME = "fabrik";
/** Where Claude Code adds the marketplace from: GitHub, so Claude Code keeps it in ~/.claude/plugins/marketplaces/fabrik,
 * where the agent and skills run the fabrik command, and claude plugin marketplace update fabrik brings new versions. */
export const MARKETPLACE_SOURCE = "Kinetik-Infotech/fabrik";
/** fabrik's one agent, the agent of every folder setup makes. */
export const DEFAULT_AGENT = ASSISTANT;
/** The folder's name in the home folder when --folder is left out. */
export const DEFAULT_FOLDER = "fabrik";

export const SETUP_USAGE = `Usage: node fabrik.mjs setup [--folder <folder>] --email <email> [--url <project URL> --key <publishable key>] [--agent <plugin>:<agent>] [--new-password]
       node fabrik.mjs setup --owner [--folder <folder>]

setup sets up a folder for one person in their fabrik: the folder, ~/${DEFAULT_FOLDER} unless --folder names
another, where you put files for your agent and your agent keeps its work, the agent the folder works with,
${DEFAULT_AGENT} unless --agent names another of the fabrik plugin's agents, the fabrik plugin itself, and
the person's sign-in as --email. A session opened on the folder then works as that person. --url and --key give
the project's address and publishable key, from the Supabase dashboard's Connect button; without them the sign-in
asks. --new-password replaces the first password.

--owner is for the owner. It makes the folder, names ${DEFAULT_AGENT} as the folder's agent, and installs its
plugin. Then it sets fabrik up in your Supabase project in one run: it asks for a Supabase access token, finds or
creates the project, builds fabrik, signs you in, puts up your sign-in page with one command you run, and makes the
settings of fabrik's connector. Run it again after a stop, and it carries on from where it stopped.`;

const VALUED = ["--email", "--folder", "--agent", "--url", "--key"];

/** The command line's options. */
export function parseSetup(argv) {
  const out = { newPassword: false, owner: false };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === "--new-password") out.newPassword = true;
    else if (word === "--owner") out.owner = true;
    else if (VALUED.includes(word)) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error(`${word} needs a value.`);
      out[word.slice(2)] = argv[++i];
    } else throw new Error(`${word} is not an option of setup.`);
  }
  if (out.owner) {
    const other = ["email", "url", "key", "agent"].filter(name => out[name] !== undefined).map(name => `--${name}`);
    if (out.newPassword) other.push("--new-password");
    if (other.length) throw new Error(`--owner takes only --folder, since there is no project to sign in to yet: leave out ${other.join(", ")}.`);
    out.agent = DEFAULT_AGENT;
    return out;
  }
  if (!out.email) throw new Error("--email is needed.");
  if (!accountEmail(out.email)) throw new Error(`${out.email} is not an email address.`);
  out.email = accountEmail(out.email);
  if ((out.url === undefined) !== (out.key === undefined)) throw new Error("--url and --key go together.");
  out.agent ??= DEFAULT_AGENT;
  return out;
}

/** Each agent that works in fabrik, from the fabrik plugin's folder in the marketplace. */
export function workingAgents(marketplace = MARKETPLACE) {
  const listed = JSON.parse(readFileSync(join(marketplace, ".claude-plugin", "marketplace.json"), "utf-8")).plugins ?? [];
  const source = listed.find(plugin => plugin.name === FABRIK_PLUGIN)?.source;
  return typeof source === "string" ? fabrikAgents(join(marketplace, source)) : [];
}

// On Windows, claude may be a .cmd that only a shell runs, and a shell takes one command line.
const shellWord = word => /[\s"&|<>^]/.test(word) ? `"${word.replaceAll('"', '\\"')}"` : word;
const claude = args => process.platform === "win32"
  ? spawnSync(`claude ${args.map(shellWord).join(" ")}`, { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "pipe"] })
  : spawnSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

class StepFailed extends Error {}

/** Runs one claude command, prints its message, and stops the run when it fails. */
function runClaude(args, say) {
  const ran = claude(args);
  const text = `${ran.stdout ?? ""}${ran.stderr ?? ""}`.trim();
  if (ran.error || ran.status !== 0) {
    const why = ran.error?.code === "ENOENT" || process.platform === "win32" && /is not recognized/.test(text)
      ? "The claude command was not found. Install Claude Code's command-line tool, then run setup again."
      : text || `claude ${args.join(" ")} stopped with exit code ${ran.status}.`;
    throw new StepFailed(why);
  }
  // A folder signed in with --folder needs none of the plugin's own settings.
  const shown = text.replace(/^Installing plugin "[^"]+"\.\.\./, "").split(/\r?\n/).filter(line => !/userConfig options? not yet set/.test(line)).join("\n");
  if (shown) say(shown);
  return ran.stdout ?? "";
}

/** The JSON a claude list command prints, or [] when it prints none. */
/** Claude Code's list, such as its plugin marketplaces. A list it cannot give stops setup, so nothing is added or
 * installed on a guess of what is there. */
function claudeList(args, what) {
  const ran = claude([...args, "--json"]);
  const stop = why => new StepFailed(`Claude Code could not list its ${what}: ${why}. Run setup again once claude ${args.join(" ")} works.`);
  if (ran.error || ran.status !== 0) throw stop(String(ran.error?.message ?? ran.stderr ?? "").trim() || `exit ${ran.status}`);
  let list;
  try { list = JSON.parse(ran.stdout); } catch { throw stop("its answer is not JSON"); }
  if (!Array.isArray(list)) throw stop("its answer is not a list");
  return list;
}

function makeFolder(folder, say) {
  if (existsSync(folder)) { say(`${folder} is already there.`); return; }
  mkdirSync(folder, { recursive: true });
  say(`Made ${folder}.`);
}

/** Writes the folder's .claude/settings.json with the agent, keeping every other setting in it. */
function writeAgentSetting(folder, agent, say) {
  const file = join(folder, ".claude", "settings.json");
  let settings = {};
  if (existsSync(file)) {
    try { settings = JSON.parse(readFileSync(file, "utf-8")); }
    catch { throw new StepFailed(`${file} is not JSON. Correct it or delete it, and run setup again.`); }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new StepFailed(`${file} is not a settings file. Correct it or delete it, and run setup again.`);
    if (settings.agent === agent) { say(`${file} already names the ${agent} agent.`); return; }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...settings, agent }, null, 2)}\n`);
  say(`${file} names the ${agent} agent.`);
}

/** True when a saved sign-in for the email on the project is on this computer. */
const signedIn = (home, ref, email) => existsSync(join(home, ".config", "supabase-auth", ref, `${email}.json`));

function runSignIn(signInPath, args, say) {
  say("Signing in. Type each password into the sign-in's own prompt.");
  const ran = spawnSync(process.execPath, [signInPath, ...args], { stdio: "inherit" });
  if (ran.status !== 0) throw new StepFailed(`The sign-in stopped${ran.status === null ? "" : ` with exit code ${ran.status}`}. Run setup again to sign in.`);
}

/**
 * Turns on updates for the fabrik marketplace in Claude Code's settings, ~/.claude/settings.json, so Claude Code fetches
 * each new release when a session starts. It sets `autoUpdate` on the marketplace's entry in `extraKnownMarketplaces`,
 * with fabrik's GitHub repository as its source, and keeps every other setting as it was. A settings file that isn't
 * JSON is left alone, and said.
 */
export function turnOnUpdates(home, say) {
  const file = join(home, ".claude", "settings.json");
  let settings = {};
  if (existsSync(file)) {
    try { settings = JSON.parse(readFileSync(file, "utf8")); }
    catch { say(`${file} isn't JSON, so updates for the ${MARKETPLACE_NAME} marketplace weren't turned on.`); return false; }
    if (settings === null || typeof settings !== "object" || Array.isArray(settings)) { say(`${file} isn't a settings object, so updates weren't turned on.`); return false; }
  }
  const known = settings.extraKnownMarketplaces && typeof settings.extraKnownMarketplaces === "object" ? settings.extraKnownMarketplaces : {};
  const entry = known[MARKETPLACE_NAME] ?? {};
  if (entry.autoUpdate === true && entry.source?.repo === MARKETPLACE_SOURCE) { say(`Updates for the ${MARKETPLACE_NAME} marketplace are on.`); return true; }
  known[MARKETPLACE_NAME] = { ...entry, source: { source: "github", repo: MARKETPLACE_SOURCE }, autoUpdate: true };
  settings.extraKnownMarketplaces = known;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  say(`Turned on updates for the ${MARKETPLACE_NAME} marketplace: Claude Code fetches each new release when a session starts.`);
  return true;
}

/**
 * Runs setup. `signInArgs` builds fabrik.mjs sign-in's arguments, and `signInPath` names the sign-in to run.
 * Returns 0 when every step is done, 1 when a step failed, and 2 for a wrong command line. With --owner, it returns a
 * promise of owner-setup.mjs's exit code, which may also be 3, run again later.
 */
export function setup(argv, { home = homedir(), signInArgs, signInPath, marketplace = MARKETPLACE, say = line => process.stdout.write(`${line}\n`), fail = line => process.stderr.write(`${line}\n`) } = {}) {
  let o;
  try { o = parseSetup(argv); }
  catch (err) { fail(`${err.message}\n${SETUP_USAGE}`); return 2; }
  const mismatch = nodeMismatch() ?? osMismatch();
  if (mismatch) { fail(mismatch); return 1; }
  try {
    const agents = workingAgents(marketplace);
    if (!agents.includes(o.agent)) throw new StepFailed(`${o.agent} is not an agent that works in ${MARKETPLACE_NAME}. Its agents are: ${agents.join(", ")}.`);
    // The owner pastes a token later: typing before its prompt is held unshown, as management.mjs's holdTyping says.
    if (o.owner) holdTyping();
    const folder = resolve(o.folder ?? join(home, DEFAULT_FOLDER));
    makeFolder(folder, say);
    writeAgentSetting(folder, o.agent, say);
    const plugin = FABRIK_PLUGIN;
    // Only fabrik's own repository on GitHub is kept. A marketplace added from a folder is read in place, so the fabrik
    // command is not where the agent runs it, and one from any other source is not fabrik's.
    const had = claudeList(["plugin", "marketplace", "list"], "plugin marketplaces").find(m => m.name === MARKETPLACE_NAME);
    const ours = had?.source === "github" && String(had.repo ?? "").toLowerCase() === MARKETPLACE_SOURCE.toLowerCase();
    if (had && !ours) {
      say(`Replacing the ${MARKETPLACE_NAME} marketplace from ${had.path ?? had.repo ?? had.url ?? had.source} with the one on GitHub, ${MARKETPLACE_SOURCE}.`);
      runClaude(["plugin", "marketplace", "remove", MARKETPLACE_NAME], say);
      runClaude(["plugin", "marketplace", "add", MARKETPLACE_SOURCE], say);
    } else if (!had) {
      say(`Adding the ${MARKETPLACE_NAME} marketplace from GitHub, ${MARKETPLACE_SOURCE}.`);
      runClaude(["plugin", "marketplace", "add", MARKETPLACE_SOURCE], say);
    }
    turnOnUpdates(home, say);
    if (claudeList(["plugin", "list"], "plugins").some(p => p.id === `${plugin}@${MARKETPLACE_NAME}`)) say(`The ${plugin} plugin is already installed.`);
    else {
      say(`Installing ${plugin}@${MARKETPLACE_NAME}.`);
      runClaude(["plugin", "install", `${plugin}@${MARKETPLACE_NAME}`], say);
    }
    if (o.owner) {
      return ownerSetup(["--folder", folder], { say });
    }
    const actor = readActor(folder);
    // --new-password always runs the sign-in, so a reset first password is replaced.
    if (!o.newPassword && actor?.ok && actor.value.auth_email === o.email && signedIn(home, actor.value.project_ref, o.email)) {
      say(`${folder} is already signed in as ${o.email}.`);
    } else {
      const where = o.url === undefined ? [] : ["--url", o.url, "--key", o.key];
      runSignIn(signInPath, signInArgs([...(o.newPassword ? ["--new-password"] : []), ...where, "--folder", folder, "--email", o.email], o.email).slice(1), say);
    }
    say(`Done. Start a new Code session on ${folder}, and type: who am I?`);
    return 0;
  } catch (err) {
    if (!(err instanceof StepFailed)) throw err;
    fail(err.message);
    return 1;
  }
}
