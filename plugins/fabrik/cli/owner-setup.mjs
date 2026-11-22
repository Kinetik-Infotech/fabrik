// fabrik setup --owner: sets fabrik up in the owner's Supabase project in one run, on the owner's computer, through
// Supabase's Management API, with a personal access token the owner pastes at a hidden prompt. In order:
//
//   the token, checked with GET /v1/organizations; the organisation; the project, found or created in the region the
//   owner picks, and healthy; where the project stands, read with state.sql; fabrik-setup deployed, the setup files
//   approved and run; the other hosted functions and file search's schedule; the Data API serving fabrik; the owner's
//   own sign-in; the administrator, the health check, the scopes and file search checked as the owner, the setup
//   record saved, fabrik_setup dropped, setup ended in the folder; the sign-in page; fabrik's five auth
//   settings, public sign-up off among them; and the summary.
//
// The token, the owner's password and the database password the command makes stay in this process's memory. None
// goes on a command line, into an environment variable, a file or a log, and none is printed.
//
// The setup folder keeps the project's reference, its name and the sign-in page's address in
// .fabrik-setup-project.json, readable by the owner alone, so a run after a stop carries on with the same project.
// state.sql says where the project stands. A project picked from the list is read with it before the file is written,
// and one that already holds a fabrik is never written there, unless it is set up and the folder is signed in to it.
//
// The sign-in page's folder is made in ~/.config/fabrik/sign-in/<project reference>, beside fabrik's Cloudflare
// sign-in, never in the owner's folder.
//
// Exit codes: 0 everything done, 1 a step failed or was refused, 2 bad options, 3 run again later, for the signing
// key's second run.
//
// FABRIK_TEST_MANAGEMENT_API names a loopback stand-in for Supabase, for the stand-in's tests. With it, the project's
// own address is the stand-in's too, and FABRIK_TEST_HEALTH_WAIT_MS may shorten the wait for a healthy project.
import process, { stdout } from "node:process";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  API, apiBase, askHidden as terminalHidden, askLine, createProject, deployFunction, exposeFabrik, functionsList, profileEmail, managementClient,
  organization, organizations, PAUSED, PROJECT_REF, ProjectStuck, projects, publishableKey, query, Refused, waitHealthy,
} from "./management.mjs";
import { AGAIN, makeSettings, SITE, TOKEN_PAGE } from "./connector-settings.mjs";
import { ownerSignIn } from "./lib/sign-in-flow.mjs";
import { pageFolder, putUpSignInPage, WRANGLER } from "./sign-in-page.mjs";
import { createTools } from "./lib/tools.mjs";
import { LOCAL, readActor, writeActorFile } from "./lib/actor-file.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** fabrik's setup files, at the top of the fabrik marketplace. */
export const SETUP_FOLDER = resolve(HERE, "../../../setup");
/** The file in the setup folder that keeps the project and the sign-in page's address between runs. */
export const PROJECT_FILE = ".fabrik-setup-project.json";
const SCOPES = ["general", "reference", "administration"];
const RECORD_TITLE = "fabrik setup";

/** Supabase's regions a new project can go in, as the Management API names them. */
export const REGIONS = [
  ["eu-west-2", "London"], ["eu-west-1", "Ireland"], ["eu-west-3", "Paris"], ["eu-central-1", "Frankfurt"],
  ["eu-central-2", "Zurich"], ["eu-north-1", "Stockholm"], ["us-east-1", "North Virginia"], ["us-east-2", "Ohio"],
  ["us-west-1", "North California"], ["us-west-2", "Oregon"], ["ca-central-1", "Canada"], ["sa-east-1", "São Paulo"],
  ["ap-south-1", "Mumbai"], ["ap-southeast-1", "Singapore"], ["ap-northeast-1", "Tokyo"], ["ap-northeast-2", "Seoul"],
  ["ap-southeast-2", "Sydney"],
];

export const OWNER_SETUP_USAGE = `Usage: node fabrik.mjs setup --owner [--folder <folder>]

setup --owner sets fabrik up in your Supabase project in one run. It asks for a Supabase access token, which you
make at ${TOKEN_PAGE} with the shortest expiry, Organization access and Full access, and you
delete it on that page once setup is done. It finds or creates your Supabase project, builds fabrik in it, and
asks your name, email and the password you choose. It puts your sign-in page up on Cloudflare Pages, opening the
browser for your Cloudflare sign-in, and makes the settings of fabrik's connector. Run it again after a stop,
and it carries on from where it stopped.`;

