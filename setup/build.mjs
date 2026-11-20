#!/usr/bin/env node
// Setup's helper, which fabrik setup --owner imports on the owner's computer, from this folder's files. Run alone, it
// needs Node and no password, key or token beyond the project's publishable key, which is public.
//
//   node build.mjs approve --ref <project reference> --folder <setup folder> [--reset]
//   node build.mjs run --url <project URL> [--key <publishable key>] [--ref <project reference>] <file> [<file> ...]
//   node build.mjs functions
//   node build.mjs guides
//
// approve prints one SQL statement, which setup runs as postgres through the Management API. It makes the fabrik_setup schema, which
// the fabrik-setup hosted function reads, and approves this folder's setup files by their SHA-256, each to run once:
// setup.sql, file-search.sql, file-search-scopes.sql, schedule.sql with the project reference filled in, and
// first-administrator.sql, with reset.sql too for --reset. It also writes a new sign-in code to the setup folder's
// .fabrik-owner-code, readable by the owner alone, for the owner's first sign-in, and approves the code by its SHA-256
// for a day. The code itself is never printed.
//
// run sends each file, in order, to the fabrik-setup hosted function, which runs it as postgres. It prints one line
// per file, and stops at the first that fails, with the database's message. Exit code 1 then.
//
// functions prints, as JSON, each hosted function setup deploys, in order:
// its name, its verify_jwt setting, its entrypoint and the full path of each of its files, with the name each file
// is deployed under.
//
// guides writes functions/fabrik-apps/guides.ts from the Markdown guides in docs/guides/, for fabrik-apps' guide tool.
// Each guide is one file, named <number>-<topic>.md; the number sets the order and the first line is its "# " title.
//
// sign-in --ref --key --folder copies setup/sign-in/ to a new folder outside the repository, writes prod/fabrik.js
// with the project's address and publishable key and fills the address into _headers, and prints the wrangler
// command that deploys it to the Cloudflare Pages project fabrik-sign-in. It deploys nothing itself.

import process from "node:process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_REF = /^[a-z0-9]{20}$/;
/** The files setup runs through fabrik-setup, in order. */
export const BUILD_FILES = ["setup.sql", "file-search.sql", "file-search-scopes.sql", "schedule.sql", "first-administrator.sql"];
/** The file in the setup folder that holds the owner's sign-in code. */
export const OWNER_CODE_FILE = ".fabrik-owner-code";

/**
 * The hosted functions, in the order setup deploys them. fabrik-setup runs the setup files; the file search
 * functions follow, each with every file it imports; then fabrik-upgrade, which applies signed upgrades for an
 * administrator, graph-reader, which stays off until an administrator adds their own Anthropic API key, and
 * public-agent, which answers the chat box on the owner's website once an administrator adds its key. Last,
 * fabrik-apps, the connector every Claude client reaches fabrik through, which checks each person's token itself.
 */
export const FUNCTIONS = [
  { name: "fabrik-setup", verify_jwt: false, files: ["index.ts"] },
  { name: "file-search-worker", verify_jwt: false, files: ["index.ts", "text.ts", "vendor/sheetjs-0.20.3/xlsx.mjs", "vendor/sheetjs-0.20.3/types/index.d.ts"] },
  { name: "file-search", verify_jwt: true, files: ["index.ts"] },
  { name: "file-search-purge", verify_jwt: true, files: ["index.ts"] },
  { name: "fabrik-upgrade", verify_jwt: true, files: ["index.ts", "upgrade-key.ts"] },
  { name: "graph-reader", verify_jwt: false, files: ["index.ts", "prompt.ts"] },
  { name: "public-agent", verify_jwt: false, files: ["index.ts"] },
  { name: "fabrik-apps", verify_jwt: false, files: ["index.ts", "tool.ts", "cards.ts", "card.ts", "brand.ts", "brand-core.mjs", "ported.ts", "memory.ts", "work.ts", "workflows.ts", "contacts.ts", "voice.ts", "mail.ts", "mail-send.ts", "guides.ts", "annotations.ts", "connections.ts", "public-agent.ts"] },
];

export const USAGE = `Usage: node build.mjs approve --ref <project reference> --folder <setup folder> [--reset]
       node build.mjs run --url <project URL> [--key <publishable key>] [--ref <project reference>] <file> [<file> ...]
       node build.mjs functions
       node build.mjs guides
       node build.mjs sign-in --ref <project reference> --key <publishable key> --folder <new folder>`;
/** The Cloudflare Pages project each person's sign-in page is deployed to, and the address its pages open at. */
export const SIGN_IN_PROJECT = "fabrik-sign-in";
/**
 * Where the Site URL comes from. Cloudflare Pages addresses are shared by every account, so a person's project may be
 * named fabrik-sign-in-<suffix>.pages.dev, not fabrik-sign-in.pages.dev: the address is never worked out from the project name.
 */
