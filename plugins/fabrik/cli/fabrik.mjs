#!/usr/bin/env node
// fabrik from a terminal, for a person working without their agent. One command runs any of fabrik's
// database functions, and the fabrik plugin's file, drawing and printing tools, with the same code the
// plugin's MCP server runs, as the person signed in with sign-in.
//
//   node fabrik.mjs setup --folder <folder> --email <email> [--url <project URL> --key <publishable key>] [--agent <plugin>:<agent>] [--new-password]
//   node fabrik.mjs sign-in [--new-password] [--url <project URL> --key <publishable key>] [--folder <folder> --email <email>]
//   node fabrik.mjs setup --owner [--folder <folder>]
//   node fabrik.mjs sign-in --owner --url <project URL> --key <publishable key> --folder <setup folder>
//   node fabrik.mjs connector-settings --url <project URL> --site <sign-in page address>
//   node fabrik.mjs upgrade <signed upgrade file> [--project <ref> --email <email>]
//   node fabrik.mjs update --check | --apply
//   node fabrik.mjs chat-page [--domain <address>] [--project <ref> --email <email>]
//   node fabrik.mjs import maxy <export folder> [--project <ref> --email <email>] [--labels <label map>]
//   node fabrik.mjs [--project <ref> --email <email>] <name> [<argument>=<value> ...]
//
// A folder works in one client's project as one person. sign-in run in a folder with an actor file,
// .fabrik-actor.json, signs in again as the file's person, with the project's address and key saved at
// the first sign-in. upgrade applies one signed upgrade, as the signed-in administrator, from the request file
// scripts/sign-upgrade.mjs writes, or from an upgrade's .sql file with its .sig beside it. update brings the project up
// to the installed plugin, as update.mjs says. --folder signs in as --email and writes that folder's actor file, so a session
// opened on it works as that person. The first sign-in asks for the project's address and
// publishable key, unless --url and --key give them.
// SUPABASE_PROJECT_REF and SUPABASE_AUTH_EMAIL, set together, stand in for --project and --email.
// Without --project, a folder holding an actor file works as the file's person.
// A name starting fabrik_ is a fabrik function. An object, a list, a quoted string, true, false and null
// are sent as JSON, and anything else, numbers too, as text; <argument>=@<file> sends the JSON in the
// file, and <argument>.<field>=<value> sets one field of an object. A list of files may be given one
// file at a time. A file argument is a path in the current folder, which is both the folder files are
// read from and the folder results are written to.
import process from "node:process";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accountEmail, PROJECT_REF, readSession, UPLOAD_LIMIT } from "./lib/session.mjs";
import { createTools as databaseTools, TOOLS as DATABASE_TOOLS } from "./lib/tools.mjs";
import { createTools as pageTools, TOOLS as PAGE_TOOLS } from "./lib/pages.mjs";
import { readBrand } from "./lib/brand.mjs";
import { readActor } from "./lib/actor-file.mjs";
import { setup, SETUP_USAGE } from "./setup.mjs";
import { update, UPDATE_USAGE } from "./update.mjs";
import { connectorSettings, CONNECTOR_SETTINGS_USAGE } from "./connector-settings.mjs";
import { importMaxy, reportLines, LABEL_MAP, REPORT_FILE } from "./lib/import-maxy.mjs";
import { chatPage } from "./chat-page.mjs";
import { askLine } from "./management.mjs";

