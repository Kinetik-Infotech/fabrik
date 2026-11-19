// fabrik update: brings a person's fabrik project up to the installed plugin, as the signed-in administrator, from the
// folder that holds the project file setup wrote, .fabrik-setup-project.json.
//
//   node fabrik.mjs update --check
//   node fabrik.mjs update --apply
//
// --check answers what is behind: the signed upgrades in setup/upgrades and setup/file-search-upgrades the project's
// ledgers don't hold, and each hosted function whose files changed since it was last deployed, with the sentence each
// upgrade gives about itself. It reads the ledgers through fabrik-upgrade, which answers an administrator alone. A
// fabrik-upgrade from before it listed ledgers answers no list: ledgers is then null, and fabrik-upgrade is among the
// functions to deploy, which --apply deploys first. Any other refusal or failure to list them stops the update and
// says why. fabrik-setup is never listed: it serves setup alone.
//
// --apply brings the project up to date. When a hosted function changed, it asks for a Supabase access token at a
// hidden prompt, so the person runs it in a Terminal tab, and deploys fabrik-upgrade first, from the files on this
// computer, through Supabase's Management API. It then applies each signed upgrade the ledgers don't hold, in order,
// through fabrik-upgrade, stopping at the first refusal, and passes over one already applied. Each upgrade's signature
// is the .sig file beside it. Last it deploys the other functions that changed, records each one's files in the project
// file as it is deployed, and checks Supabase lists each with its verify_jwt. With no function changed, it asks for no
// token. The token stays in this process's memory.
import { existsSync, readdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { functionHash, PROJECT_FILE, readProject, SETUP_FOLDER } from "./owner-setup.mjs";
import { apiBase, askHidden as terminalHidden, deployFunction, functionsList, managementClient, Refused } from "./management.mjs";
import { TOKEN_PAGE } from "./connector-settings.mjs";

export const UPDATE_USAGE = `Usage: node fabrik.mjs update --check
       node fabrik.mjs update --apply`;
/** Each series of upgrades, by its folder in setup/. */
export const SERIES = [{ series: "fabrik", folder: "upgrades" }, { series: "file_search", folder: "file-search-upgrades" }];

/** Every signed upgrade of a series, in order: its id, its text, its signature, and its own sentence about itself. A
 * file with no .sig beside it is left out, and named in unsigned. */
export function upgradesOf(series, setup = SETUP_FOLDER) {
  const { folder } = SERIES.find(s => s.series === series);
  const dir = join(setup, folder);
  const signed = [], unsigned = [];
  for (const file of readdirSync(dir).filter(f => /^[0-9]{4}-[a-z0-9-]+\.sql$/.test(f)).sort()) {
    const id = file.slice(0, -4);
    const sig = join(dir, `${id}.sig`);
    if (!existsSync(sig)) { unsigned.push(id); continue; }
    const sql = readFileSync(join(dir, file), "utf8");
    signed.push({ series, id, number: id.slice(0, 4), name: id.slice(5), sql, signature: readFileSync(sig, "utf8").trim(), about: aboutOf(sql) });
  }
  return { signed, unsigned };
}

/** An upgrade's sentence about itself: its header comment after the id, base and redeploy lines, up to the line that
 * says setup.sql holds the same text. */
export function aboutOf(sql) {
  const lines = [];
  for (const line of sql.split("\n").slice(1)) {
    if (!line.startsWith("--")) break;
    const text = line.replace(/^--\s?/, "");
    if (/^(base|redeploy):/.test(text)) continue;
    if (/^The same text is in /.test(text)) break;
    lines.push(text.trim());
  }
  return lines.join(" ").trim();
}

/** The upgrades the ledgers don't hold, in series order then number order. */
export function missing(ledgers, setup = SETUP_FOLDER) {
  return SERIES.flatMap(({ series }) => upgradesOf(series, setup).signed.filter(u => !(ledgers?.[series] ?? []).includes(u.id)));
}

/** Each hosted function whose files differ from what the project file says was last deployed, fabrik-upgrade first.
 * fabrik-setup is left out: it serves setup alone, and setup deploys it. */
export async function changedFunctions(folder, setup = SETUP_FOLDER) {
  const build = await import(pathToFileURL(join(setup, "build.mjs")).href);
  const kept = readProject(folder)?.functions ?? {};
  const changed = build.functions(setup).filter(f => f.name !== "fabrik-setup" && kept[f.name] !== functionHash(f));
  return changed.sort((a, b) => (b.name === "fabrik-upgrade") - (a.name === "fabrik-upgrade"));
}

/** Records one function as deployed, with its files' hash, in the project file. */
export async function recordDeployed(folder, name, setup = SETUP_FOLDER) {
  const build = await import(pathToFileURL(join(setup, "build.mjs")).href);
  const f = build.functions(setup).find(x => x.name === name);
  if (!f) throw new Error(`${name} is not one of fabrik's hosted functions.`);
  const project = readProject(folder);
  if (!project) throw new Error(`${join(folder, PROJECT_FILE)} is missing or unreadable. Run fabrik update in the folder setup was run in.`);
  const next = { ...project, functions: { ...(project.functions ?? {}), [name]: functionHash(f) } };
  const file = join(folder, PROJECT_FILE);
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
  return next.functions[name];
}

/** The refusal a fabrik-upgrade from before it listed ledgers gives { list: true }: it reads it as an upgrade with no
 * number. */
export const TOO_OLD = /^Give the upgrade's four-digit number and its name/;

/** The project's ledgers, from fabrik-upgrade, or null when it is too old to list them. Any other refusal or failure is
 * thrown, so a passing fault is never taken for an old fabrik-upgrade. call sends one request to fabrik-upgrade as the
 * signed-in person and answers its JSON. */
export async function ledgersOf(call) {
  const out = await call({ list: true });
  if (out?.ok === true && out.ledgers && typeof out.ledgers === "object") return out.ledgers;
  if (TOO_OLD.test(String(out?.problem ?? ""))) return null;
  throw new Error(`fabrik-upgrade didn't list the project's upgrades: ${out?.problem ?? "it gave no answer."}`);
}

/** fabrik update, with call sending one request to fabrik-upgrade as the signed-in person. askHidden asks for the
 * token, say prints a line, and base is the Management API's address. */
export async function update(argv, folder, call, { setup = SETUP_FOLDER, askHidden = terminalHidden, say = () => {}, base = apiBase() } = {}) {
  const [flag, ...rest] = argv;
  if (rest.length || !["--check", "--apply"].includes(flag)) return { ok: false, problem: UPDATE_USAGE };
  const where = resolve(folder);
  if (!readProject(where)) return { ok: false, problem: `${join(where, PROJECT_FILE)} is missing or unreadable. Run fabrik update in the folder setup was run in.` };
  try { return await (flag === "--check" ? check(where, call, setup) : apply(where, call, setup, { askHidden, say, base })); }
  catch (err) { return { ok: false, problem: err instanceof Error ? err.message : String(err) }; }
}

/** update --check. */
async function check(where, call, setup) {
  const ledgers = await ledgersOf(call);
  const functions = await changedFunctions(where, setup);
  const upgrades = ledgers ? missing(ledgers, setup) : null;
  const unsigned = SERIES.flatMap(({ series }) => upgradesOf(series, setup).unsigned);
  return {
    ok: true, behind: functions.length > 0 || (upgrades?.length ?? 1) > 0, ledgers,
    upgrades: upgrades?.map(u => ({ series: u.series, id: u.id, about: u.about })) ?? null, unsigned,
    functions: functions.map(f => f.name),
  };
}

/** The upgrades step of --apply: each one the ledgers don't hold, in order, stopping at the first refusal. */
async function upgrades(call, setup) {
  const ledgers = await ledgersOf(call);
  const applied = [];
  for (const u of missing(ledgers ?? {}, setup)) {
    const out = await call({ series: u.series, number: u.number, name: u.name, sql: u.sql, signature: u.signature });
    if (out?.ok === true) { applied.push(u.id); continue; }
    if (/is already applied here/.test(String(out?.problem ?? ""))) continue;
    return { ok: false, applied, problem: `Upgrade ${u.id} was not applied: ${out?.problem ?? "fabrik-upgrade gave no answer."}` };
  }
  return { ok: true, applied, ledgers: await ledgersOf(call) };
}

/** update --apply: fabrik-upgrade, the upgrades, then the other functions that changed, each deployed from this
 * computer's files with the token askHidden gives. */
async function apply(where, call, setup, { askHidden, say, base }) {
  const project = readProject(where);
  const functions = await changedFunctions(where, setup);
  let c = null;
  if (functions.length) {
    say(`fabrik's hosted functions to deploy: ${functions.map(f => f.name).join(", ")}. Make a Supabase access token at ${TOKEN_PAGE}, with the shortest expiry, in the account that holds ${project.name}. If the page asks, choose Organization, pick your organization and keep Full access. Paste the token here, and delete it on that page once the update is done.`);
    let token = await askHidden("Supabase access token: ");
    if (!token) return { ok: false, problem: "No token was pasted. Run this again, and paste the token at the prompt." };
    c = managementClient(token, base);
    token = undefined;
  }
  const deployed = [];
  const deploy = async f => {
    await deployFunction(c, project.ref, { name: f.name, entrypoint: f.entrypoint_path, verifyJwt: f.verify_jwt,
      files: f.files.map(x => ({ name: x.name, text: readFileSync(x.path, "utf8") })) });
    await recordDeployed(where, f.name, setup);
    deployed.push(f.name);
    say(`Deployed ${f.name}.`);
  };
  try {
    for (const f of functions.filter(f => f.name === "fabrik-upgrade")) await deploy(f);
    const up = await upgrades(call, setup);
    for (const id of up.applied) say(`Applied upgrade ${id}.`);
    if (!up.ok) return { ...up, deployed };
    for (const f of functions.filter(f => f.name !== "fabrik-upgrade")) await deploy(f);
    if (c) {
      const listed = await functionsList(c, project.ref);
      const wrong = functions.filter(f => !listed.some(d => d.slug === f.name && d.verify_jwt === f.verify_jwt)).map(f => f.name);
      if (wrong.length) return { ok: false, deployed, applied: up.applied, problem: `Supabase doesn't list ${wrong.join(", ")} as deployed with its verify_jwt setting. Run this again.` };
    }
    if (c) say(`Delete the access token at ${TOKEN_PAGE}.`);
    return { ok: true, deployed, applied: up.applied, ledgers: up.ledgers };
  } catch (err) {
    const why = err instanceof Refused && (err.status === 401 || err.status === 403)
      ? `Supabase refused the token: ${err.message} Make a new one at ${TOKEN_PAGE}, in the account that holds ${project.name}, and run this again.`
      : `${err instanceof Error ? err.message : String(err)} Run this again to carry on.`;
    return { ok: false, deployed, problem: why };
  }
}