export const SIGN_IN_SITE_URL = "the project's own address, as `wrangler pages project list` shows it under Project Domains (not the address of one deploy), followed by /prod";
export const PUBLISHABLE_KEY = /^sb_publishable_[A-Za-z0-9_-]+$/;

export const SIGN_IN_COMMAND = `wrangler pages deploy . --project-name ${SIGN_IN_PROJECT} --branch main`;

/**
 * Makes the sign-in page's folder for one project: setup/sign-in/ copied to a new folder, with prod/fabrik.js holding
 * the project's address and publishable key, and _headers limiting the pages' connections to that address. It deploys
 * nothing; the owner runs SIGN_IN_COMMAND in the folder it returns. The folder must be new or empty, and outside the repository.
 */
export function signIn({ ref, key, folder }, { here = HERE } = {}) {
  if (!PROJECT_REF.test(ref ?? "")) throw new Error(`${ref ?? "--ref"} is not a project reference.`);
  if (!PUBLISHABLE_KEY.test(key ?? "")) throw new Error(`${key ? "That" : "--key"} is not a publishable key: it starts sb_publishable_.`);
  if (!folder) throw new Error("--folder is needed.");
  const out = resolve(folder);
  if (out === resolve(here, "..") || out.startsWith(resolve(here, "..") + sep)) throw new Error(`${folder} is inside the repository. Use a new folder outside it.`);
  if (existsSync(out) && !statSync(out).isDirectory()) throw new Error(`${folder} is a file. Use a new folder.`);
  if (existsSync(out) && readdirSync(out).length) throw new Error(`${folder} is not empty. Use a new folder.`);
  const url = `https://${ref}.supabase.co`;
  mkdirSync(out, { recursive: true });
  cpSync(join(here, "sign-in"), out, { recursive: true });
  writeFileSync(join(out, "prod", "fabrik.js"), `window.FABRIK = ${JSON.stringify({ url, key, name: "fabrik" })};\n`);
  const headers = readFileSync(join(out, "_headers"), "utf8");
  if (!headers.includes("<project url>")) throw new Error("setup/sign-in/_headers has no <project url> to fill in.");
  writeFileSync(join(out, "_headers"), headers.replaceAll("<project url>", url));
  return { folder: out, command: SIGN_IN_COMMAND, siteUrl: SIGN_IN_SITE_URL };
}

const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const literal = text => `'${String(text).replaceAll("'", "''")}'`;

/** A setup file's text as fabrik-setup runs it: schedule.sql with the project reference filled in. */
export function fileText(name, ref, folder = HERE) {
  if (!BUILD_FILES.includes(name) && name !== "reset.sql") throw new Error(`${name} is not one of setup's files: ${[...BUILD_FILES, "reset.sql"].join(", ")}.`);
  const text = readFileSync(join(folder, name), "utf8");
  if (name !== "schedule.sql") return text;
  if (!PROJECT_REF.test(ref ?? "")) throw new Error("schedule.sql needs the project reference.");
  return text.replaceAll("<project reference>", ref);
}

/** The statement that makes fabrik_setup and approves the files and the owner's code, and the code file it wrote. */
export function approve({ ref, folder, reset = false }, { here = HERE, code = randomBytes(32).toString("hex") } = {}) {
  if (!PROJECT_REF.test(ref ?? "")) throw new Error(`${ref ?? "--ref"} is not a project reference.`);
  if (!folder || !existsSync(folder)) throw new Error(`${folder ?? "--folder"} is not a folder.`);
  const codeFile = join(resolve(folder), OWNER_CODE_FILE);
  writeFileSync(codeFile, `${code}\n`, { mode: 0o600 });
  try { chmodSync(codeFile, 0o600); } catch {}
  const files = [...(reset ? ["reset.sql"] : []), ...BUILD_FILES];
  const rows = files.map(name => `(${literal(sha256(fileText(name, ref, here)))}, ${literal(name)})`).join(",\n ");
  const sql = `create schema if not exists fabrik_setup;
revoke all on schema fabrik_setup from public, anon, authenticated;
create table if not exists fabrik_setup.approved (sha256 text primary key, name text not null, approved_at timestamptz not null default now());
create table if not exists fabrik_setup.owner_code (sha256 text primary key, expires_at timestamptz not null);
create table if not exists fabrik_setup.person (auth_user_id uuid primary key, name text not null, email text not null, role text not null);
revoke all on all tables in schema fabrik_setup from public, anon, authenticated;
delete from fabrik_setup.approved;
insert into fabrik_setup.approved (sha256, name) values
 ${rows};
delete from fabrik_setup.owner_code;
insert into fabrik_setup.owner_code (sha256, expires_at) values (${literal(sha256(code))}, now() + interval '1 day');
select name from fabrik_setup.approved order by approved_at, name;`;
  return { sql, codeFile };
}