export const USAGE = `Usage: node fabrik.mjs setup [--folder <folder>] --email <email> [--url <project URL> --key <publishable key>] [--agent <plugin>:<agent>] [--new-password]
       node fabrik.mjs setup --owner [--folder <folder>]
       node fabrik.mjs sign-in [--new-password] [--second-factor] [--url <project URL> --key <publishable key>] [--folder <folder> --email <email>]
       node fabrik.mjs sign-in --owner --url <project URL> --key <publishable key> --folder <setup folder>
       node fabrik.mjs connector-settings --url <project URL> --site <sign-in page address>
       node fabrik.mjs upgrade <signed upgrade file> [--project <ref> --email <email>]
       node fabrik.mjs import maxy <export folder> [--project <ref> --email <email>] [--labels <label map>]
       node fabrik.mjs chat-page [--domain <address>] [--project <ref> --email <email>]
       node fabrik.mjs [--project <ref> --email <email>] <name> [<argument>=<value> ...]

setup sets up a folder for one person in their fabrik: the folder, ~/fabrik unless --folder
names another, where the person puts files for their agent and the agent keeps its work, the agent
the folder works with, its plugin, and the person's sign-in. With --owner, it sets up the owner's folder, then
sets fabrik up in the owner's Supabase project in one run, with a Supabase access token typed at a hidden prompt.
node fabrik.mjs setup --help says more.

sign-in signs you in to your business's fabrik and asks for your password. In a folder you signed in with
before, it signs you in again as that folder's person. --folder signs you in as --email, and saves the
folder's actor file: a session opened on that folder works as that email. The first sign-in asks for the project's address and publishable key, unless --url
and --key give them. --owner is the business's owner's first sign-in, at the end of setup: it asks your name, your
email and the password you choose, and makes your sign-in with the code setup left in the folder. With an
authenticator app on your account, sign-in asks for its six-digit code after your password. --second-factor adds an
authenticator app: it prints the secret and the otpauth:// address to add to the app, and asks for a code from it.

import maxy loads a maxy-code account, as scripts/maxy-export.mjs wrote it to a folder, into your fabrik, signed in as
its owner: each node a record in General, each relationship a link, each file into General's bucket, and a draft of the
public agent's KNOWLEDGE.md. It writes import-report.json in the folder, and exits 1 when something was left out for a
reason other than a label the import skips or a link with a missing end. Run again, it loads nothing twice.

chat-page builds a chat page for each public agent in your brand, from the Brand record, and a page that lists them. It
puts the pages up on Cloudflare Pages, with the Cloudflare sign-in fabrik's sign-in page uses, at an address on your own
domain, such as chat.example.com. It lists the domains on that Cloudflare account and asks which one, unless --domain
names the address. --domain pages.dev keeps the pages.dev address. Later runs use the same address without asking. It
prints each agent's page and the line that puts its chat button on any website. Run it again after you add or remove an agent.

upgrade applies one signed upgrade to your fabrik, as you, when you are an administrator. The file is the request
scripts/sign-upgrade.mjs writes. fabrik-upgrade applies it only when fabrik's upgrade key signed it, in order.

<name> is one of fabrik's functions, such as fabrik_show_record or fabrik_set_state, or one of these tools:
  ${[...DATABASE_TOOLS, ...PAGE_TOOLS].map(t => t.name).join(", ")}

An object, a list, a quoted string, true, false and null are sent as JSON, and anything else,
numbers too, as text. <argument>=@<file> sends the JSON in the file. <argument>.<field>=<value> sets one field of an object, and a list of files
may be given one file at a time. Files are read from and written to the current folder.
SUPABASE_PROJECT_REF and SUPABASE_AUTH_EMAIL, set together, stand in for --project and --email.
Without --project, a folder holding an actor file works as the person the file names.`;