/** --folder, checked. */
function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--folder") throw new Error(`${argv[i]} is not an option of setup --owner.`);
    if (argv[i + 1] === undefined) throw new Error("--folder needs a value.");
    out.folder = argv[++i];
  }
  if (!out.folder) throw new Error("setup --owner needs --folder.");
  if (!existsSync(out.folder)) throw new Error(`${out.folder}, given as --folder, is not a folder.`);
  return { folder: resolve(out.folder) };
}

/**
 * The project file in the folder, or null. A file whose project reference is not 20 lower-case letters and digits, or
 * whose site is not a web address, counts as no file, so an edited file never steers a call elsewhere.
 */
export function readProject(folder) {
  try {
    const kept = JSON.parse(readFileSync(join(folder, PROJECT_FILE), "utf8"));
    if (!kept || typeof kept.ref !== "string" || !PROJECT_REF.test(kept.ref) || typeof kept.name !== "string") return null;
    if (kept.site !== undefined && (typeof kept.site !== "string" || !SITE.test(kept.site))) return null;
    if (kept.organization !== undefined && typeof kept.organization !== "string") return null;
    if (kept.page !== undefined && (typeof kept.page !== "string" || !/^[0-9a-f]{64}$/.test(kept.page))) return null;
    if (kept.functions !== undefined && (typeof kept.functions !== "object" || kept.functions === null
      || !Object.entries(kept.functions).every(([k, v]) => /^[a-z0-9-]+$/.test(k) && typeof v === "string" && /^[0-9a-f]{64}$/.test(v)))) return null;
    return kept;
  } catch { return null; }
}