/** Sends one file to fabrik-setup. Returns { ok, problem }. */
export async function runFile(url, key, name, text) {
  const headers = { "Content-Type": "text/plain; charset=utf-8", ...(key ? { apikey: key } : {}) };
  let res;
  try { res = await fetch(`${url.replace(/\/+$/, "")}/functions/v1/fabrik-setup/sql`, { method: "POST", headers, body: text }); }
  catch (err) { return { ok: false, problem: `the project could not be reached: ${err?.cause?.code ?? err?.message ?? err}` }; }
  const body = await res.json().catch(() => null);
  if (res.ok && body?.ok) return { ok: true };
  return { ok: false, problem: body?.problem ?? `fabrik-setup answered HTTP ${res.status}` };
}

/** The folder of fabrik's guides, and the file guides writes from them. */
export const GUIDES_FOLDER = resolve(HERE, "..", "docs", "guides");
export const GUIDES_FILE = join(HERE, "functions", "fabrik-apps", "guides.ts");

/** The guides in folder, in order: each one's topic, from its file name, its title, from its first line, and its text. */
export function readGuides(folder = GUIDES_FOLDER) {
  return readdirSync(folder).filter(name => name.endsWith(".md")).sort().map(name => {
    const named = /^\d+-([a-z0-9-]+)\.md$/.exec(name);
    if (!named) throw new Error(`${name} in ${folder} is not named <number>-<topic>.md.`);
    const text = readFileSync(join(folder, name), "utf8").replace(/\r\n?/g, "\n");
    const title = /^# (.+)\n/.exec(text)?.[1];
    if (!title) throw new Error(`${name} does not open with a "# " title.`);
    return { topic: named[1], title, text };
  });
}

/** guides.ts's text, made from the guides in folder. */
export function guidesSource(folder = GUIDES_FOLDER) {
  return "// Made by setup/build.mjs guides from docs/guides/. Run it again; do not edit.\n" +
    `export const GUIDES: { topic: string; title: string; text: string }[] = ${JSON.stringify(readGuides(folder), null, 2)};\n`;
}

/** Each function to deploy, with the full path of each file. */
export function functions(here = HERE) {
  return FUNCTIONS.map(f => ({
    name: f.name, verify_jwt: f.verify_jwt, entrypoint_path: "index.ts",
    files: f.files.map(name => ({ name, path: join(here, "functions", f.name, name) })),
  }));
}

function options(argv) {
  const out = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const word = argv[i];
    if (word === "--reset") out.reset = true;
    else if (["--ref", "--folder", "--url", "--key"].includes(word)) {
      if (argv[i + 1] === undefined) throw new Error(`${word} needs a value.`);
      out[word.slice(2)] = argv[++i];
    } else if (word.startsWith("--")) throw new Error(`${word} is not an option.`);
    else out.files.push(word);
  }
  return out;
}

export async function main(argv, { say = line => process.stdout.write(`${line}\n`), fail = line => process.stderr.write(`${line}\n`) } = {}) {
  const [command, ...rest] = argv;
  let o;
  try { o = options(rest); } catch (err) { fail(`${err.message}\n${USAGE}`); return 2; }
  try {
    if (command === "approve") {
      const { sql, codeFile } = approve(o);
      say(sql);
      fail(`The owner's sign-in code is in ${codeFile}.`);
      return 0;
    }
    if (command === "functions") { say(JSON.stringify(functions(), null, 2)); return 0; }
    if (command === "guides") {
      writeFileSync(GUIDES_FILE, guidesSource());
      say(`Wrote ${GUIDES_FILE} from ${readGuides().length} guides.`);
      return 0;
    }
    if (command === "sign-in") {
      const made = signIn(o);
      say(`The sign-in page is in ${made.folder}. Deploy it from there:\n  cd ${made.folder} && ${made.command}\nThen set the Site URL to ${made.siteUrl}.`);
      return 0;
    }
    if (command === "run") {
      const ref = o.ref ?? /^https:\/\/([a-z0-9]{20})\.supabase\.co\/?$/.exec(o.url ?? "")?.[1];
      if (!o.url || !o.files.length) throw new Error(`run needs --url and at least one file.\n${USAGE}`);
      for (const name of o.files) {
        const ran = await runFile(o.url, o.key, name, fileText(name, ref));
        if (!ran.ok) { fail(`${name}: failed: ${ran.problem}`); return 1; }
        say(`${name}: done`);
      }
      return 0;
    }
    fail(USAGE);
    return 2;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