const HERE = dirname(fileURLToPath(import.meta.url));
const SIGN_IN = resolve(HERE, "sign-in.mjs");
// The path is quoted for the person's shell, as the database tools quote their sign-in command.
const quote = value => process.platform === "win32" ? `"${value}"` : `'${String(value).replaceAll("'", `'\\''`)}'`;
const FABRIK_SIGN_IN = `node ${quote(resolve(HERE, "fabrik.mjs"))} sign-in`;
/** The plugin's id in Claude Code's settings: the fabrik plugin from the fabrik marketplace. */
export const PLUGIN_ID = "fabrik@fabrik";
/** Every fabrik function is in the fabrik schema. */
export const SCHEMA = "fabrik";

/** The email the person gave the fabrik plugin's settings at install, from Claude Code's settings, or null. */
export function settingsEmail(home = homedir(), configDir = process.env.CLAUDE_CONFIG_DIR) {
  try {
    const settings = JSON.parse(readFileSync(join(configDir || join(home, ".claude"), "settings.json"), "utf-8"));
    return accountEmail(settings?.pluginConfigs?.[PLUGIN_ID]?.options?.auth_email) || null;
  } catch { return null; }
}

/**
 * The sign-in's arguments. In a folder with an actor file and no other person named, it signs in
 * again as the file's person, in the file's project and folder. Otherwise it signs in as
 * the email given, or the settings' email, with the person's own options.
 */
export function signInArgs(argv, email, cwd = process.cwd()) {
  const named = argv.includes("--email") || argv.includes("--project") || argv.includes("--folder");
  if (!named) {
    const actor = readActor(cwd);
    if (actor && !actor.ok) throw new Error(actor.problem);
    if (actor) {
      // --url and --key are only for a first sign-in, which this is not.
      const rest = argv.filter((word, i) => !["--url", "--key"].includes(word) && !["--url", "--key"].includes(argv[i - 1]));
      return [SIGN_IN, "--project", actor.value.project_ref, "--email", actor.value.auth_email, "--folder", actor.folder, ...rest];
    }
  }
  email ??= settingsEmail();
  return [SIGN_IN, ...(email && !named ? ["--email", email] : []), ...argv];
}

// A tool argument that names a local file: a top-level `file`, or a name ending in _file or _files.
const isFileArgument = name => name === "file" || /_files?$/.test(name);

/** The command line's options, name and arguments. */
export function parse(argv, cwd = process.cwd()) {
  const out = { project: undefined, email: undefined, name: undefined, args: {} };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === "--project" || word === "--email") {
      if (argv[i + 1] === undefined) throw new Error(`${word} needs a value.`);
      out[word.slice(2)] = argv[++i];
    } else if (word === "--help" || word === "-h") {
      out.name = undefined;
      return out;
    } else if (out.name === undefined) {
      out.name = word;
    } else {
      const eq = word.indexOf("=");
      if (eq < 1) throw new Error(`${word} is not <argument>=<value>.`);
      const key = word.slice(0, eq), text = word.slice(eq + 1);
      const dot = key.indexOf(".");
      if (dot > 0) {
        // <argument>.<field>=<value> sets one field of an object argument, with no JSON to type.
        const [name, field] = [key.slice(0, dot), key.slice(dot + 1)];
        const held = out.args[name] ?? {};
        if (held === null || typeof held !== "object" || Array.isArray(held)) throw new Error(`${name} is given as a value and as fields.`);
        if (field in held) throw new Error(`${key} is given twice.`);
        out.args[name] = { ...held, [field]: value(field, text, cwd, false) };
      } else if (key in out.args) {
        // A file list may be given one file at a time.
        if (!/_files$/.test(key)) throw new Error(`${key} is given twice.`);
        out.args[key] = [].concat(out.args[key], value(key, text, cwd));
      } else {
        out.args[key] = value(key, text, cwd);
      }
    }
  }
  if ((out.project === undefined) !== (out.email === undefined)) throw new Error("--project and --email go together.");
  if (out.project !== undefined && !PROJECT_REF.test(out.project)) throw new Error(`${out.project} is not a project reference.`);
  if (out.email !== undefined && !accountEmail(out.email)) throw new Error(`${out.email} is not an email address.`);
  return out;
}

/** One argument's value: a file's JSON, JSON, or text. A top-level file argument's paths are made full; a field of an object, such as a bucket path, stays as typed. */
function value(key, text, cwd, topLevel = true) {
  let v;
  if (text.startsWith("@")) {
    const file = resolve(cwd, text.slice(1));
    try { v = JSON.parse(readFileSync(file, "utf-8")); }
    catch (err) { throw new Error(`${key}: ${file} is not a JSON file: ${err instanceof Error ? err.message : err}`); }
  } else {
    // Only an object, a list, a quoted string, true, false or null is JSON. A number stays text,
    // so an index such as 1.2 keeps its form; fabrik reads text as a number where it takes one.
    const json = /^\s*[[{"]/.test(text) || ["true", "false", "null"].includes(text.trim());
    if (json) { try { v = JSON.parse(text); } catch { v = text; } } else v = text;
  }
  if (topLevel && isFileArgument(key)) {
    if (typeof v === "string") return resolve(cwd, v);
    if (Array.isArray(v)) return v.map(one => resolve(cwd, String(one)));
    // A single file name for a list, such as progress_files=progress.json.
  }
  return v;
}

/** The saved session to use: the one named, the one the folder's actor file names, or the only one saved on this computer. */
export function account(project, email, home = homedir(), cwd = process.cwd()) {
  const root = join(home, ".config", "supabase-auth");
  if (!project) {
    const actor = readActor(cwd);
    if (actor && !actor.ok) throw new Error(actor.problem);
    if (actor) { project = actor.value.project_ref; email = actor.value.auth_email; }
  }
  if (project) {
    const who = { ref: project, email: accountEmail(email) };
    if (!existsSync(join(root, project, `${who.email}.json`))) throw new Error(`No sign-in is saved on this computer for ${who.email} on project ${project}. Sign in with: ${FABRIK_SIGN_IN}`);
    return who;
  }
  let saved = [];
  try {
    for (const ref of readdirSync(root)) {
      if (!PROJECT_REF.test(ref)) continue;
      for (const file of readdirSync(join(root, ref))) if (file.endsWith(".json")) saved.push({ ref, email: file.slice(0, -5) });
    }
  } catch { saved = []; }
  if (saved.length === 1) return saved[0];
  if (saved.length === 0) throw new Error(`No sign-in is saved on this computer. Sign in with: ${FABRIK_SIGN_IN}`);
  throw new Error(`More than one sign-in is saved on this computer. Name one with --project and --email: ${saved.map(s => `--project ${s.ref} --email ${s.email}`).join("; ")}`);
}

/** Runs one name with its arguments. Returns { ok, result } or { ok: false, problem }. */
export async function run({ project, email, name, args }, cwd = process.cwd(), home = homedir()) {
  // The business's brand, read as the signed-in person for the tools that dress a card or page in it. With no sign-in
  // here, account throws, and the card or page keeps its plain look.
  /** The signed-in person's database tools; account throws where no sign-in is saved here. */
  const signedIn = () => {
    const who = account(project, email, home, cwd);
    return databaseTools({ ref: who.ref, email: who.email, agentFolder: cwd, defaultSchema: SCHEMA });
  };
  const brand = () => {
    const database = signedIn();
    return readBrand(async (fn, callArgs) => {
      const out = JSON.parse((await database.callTool("rpc", { function: fn, schema: SCHEMA, args: callArgs })).content[0].text);
      if (!out.ok) throw new Error(out.problem);
      return out.result;
    });
  };
  const pages = pageTools({ agentFolder: cwd, readBrand: brand });
  const asked = name ?? "";
  let content;
  if (PAGE_TOOLS.some(t => t.name === asked)) {
    if (["draw_board", "draw_graph"].includes(asked)) {
      if (typeof args.progress_files === "string") args = { ...args, progress_files: [args.progress_files] };
    }
    content = await pages.callTool(asked, args);
  } else {
    const databaseTool = DATABASE_TOOLS.some(t => t.name === asked);
    if (!asked.startsWith("fabrik_") && !databaseTool) return { ok: false, problem: `${asked} is not a fabrik function or a tool. ${USAGE}` };
    const database = signedIn();
    if (asked.startsWith("fabrik_")) {
      const { result_file, ...callArgs } = args;
      content = await database.callTool("rpc", { function: asked, schema: SCHEMA, args: callArgs, ...(result_file === undefined ? {} : { result_file }) });
    } else {
      content = await database.callTool(asked, args);
    }
  }
  return JSON.parse(content.content[0].text);
}

/** fabrik upgrade <file>: sends the signed upgrade request in file to the fabrik-upgrade function, as the signed-in
 * person. Returns { ok, result } or { ok: false, problem }; the function's own refusal is the problem. */
export async function upgrade(argv, cwd = process.cwd(), home = homedir()) {
  const options = {}, files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" || argv[i] === "--email") {
      if (argv[i + 1] === undefined) return { ok: false, problem: `${argv[i]} needs a value.` };
      options[argv[i].slice(2)] = argv[++i];
    } else if (argv[i].startsWith("--")) return { ok: false, problem: `${argv[i]} is not an option. ${USAGE}` };
    else files.push(argv[i]);
  }
  if ((options.project === undefined) !== (options.email === undefined)) return { ok: false, problem: "--project and --email go together." };
  if (files.length !== 1) return { ok: false, problem: `Give one signed upgrade file. ${USAGE}` };
  const path = resolve(cwd, files[0]);
  let body;
  // An upgrade's own file, with its signature beside it as the .sig of the same name.
  const named = /(?:^|[\\/])(upgrades|file-search-upgrades)[\\/]([0-9]{4})-([a-z0-9][a-z0-9-]*)\.sql$/.exec(path);
  if (named) {
    const sig = path.replace(/\.sql$/, ".sig");
    if (!existsSync(sig)) return { ok: false, problem: `${path} has no signature beside it, ${sig}, so it is not applied.` };
    body = { series: named[1] === "upgrades" ? "fabrik" : "file_search", number: named[2], name: named[3],
      sql: readFileSync(path, "utf-8"), signature: readFileSync(sig, "utf-8").trim() };
  } else {
    try { body = JSON.parse(readFileSync(path, "utf-8")); }
    catch (err) { return { ok: false, problem: `${path} is not a signed upgrade file: ${err instanceof Error ? err.message : err}` }; }
  }
  if (body === null || typeof body !== "object" || Array.isArray(body) || ["number", "name", "sql", "signature"].some(k => typeof body[k] !== "string"))
    return { ok: false, problem: `${path} is not a signed upgrade file. scripts/sign-upgrade.mjs writes one.` };
  const who = account(options.project, options.email, home, cwd);
  const content = await databaseTools({ ref: who.ref, email: who.email, agentFolder: cwd, defaultSchema: SCHEMA }).callTool("call_function", { name: "fabrik-upgrade", body });
  return JSON.parse(content.content[0].text);
}

/** fabrik update: the project brought up to the installed plugin, as update.mjs says, as the signed-in person. */
export async function updateCommand(argv, cwd = process.cwd(), home = homedir(), say = () => {}) {
  const who = account(undefined, undefined, home, cwd);
  const tools = databaseTools({ ref: who.ref, email: who.email, agentFolder: cwd, defaultSchema: SCHEMA });
  // fabrik-upgrade's own answer, whether call_function took it as a success or a refusal.
  const call = async body => {
    const out = JSON.parse((await tools.callTool("call_function", { name: "fabrik-upgrade", body })).content[0].text);
    return out.ok ? out.result : out.body ?? { ok: false, problem: out.problem };
  };
  return update(argv, cwd, call, { say });
}

/** fabrik chat-page: the chat pages built in the brand and put up, as the signed-in person. Returns { ok, site, agents }
 * or { ok: false, problem }. */
export async function chatPageCommand(argv, cwd = process.cwd(), home = homedir(), say = () => {}, ask = askLine) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project" || argv[i] === "--email" || argv[i] === "--domain") {
      if (argv[i + 1] === undefined) return { ok: false, problem: `${argv[i]} needs a value.` };
      options[argv[i].slice(2)] = argv[++i];
    } else return { ok: false, problem: `${argv[i]} is not an option. ${USAGE}` };
  }
  if ((options.project === undefined) !== (options.email === undefined)) return { ok: false, problem: "--project and --email go together." };
  const who = account(options.project, options.email, home, cwd);
  const { url } = readSession(who.ref, who.email);
  const database = databaseTools({ ref: who.ref, email: who.email, agentFolder: cwd, defaultSchema: SCHEMA });
  const readBrandHere = () => readBrand(async (fn, callArgs) => {
    const out = JSON.parse((await database.callTool("rpc", { function: fn, schema: SCHEMA, args: callArgs })).content[0].text);
    if (!out.ok) throw new Error(out.problem);
    return out.result;
  }, { strict: true, wait: 30_000 });
  // public-agent's own answer to an administrator's action, or its refusal as an error.
  const agentAction = async body => {
    const out = JSON.parse((await database.callTool("call_function", { name: "public-agent", body })).content[0].text);
    const got = out.ok ? out.result : out.body ?? { ok: false, problem: out.problem };
    if (!got?.ok) throw new Error(got?.problem ?? "public-agent gave nothing back.");
    return got;
  };
  const { site, agents } = await chatPage({ ref: who.ref, url, readBrand: readBrandHere, domain: options.domain,
    readAgents: async () => (await agentAction({ action: "agents_list" })).agents,
    savePage: page => agentAction({ action: "settings", page }) }, { ask, say, home });
  return { ok: true, site, agents };
}

/** fabrik import maxy <folder>: the import, as the signed-in owner. Returns { ok, report } or { ok: false, problem }. */
export async function importCommand(argv, cwd = process.cwd(), home = homedir(), log = () => {}) {
  const options = {}, words = [];
  for (let i = 0; i < argv.length; i++) {
    if (["--project", "--email", "--labels"].includes(argv[i])) {
      if (argv[i + 1] === undefined) return { ok: false, problem: `${argv[i]} needs a value.` };
      options[argv[i].slice(2)] = argv[++i];
    } else if (argv[i].startsWith("--")) return { ok: false, problem: `${argv[i]} is not an option. ${USAGE}` };
    else words.push(argv[i]);
  }
  if (words[0] !== "maxy" || words.length !== 2) return { ok: false, problem: `Give the source and the export folder: import maxy <folder>. ${USAGE}` };
  if ((options.project === undefined) !== (options.email === undefined)) return { ok: false, problem: "--project and --email go together." };
  const folder = resolve(cwd, words[1]);
  if (!existsSync(folder)) return { ok: false, problem: `No such folder: ${folder}` };
  let map;
  const mapFile = options.labels ? resolve(cwd, options.labels) : LABEL_MAP;
  try { map = JSON.parse(readFileSync(mapFile, "utf-8")); }
  catch (err) { return { ok: false, problem: `The label map ${mapFile} could not be read: ${err instanceof Error ? err.message : err}. Name one with --labels.` }; }
  const who = account(options.project, options.email, home, cwd);
  const database = databaseTools({ ref: who.ref, email: who.email, agentFolder: folder, defaultSchema: SCHEMA });
  const answer = content => JSON.parse(content.content[0].text);
  const call = async (fn, args) => answer(await database.callTool("rpc", { function: fn, schema: SCHEMA, args }));
  // upload_file sends a file directly inside its agent folder, so each file goes with tools whose folder is its own. A file
  // over upload_file's 6 MB goes with Supabase Storage's resumable upload, under the same folder rules.
  const upload = async (bucket, path, file) => {
    const tools = databaseTools({ ref: who.ref, email: who.email, agentFolder: dirname(file), defaultSchema: SCHEMA });
    if (statSync(file).size > UPLOAD_LIMIT) return tools.uploadResumable({ bucket, path, file });
    return answer(await tools.callTool("upload_file", { bucket, path, file }));
  };
  return importMaxy(folder, { call, upload, map, log });
}

const real = file => { try { return realpathSync(file); } catch { return file; } };
if (process.argv[1] && real(fileURLToPath(import.meta.url)) === real(resolve(process.argv[1]))) {
  if (process.argv[2] === "setup") {
    const words = process.argv.slice(3);
    if (words.includes("--help") || words.includes("-h")) { process.stdout.write(`${SETUP_USAGE}\n`); process.exit(0); }
    // FABRIK_SETUP_SIGN_IN names a stand-in sign-in, for setup.test.mjs.
    process.exit(await setup(words, { signInArgs, signInPath: process.env.FABRIK_SETUP_SIGN_IN || SIGN_IN }));
  }
  if (process.argv[2] === "connector-settings") {
    const words = process.argv.slice(3);
    if (words.includes("--help") || words.includes("-h")) { process.stdout.write(`${CONNECTOR_SETTINGS_USAGE}\n`); process.exit(0); }
    process.exit(await connectorSettings(words));
  }
  if (process.argv[2] === "import") {
    let out;
    try { out = await importCommand(process.argv.slice(3), process.cwd(), homedir(), line => process.stderr.write(`${line}\n`)); }
    catch (err) { out = { ok: false, problem: err instanceof Error ? err.message : String(err) }; }
    if (out.ok === false) { process.stderr.write(`${out.problem}\n`); process.exitCode = 1; }
    else {
      process.stdout.write(`${reportLines(out.report).join("\n")}\nThe report is in ${join(out.report.folder, REPORT_FILE)}.\n`);
      if (!out.report.ok) process.exitCode = 1;
    }
  } else if (process.argv[2] === "chat-page") {
    let out;
    try { out = await chatPageCommand(process.argv.slice(3), process.cwd(), homedir(), line => process.stdout.write(`${line}\n`)); }
    catch (err) { out = { ok: false, problem: err instanceof Error ? err.message : String(err) }; }
    if (out.ok === false) { process.stderr.write(`${out.problem}\n`); process.exitCode = 1; }
    else process.stdout.write(`Your chat pages: ${out.site}\n${out.agents.map(a => `\n${a.name}: ${a.page}\nTo put its chat button on a website, paste this line into its pages:\n${a.widget}\n`).join("")}`);
  } else if (process.argv[2] === "update") {
    let out;
    // --apply is run by the person in a Terminal tab, so it speaks in lines; --check answers the assistant in JSON.
    const apply = process.argv[3] === "--apply";
    try { out = await updateCommand(process.argv.slice(3), process.cwd(), homedir(), apply ? line => process.stdout.write(`${line}\n`) : undefined); }
    catch (err) { out = { ok: false, problem: err instanceof Error ? err.message : String(err) }; }
    if (!apply) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else process.stdout.write(`${out.ok ? `fabrik is up to date.${out.deployed.length || out.applied.length ? "" : " Nothing needed changing."}` : `The update stopped: ${out.problem}`}\n`);
    if (out.ok === false) process.exitCode = 1;
  } else if (process.argv[2] === "upgrade") {
    let out;
    try { out = await upgrade(process.argv.slice(3)); }
    catch (err) { out = { ok: false, problem: err instanceof Error ? err.message : String(err) }; }
    if (out.ok === false) { process.stderr.write(`${out.problem}\n`); process.exitCode = 1; }
    else process.stdout.write(`${JSON.stringify(out.result ?? out, null, 2)}\n`);
  } else if (process.argv[2] === "sign-in") {
    let args;
    try { args = signInArgs(process.argv.slice(3)); }
    catch (err) { process.stderr.write(`${err instanceof Error ? err.message : err}\n`); process.exit(1); }
    const ran = spawnSync(process.execPath, args, { stdio: "inherit" });
    process.exit(ran.status ?? 1);
  } else {
    let options;
    try { options = parse(process.argv.slice(2)); }
    catch (err) { process.stderr.write(`${err instanceof Error ? err.message : err}\n${USAGE}\n`); process.exit(2); }
    if (options.name === undefined) { process.stdout.write(`${USAGE}\n`); process.exit(0); }
    // The plugin's own settings name the sign-in once for a terminal.
    if (options.project === undefined && !readActor(process.cwd()) && process.env.SUPABASE_PROJECT_REF && process.env.SUPABASE_AUTH_EMAIL) {
      options.project = process.env.SUPABASE_PROJECT_REF;
      options.email = process.env.SUPABASE_AUTH_EMAIL;
    }
    let out;
    try { out = await run(options); }
    catch (err) { out = { ok: false, problem: err instanceof Error ? err.message : String(err) }; }
    // The exit code is set, and Node ends once its connections close. Calling exit() with a connection
    // still open crashes Node on Windows, as sign-in.mjs found.
    if (out.ok === false) {
      process.stderr.write(`${String(out.problem).replace(" Never ask for the password in chat.", "")}\n`);
      process.exitCode = 1;
    } else {
      const { ok: _ok, ...rest } = out;
      process.stdout.write(JSON.stringify(Object.keys(rest).length === 1 && "result" in rest ? rest.result : rest, null, 2) + "\n");
    }
  }
}