function writeProject(folder, project) {
  const file = join(folder, PROJECT_FILE);
  writeFileSync(file, `${JSON.stringify(project, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
}

/** One hosted function's files, as build.mjs lists them, as one hash: their names and contents, in order. */
export function functionHash(f) {
  const hash = createHash("sha256").update(`${f.name}\0${f.entrypoint_path}\0${f.verify_jwt}\0`);
  for (const x of f.files) hash.update(`${x.name}\0`).update(readFileSync(x.path)).update("\0");
  return hash.digest("hex");
}

/** The sign-in page's source files, setup/sign-in, as one hash: their paths and contents, in order. */
export function pageHash(setup) {
  const hash = createHash("sha256");
  const walk = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else hash.update(`${path.slice(setup.length)}\0`).update(readFileSync(path)).update("\0");
    }
  };
  walk(join(setup, "sign-in"));
  return hash.digest("hex");
}

/** A step that stopped the run, with the line the owner reads. */
class Stop extends Error {}

/** A message as one line, ending with a full stop. */
const said = err => (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim().replace(/([^.!?…])$/, "$1.");

/** Asks for a number from 1 to count until one is typed. */
async function pickNumber(ask, prompt, count) {
  for (;;) {
    const n = Number(await ask(prompt));
    if (Number.isInteger(n) && n >= 1 && n <= count) return n;
  }
}

/**
 * Sets fabrik up for the owner of the folder. `ask(prompt, hidden)` answers each question, `askHidden(prompt)` the
 * token's, and `say` prints a line. `endFolder(folder)` ends setup in the folder. `home` holds the sign-in page's folder
 * and Wrangler's sign-in. Returns the exit code.
 */
export async function ownerSetup(argv, {
  ask = askLine, askHidden = terminalHidden, say = line => stdout.write(`${line}\n`), base = apiBase(),
  setup = SETUP_FOLDER, endFolder = () => {}, env = process.env, home = homedir(),
} = {}) {
  let o;
  try { o = options(argv); }
  catch (err) { say(`${err.message}\n${OWNER_SETUP_USAGE}`); return 2; }
  const folder = o.folder;
  let build;
  try { build = await import(pathToFileURL(join(setup, "build.mjs")).href); }
  catch { say(`fabrik's setup files are not at ${setup}. Run this command from the fabrik marketplace.`); return 1; }
  const stand = base !== API;
  // The stand-in is said before any prompt, so a token is never pasted for one unseen.
  if (stand) say(`This run talks to a test stand-in at ${base}, not to Supabase. Paste no real token.`);
  const projectUrl = ref => stand ? base : `https://${ref}.supabase.co`;
  const waitMs = stand && Number(env.FABRIK_TEST_HEALTH_WAIT_MS) > 0 ? Number(env.FABRIK_TEST_HEALTH_WAIT_MS) : 600000;

  say(`Make a Supabase access token at ${TOKEN_PAGE}, with the shortest expiry. If the page asks, choose Organization, pick your organization and keep Full access. Paste the token here, and delete it on that page once setup is done.`);
  let token;
  try { token = await askHidden("Supabase access token: "); }
  catch (err) { say(`Stopped: ${said(err)}`); return 1; }
  if (!token) { say("No token was pasted. Run this again, and paste the token at the prompt."); return 1; }
  const c = managementClient(token, base);
  token = undefined;

  let doing = "Checking your token";
  // Whether this run found fabrik already set up in the project, so its last lines treat the connector as added.
  let wasSetUp = false;
  const ready = new Set();
  async function waitReady(ref) {
    if (ready.has(ref)) return;
    say("Waiting for your project to be ready. This can take a few minutes.");
    let up;
    try { up = await waitHealthy(c, ref, { timeoutMs: waitMs, everyMs: Math.min(10000, Math.max(100, waitMs / 5)) }); }
    catch (err) {
      if (!(err instanceof ProjectStuck)) throw err;
      const dashboard = `https://supabase.com/dashboard/project/${ref}`;
      throw new Stop(PAUSED.includes(err.state)
        ? `Your Supabase project is paused. Restore it at ${dashboard}, then run this command again.`
        : `Supabase shows your project as ${err.state}, so it will not be ready. Look at it at ${dashboard}.`);
    }
    if (!up) {
      const minutes = Math.max(1, Math.round(waitMs / 60000));
      throw new Stop(`Your project was not ready within ${minutes} minute${minutes === 1 ? "" : "s"}. Run this command again later, and it carries on from here.`);
    }
    ready.add(ref);
    say("Waiting for your project to be ready: done.");
  }
  const read = name => readFileSync(join(setup, name), "utf8");
  /** The one row a query answers. An answer with no row stops the step it is in, with a plain line. */
  const oneRow = async (ref, sql) => {
    const [row] = await query(c, ref, sql);
    if (!row) throw new Stop(`${doing}: failed. Supabase's answer held no row. Run this command again to carry on.`);
    return row;
  };

  try {
    let orgs;
    try { orgs = await organizations(c); }
    catch (err) {
      if (err instanceof Refused && (err.status === 401 || err.status === 403))
        throw new Stop(`Supabase refused the token: ${said(err)} Make a new one at ${TOKEN_PAGE}, and run this again.`);
      throw err;
    }

    // The project: from the project file after a stop, or chosen.
    let project = readProject(folder);
    // The folder's own sign-in, read once: its email, and the project it signs in to.
    const actor = readActor(folder);
    let email = actor?.ok ? actor.value.auth_email : null;
    // The organisation, with its plan, read once a run.
    let orgInfo = null;
    if (project) say(`Carrying on with setup in your Supabase project ${project.name}.`);
    else {
      if (!orgs.length) throw new Stop("Your Supabase account has no organisation. Make one at https://supabase.com/dashboard, and run this again.");
      let org = orgs[0];
      if (orgs.length > 1) {
        say(orgs.map((x, i) => `${i + 1}. ${x.name}`).join("\n"));
        org = orgs[await pickNumber(ask, "Which of your Supabase organisations is for fabrik? Type its number: ", orgs.length) - 1];
      }
      doing = "Finding your project";
      orgInfo = await organization(c, org.slug);
      const plan = orgInfo.plan;
      const found = await projects(c, org.slug);
      let chosen = null;
      // A project picked from the list is read with state.sql first. One that is set up is carried on with only when
      // this folder is signed in to it, as the owner's own fabrik; otherwise it, and one that holds records or files,
      // is another fabrik: the owner is told so and asked again. Any other is used only once the owner types yes to
      // its name, since it may hold something else.
      while (found.length && !chosen) {
        say([...found.map((p, i) => `${i + 1}. ${p.name}`), `${found.length + 1}. A new project`].join("\n"));
        const pick = await pickNumber(ask, "Which project is for fabrik? Type its number: ", found.length + 1);
        if (pick === found.length + 1) break;
        const picked = found[pick - 1];
        doing = "Waiting for your project to be ready";
        await waitReady(picked.ref);
        doing = "Reading where your project stands";
        const was = await oneRow(picked.ref, read("state.sql"));
        if (was.setup_finished && actor?.ok && actor.value.project_ref === picked.ref) chosen = picked;
        else if (was.setup_finished || was.records || was.files) say(`${picked.name} already holds a fabrik. Choose another project, or a new one. To carry on with your own fabrik there, sign this folder in to it with node fabrik.mjs sign-in --folder "${folder}" first.`);
        else if ((await ask(`fabrik's tables, functions and settings go into ${picked.name}. Type 'yes' to set fabrik up there: `)).trim().toLowerCase() === "yes") chosen = picked;
        doing = "Finding your project";
      }
      if (!chosen) {
        let name = "";
        while (!name) name = (await ask("A name for your new Supabase project, such as fabrik: ")).trim().slice(0, 64);
        say(REGIONS.map(([, place], i) => `${i + 1}. ${place}`).join("\n"));
        const [region, place] = REGIONS[await pickNumber(ask, "Where should your project be? Type the number of the place nearest you: ", REGIONS.length) - 1];
        if (plan !== "free") {
          say(plan ? `${org.name} is on Supabase's ${plan} plan, so Supabase charges for a new project there.`
            : "This organisation's plan is not Free, so Supabase charges for a project.");
          const yes = (await ask(`Type 'yes' to create the project ${name} in ${place}: `)).trim().toLowerCase();
          if (yes !== "yes") throw new Stop("Nothing was created.");
        }
        doing = `Creating your project in ${place}`;
        // The database password is made here, sent once with the project, and kept nowhere.
        const made = await createProject(c, { orgSlug: org.slug, name, region, dbPass: randomBytes(24).toString("base64url") });
        if (!made.ref) throw new Stop(`Supabase made the project ${name}, but its answer did not say which project it is. Run this command again, and choose ${name} from the list.`);
        chosen = { ref: made.ref, name };
        say(`Creating your project in ${place}: done.`);
      }
      project = { ref: chosen.ref, name: chosen.name, organization: org.slug };
      writeProject(folder, project);
    }
    const { ref } = project;
    const url = projectUrl(ref);

    doing = "Waiting for your project to be ready";
    await waitReady(ref);

    doing = "Reading where your project stands";
    const state = await oneRow(ref, read("state.sql"));
    let reset = false;
    if (state.fabrik_built && !state.setup_finished) {
      if (state.records || state.files)
        throw new Stop(`${project.name} already holds fabrik records from an earlier setup, so setup stopped. Nothing was changed.`);
      const yes = (await ask(`An earlier setup in ${project.name} stopped part way. Type 'yes' to clear it and set fabrik up again: `)).trim().toLowerCase();
      if (yes !== "yes") throw new Stop("Nothing was changed.");
      reset = true;
    }
    const key = await publishableKey(c, ref);

    const all = build.functions(setup);
    const deploy = async f => deployFunction(c, ref, { name: f.name, entrypoint: f.entrypoint_path, verifyJwt: f.verify_jwt,
      files: f.files.map(x => ({ name: x.name, text: readFileSync(x.path, "utf8") })) });
    // Each function's files, as one hash, kept in the project file, so a later run deploys only the functions that changed.
    const functionHashes = Object.fromEntries(all.map(f => [f.name, functionHash(f)]));

    if (!state.setup_finished) {
      doing = "Building fabrik";
      await deploy(all[0]);
      await query(c, ref, build.approve({ ref, folder, reset }, { here: setup }).sql);
      const runFiles = async names => {
        for (const name of names) {
          const ran = await build.runFile(url, key, name, build.fileText(name, ref, setup));
          if (!ran.ok) throw new Stop(`${doing}: failed. ${name}: ${said(ran.problem)}`);
        }
      };
      await runFiles([...(reset ? ["reset.sql"] : []), "setup.sql", "file-search.sql", "file-search-scopes.sql"]);
      say("Building fabrik: done.");

      doing = "Deploying fabrik's hosted functions";
      for (const f of all.slice(1)) await deploy(f);
      await runFiles(["schedule.sql"]);
      say("Deploying fabrik's hosted functions: done.");

      doing = "Turning on the Data API";
      await exposeFabrik(c, ref);
      // The same setting on the authenticator role, which health.sql reads.
      await query(c, ref, read("data-api.sql"));
      say("Turning on the Data API: done.");

      // The owner's own sign-in. The project reference is asked only when the address hides it, as a stand-in's does.
      doing = "Your sign-in";
      try {
        const offered = await profileEmail(c);
        email = await ownerSignIn({ url, key, folder, inSetup: true, offered }, (prompt, hidden) => prompt === "Project reference: " ? ref : ask(prompt, hidden), say);
      } catch (err) { throw new Stop(`Your sign-in stopped: ${said(err)} Run this command again to carry on.`); }

      doing = "Making you the administrator";
      await runFiles(["first-administrator.sql"]);
      say("Making you the administrator: done.");
    } else if (!state.runner_ready) {
      wasSetUp = true;
      say(`fabrik is already set up in ${project.name}.`);
    } else {
      // An earlier run built fabrik and stopped before its checks passed: the Data API is set again before they run.
      doing = "Turning on the Data API";
      await exposeFabrik(c, ref);
      await query(c, ref, read("data-api.sql"));
      say("Turning on the Data API: done.");
    }

    if (!email) throw new Stop(`${folder} is not signed in. Run node fabrik.mjs sign-in --folder "${folder}", then run this command again.`);
    if (!orgInfo && project.organization) orgInfo = await organization(c, project.organization);
    const plan = orgInfo?.plan ?? null;
    if (state.runner_ready || !state.setup_finished) {
      // The checks as the owner, the setup record, and fabrik_setup dropped.
      doing = "Checking everything works";
      const health = await oneRow(ref, read("health.sql"));
      if (health.ok !== true) throw new Stop(`${doing}: failed. The health check found: ${Object.entries(health ?? {}).filter(([k, v]) => k !== "ok" && v === false).map(([k]) => k).join(", ") || "nothing"}.`);
      const deployed = await functionsList(c, ref);
      const wrong = build.FUNCTIONS.filter(f => !deployed.some(d => d.slug === f.name && d.verify_jwt === f.verify_jwt)).map(f => f.name);
      if (wrong.length) throw new Stop(`${doing}: failed. These hosted functions are missing or have the wrong JWT setting: ${wrong.join(", ")}.`);
      const tools = createTools({ ref, email, agentFolder: folder, defaultSchema: "fabrik" });
      const call = async (name, args) => JSON.parse((await tools.callTool(name, args)).content[0].text);
      const rpc = (fn, args = {}) => call("rpc", { function: fn, schema: "fabrik", args });
      const scopes = await rpc("fabrik_get_scopes");
      const listed = scopes.result?.items ?? scopes.items ?? scopes.result ?? scopes;
      const seen = Array.isArray(listed) ? listed.map(x => x.code) : [];
      const missing = SCOPES.filter(s => !seen.includes(s));
      if (scopes.ok === false || missing.length) throw new Stop(`${doing}: failed. ${scopes.problem ?? `Your fabrik does not list ${missing.join(", ")}.`}`);
      const search = await call("call_function", { name: "file-search", body: { query: "setup check" } });
      if (!Array.isArray(search.result?.hits ?? search.hits)) throw new Stop(`${doing}: failed. File search answered: ${search.problem ?? JSON.stringify(search).slice(0, 200)}`);
      say("Checking everything works: done.");

      doing = "Saving the setup record";
      const kept = await oneRow(ref, `select exists(select 1 from fabrik.record_version v join fabrik.record r using (record_id)
        join fabrik.scope s on s.scope_id = r.scope_id where s.code = 'administration' and v.title = '${RECORD_TITLE}') as record`);
      if (!kept.record) {
        const saved = await rpc("fabrik_add_record", { p_scope: "administration", p_kind: "evidence", p_title: RECORD_TITLE,
          p_reason: "The setup command's record of who set the project up, and how.",
          p_fields: { summary: `${email} set fabrik up. fabrik and file search were built, the hosted functions deployed and the Data API set, and the health check passed.`,
            source_reference: "fabrik setup --owner", source_date: new Date().toISOString().slice(0, 10), standing: "observed", limitations: "Written down by the setup command." } });
        if (!saved.record_id && !saved.result?.record_id) throw new Stop(`${doing}: failed. ${saved.problem ?? JSON.stringify(saved).slice(0, 200)}`);
      }
      await query(c, ref, "drop schema if exists fabrik_setup cascade;");
      say("Saving the setup record: done.");
    }
    // A run on a finished fabrik deploys each hosted function whose files differ from those last deployed. fabrik-setup is
    // left out: it serves setup alone, and its schema is gone once setup has finished.
    if (state.setup_finished) {
      const changed = all.filter(f => f.name !== "fabrik-setup" && project.functions?.[f.name] !== functionHashes[f.name]);
      if (changed.length) {
        doing = "Updating fabrik's hosted functions";
        for (const f of changed) await deploy(f);
        say(`Updating fabrik's hosted functions: done, ${changed.map(f => f.name).join(", ")}.`);
      }
    }
    project = { ...project, functions: functionHashes };
    writeProject(folder, project);

    doing = "Ending setup in your folder";
    await endFolder(folder);

    // The sign-in page, on the owner's Cloudflare Pages: its folder made here, and put up with Wrangler, as sign-in-page.mjs
    // says. It is put up again when its source files differ from those last put up, and left alone when they are the same.
    doing = "Your sign-in page";
    const page = pageHash(setup);
    if (!project.site || project.page !== page) {
      // The page's folder is fabrik's own, outside the owner's folder, made again from the current files each time.
      const pageDir = pageFolder(ref, home);
      rmSync(pageDir, { recursive: true, force: true });
      build.signIn({ ref, key, folder: pageDir }, { here: setup });
      // A stand-in Wrangler is used only with the Management API's stand-in, so a real run never runs another program.
      const wrangler = stand && env.FABRIK_TEST_WRANGLER ? [process.execPath, env.FABRIK_TEST_WRANGLER] : WRANGLER;
      let site;
      try { site = await putUpSignInPage({ ref, folder: pageDir }, { ask, say, wrangler, home, env }); }
      catch (err) { throw new Stop(`${said(err)} Run this command again to carry on.`); }
      project = { ...project, site, page };
      writeProject(folder, project);
      say(`Your sign-in page: done, at ${site}.`);
    }

    doing = "fabrik's connector's settings";
    const settings = await makeSettings({ ref, site: project.site }, null, base, c);
    for (const line of settings.lines) say(line);
    if (settings.code !== 0) return settings.code === AGAIN ? AGAIN : 1;

    say(`fabrik is set up in ${project.name}, and you are its administrator.`);
    if (plan === "free") say("Your Supabase plan is Free, which pauses a project nobody uses for a week. A paid plan keeps it running.");
    // A run after setup finished cannot see Claude's connectors, so it names the step only for one not yet added.
    const signedIn = readActor(folder);
    const local = signedIn?.ok && signedIn.value.connector === LOCAL;
    const localOn = `fabrik's local connector is on in ${folder}. Open a Code session in the Claude desktop app in that folder, and fabrik's tools are there, with no connector in Claude's Settings.`;
    if (wasSetUp) {
      if (local) say(localOn);
      else say(`If fabrik's connector is already in Claude, nothing more is needed. If not, in Claude, open Settings, Connectors, and add a custom connector named fabrik at this address:\n${url}/functions/v1/fabrik-apps\nSign in there with the fabrik email and password you chose when you set fabrik up.\nIf your Claude team doesn't let you add a custom connector, run node fabrik.mjs sign-in --folder "${folder}" --local instead.`);
    } else {
      // Some Claude teams allow no custom connectors. Their members reach fabrik through the plugin's local connector.
      let answer = "";
      try { answer = (await ask("Can you add a custom connector in Claude's Settings? Some Claude teams don't allow it. Type 'no' if you can't, or press Enter if you can: ")).trim().toLowerCase(); }
      catch { answer = ""; }
      if (answer === "no" && signedIn?.ok) {
        writeActorFile(signedIn.folder, { projectRef: signedIn.value.project_ref, email: signedIn.value.auth_email, local: true });
        say(localOn);
        say("fabrik reaches only that folder's Code sessions this way, not claude.ai, the phone app or Cowork.");
      } else say(`One step is left. In Claude, open Settings, Connectors, and add a custom connector named fabrik at this address:\n${url}/functions/v1/fabrik-apps\nSign in there with the fabrik email and password you chose in this setup, not your Claude or Supabase login.`);
    }
    say(`Delete the access token at ${TOKEN_PAGE}.`);
    return 0;
  } catch (err) {
    if (err instanceof Stop) say(err.message);
    else if (err instanceof Refused && err.status === 404 && doing === "Waiting for your project to be ready")
      say("Supabase shows this token no such project. Make the token in the account that holds your project, and run this again.");
    else if (err instanceof Refused && (err.status === 401 || err.status === 403)) say(`Supabase refused the token: ${said(err)} Make a new one at ${TOKEN_PAGE}, and run this again.`);
    else if (err instanceof Refused) say(`${doing}: failed. Supabase said: ${said(err)} Every step before it stays done. Run this command again to carry on.`);
    else if (err instanceof Error && err.message === "cancelled.") say("Stopped. Run this command again to carry on.");
    else say(`${doing}: failed. ${said(err)} Run this command again to carry on.`);
    return 1;
  }
}
