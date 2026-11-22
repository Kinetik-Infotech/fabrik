// fabrik's setup against the stand-in: its parts, build.mjs, fabrik-setup and the owner's sign-in, driven one by one on a
// new project and on an earlier, unfinished attempt; then, in section 6, the whole of fabrik setup --owner in one run,
// through a stand-in for Supabase's Management API, on a project of its own. A small stand-in for Supabase's Auth, its Data API and its hosted
// functions answers over HTTP, with the real fabrik-setup and file-search functions loaded from the setup folder, and
// every call made in the stand-in database. executeSql is postgres.js as postgres, sending each statement as the
// Management API's database/query does.
//
// On a new project: state.sql reads it as new; build.mjs lists each hosted function with every file it imports, for
// its deploy; build.mjs approve's statement makes fabrik_setup and writes the owner's sign-in code; build.mjs
// run sends setup.sql, file-search.sql, file-search-scopes.sql and schedule.sql to fabrik-setup, which refuses a file
// it has not approved, and a file twice. That build is then taken as an earlier attempt that made the administrator
// and the scopes by hand and stopped: state.sql reads it as unfinished with no record, and reset.sql through
// fabrik-setup takes it off, and the build runs again. data-api.sql exposes fabrik. The owner's first sign-in, the fabrik
// command's sign-in --owner as its flow runs it, makes the owner's Auth user with the password they chose, an earlier
// attempt's Auth user given it, and the owner signed in, with no password in the database's fabrik_setup. Then
// first-administrator.sql makes the administrator, the three scopes as bootstrap.sql's step 2 makes them, and the
// owner's sessions scope. health.sql passes. The owner, with the fabrik command, lists the scopes, finds that the
// Data API refuses fabrik without data-api.sql's setting, searches with file-search, and saves the setup record in
// Administration. reset.sql then refuses, as fabrik holds records, and changes nothing.
// First, on an unfinished attempt that holds a record, reset.sql refuses and changes nothing.
// setup-flow.sh runs it on a cluster of its own, with STAND_IN_DB, STAND_IN_PARTLY_DB and STAND_IN_OWNER_DB naming three
// new databases with supabase.sql's parts, and STAND_IN_ADMIN_DB the cluster's superuser, which drops each once it is done.
import postgres from "npm:postgres@3.4.9";
import { SCOPES } from "../../plugins/fabrik/cli/sign-in-page.mjs";

const DB = Deno.env.get("STAND_IN_DB")!;
const PARTLY_DB = Deno.env.get("STAND_IN_PARTLY_DB")!;
const ADMIN_DB = Deno.env.get("STAND_IN_ADMIN_DB")!;
const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SETUP = `${REPO}/setup`;
const BUILD = `${SETUP}/build.mjs`;
const FABRIK = `${REPO}/plugins/fabrik/cli/fabrik.mjs`;
const REF = "standinsetupflow0000";
const KEY = "sb_publishable_setupflow";
const SERVICE_KEY = "service-key-setupflow";
const WORK = await Deno.makeTempDir({ prefix: "fabrik-setup-flow-" });
const HOME = `${WORK}/home`;
const FOLDER = `${HOME}/fabrik`;
await Deno.mkdir(`${FOLDER}/.claude`, { recursive: true });
const decoder = new TextDecoder();

let failed = 0;
function check(what: string, ok: boolean, seen: unknown) {
  console.log(`${ok ? "ok" : "FAIL"} - ${what}${ok ? "" : `: ${typeof seen === "string" ? seen : JSON.stringify(seen)}`}`);
  if (!ok) failed++;
}
function must(what: string, ok: boolean, seen: unknown) {
  check(what, ok, seen);
  if (!ok) throw new Error(`stopped: ${what}`);
}
function quote(out: string) {
  for (const line of out.trimEnd().split("\n")) console.log(`    | ${line}`);
}
async function run(args: string[], env: Record<string, string> = {}) {
  const out = await new Deno.Command("node", { args, cwd: FOLDER, env: { HOME, USERPROFILE: HOME, ...env }, stdout: "piped", stderr: "piped" }).output();
  return { status: out.code, out: decoder.decode(out.stdout), err: decoder.decode(out.stderr) };
}

// The database the stand-in serves: the flow database, then the owner database for section 6's fabrik setup --owner.
let sql = postgres(DB, { max: 2, prepare: false, onnotice() {} });
/** The Management API's database/query: the statements as one request, the last one's rows back. */
// deno-lint-ignore no-explicit-any
const executeSql = async (text: string): Promise<any[]> => {
  const result = await sql.unsafe(text).simple();
  // deno-lint-ignore no-explicit-any
  const sets = (Array.isArray(result) && Array.isArray((result as any)[0]) ? result : [result]) as any[];
  return sets.at(-1);
};
const read = (name: string) => Deno.readTextFileSync(`${SETUP}/${name}`);
const state = async () => (await executeSql(read("state.sql")))[0];

// ---- Supabase's Auth, Data API and hosted functions, as far as setup uses them ----

type User = { id: string; email: string; password: string };
const users = new Map<string, User>();
const tokens = new Map<string, string>();
const refresh = new Map<string, string>();
const issue = (user: User) => {
  const access = `at-${crypto.randomUUID()}`, again = `rt-${crypto.randomUUID()}`;
  tokens.set(access, user.id);
  refresh.set(again, user.id);
  return { access_token: access, refresh_token: again, token_type: "bearer", expires_in: 3600, user: { id: user.id, email: user.email } };
};
const byId = (id: string) => [...users.values()].find(u => u.id === id);
const json = (body: unknown, status = 200) => Response.json(body, { status });

async function rpcCall(fn: string, args: Record<string, unknown>) {
  const procs = await sql`select p.proargnames as names, p.pronargs as n, p.pronargdefaults as defaults,
    array(select format_type(t, null) from unnest(p.proargtypes) t) as types
    from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'fabrik' and p.proname = ${fn}`;
  const given = Object.keys(args);
  // deno-lint-ignore no-explicit-any
  const proc = procs.find((p: any) => given.every(k => (p.names ?? []).includes(k)) && (p.names ?? []).slice(0, p.n - p.defaults).every((k: string) => given.includes(k)));
  if (!proc) return null;
  const params: unknown[] = [];
  const parts = given.map(k => {
    const type = proc.types[proc.names.indexOf(k)];
    const v = args[k];
    // A boolean goes as a boolean: postgres.js, with prepare off, sends the text "true" to a boolean parameter as false.
    params.push(v === null ? null : type === "jsonb" || type.endsWith("[]") ? v : typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? v : String(v));
    const at = `$${params.length}`;
    return `${k} => ${type.endsWith("[]") ? `(select array_agg(x) from jsonb_array_elements_text(${at}::jsonb) x)::${type}` : `${at}::${type}`}`;
  });
  return { query: `select to_jsonb(fabrik.${fn}(${parts.join(", ")})) as r`, params };
}

// ---- Supabase's Management API, as far as fabrik setup --owner uses it, for section 6 ----
// Organisations, projects and health from the state below; database/query runs on the stand-in database as postgres;
// functions/deploy writes each deployed function's files to a folder of its own, and the server serves the function
// from them, with its verify_jwt; api-keys gives the project's publishable key; config/auth and the signing keys are
// kept here. A request without the stand-in's token is turned away, as Supabase turns it away.
const MGMT_TOKEN = "sbp_standin0000ownersetup1111token2222";
const OWNER_REF = "ownersetupstandin000";
let owning = false;
type Fn = { slug: string; verify_jwt: boolean; entrypoint_path: string; files: string[]; root: string; handler?: (req: Request) => Promise<Response> };
const mgmt = {
  organizations: [{ id: crypto.randomUUID(), slug: "olive-org", name: "Olive's organisation", plan: "free" },
    { id: crypto.randomUUID(), slug: "olive-paid", name: "Olive's paid organisation", plan: "pro" }],
  projects: [] as { ref: string; name: string; organization_slug: string; region: string; status: string }[],
  healthy: false,
  dbPasses: [] as string[],
  functions: new Map<string, Fn>(),
  config: { site_url: "http://localhost:3000", oauth_server_enabled: false, oauth_server_allow_dynamic_registration: false, oauth_server_authorization_path: null, disable_signup: false } as Record<string, unknown>,
  // A new project starts on an asymmetric signing key, as Supabase makes them now.
  keys: [{ id: crypto.randomUUID(), algorithm: "ES256", status: "in_use" }],
  // The Data API's own setting, which Supabase's PostgREST takes its schemas from.
  postgrest: { db_schema: "public, graphql_public" } as Record<string, unknown>,
  calls: [] as { method: string; path: string }[],
  // A function whose deploy Supabase refuses, with this message, or null.
  refuseDeploy: null as { slug: string; message: string } | null,
  // Any request that carried the token anywhere but its Authorization header.
  leaks: [] as string[],
};
let deployCount = 0;
async function managementApi(req: Request, url: URL): Promise<Response> {
  const path = url.pathname;
  mgmt.calls.push({ method: req.method, path: `${path}${url.search}` });
  if (url.search.includes(MGMT_TOKEN)) mgmt.leaks.push(`${req.method} ${path}${url.search}`);
  if (req.headers.get("authorization") !== `Bearer ${MGMT_TOKEN}`) return json({ message: "Unauthorized" }, 401);
  const type = req.headers.get("content-type") ?? "";
  // deno-lint-ignore no-explicit-any
  let body: any = null;
  let form: FormData | null = null;
  if (type.startsWith("multipart/form-data")) form = await req.formData();
  else { const text = await req.text(); if (text.includes(MGMT_TOKEN)) mgmt.leaks.push(`${req.method} ${path} body`); body = text ? JSON.parse(text) : null; }
  let m: RegExpMatchArray | null;
  if (req.method === "GET" && path === "/v1/profile") return json({ gotrue_id: "gotrue-olive", primary_email: "olive@owner.example", username: "olive" });
  if (req.method === "GET" && path === "/v1/organizations") return json(mgmt.organizations.map(({ id, slug, name }) => ({ id, slug, name })));
  if (req.method === "GET" && (m = path.match(/^\/v1\/organizations\/([\w-]+)(\/projects)?$/))) {
    const org = mgmt.organizations.find(o => o.slug === m![1]);
    if (!org) return json({ message: "Organization not found" }, 404);
    if (!m[2]) return json({ id: org.id, name: org.name, plan: org.plan, opt_in_tags: [], allowed_release_channels: ["ga"] });
    const all = mgmt.projects.filter(p => p.organization_slug === org.slug);
    return json({ projects: all.map(p => ({ ref: p.ref, name: p.name, region: p.region, status: p.status })), pagination: { count: all.length, limit: 100, offset: 0 } });
  }
  if (req.method === "POST" && path === "/v1/projects") {
    if (!body?.db_pass || !body?.name || !body?.organization_slug) return json({ message: "db_pass, name and organization_slug are required." }, 400);
    mgmt.dbPasses.push(body.db_pass);
    const made = { ref: OWNER_REF, name: body.name, organization_slug: body.organization_slug, region: body.region_selection?.code ?? "us-east-1", status: "COMING_UP" };
    mgmt.projects.push(made);
    return json({ id: made.ref, ref: made.ref, name: made.name, organization_slug: made.organization_slug, region: made.region, status: made.status }, 201);
  }
  if (!(m = path.match(/^\/v1\/projects\/([a-z0-9]{20})(\/.*)?$/)) || !mgmt.projects.some(p => p.ref === m![1])) return json({ message: "Project not found" }, 404);
  const tail = m[2] ?? "";
  if (req.method === "GET" && tail === "") {
    const p = mgmt.projects.find(x => x.ref === m![1])!;
    return json({ id: p.ref, ref: p.ref, name: p.name, organization_slug: p.organization_slug, region: p.region, status: p.status });
  }
  if (req.method === "GET" && tail === "/health") {
    if (mgmt.healthy) for (const p of mgmt.projects) p.status = "ACTIVE_HEALTHY";
    return json((url.searchParams.get("services") ?? "").split(",").map(name => ({ name, healthy: mgmt.healthy, status: mgmt.healthy ? "ACTIVE_HEALTHY" : "COMING_UP" })));
  }
  if (req.method === "POST" && tail === "/database/query") {
    try { return json(await executeSql(body.query) ?? [], 201); }
    catch (err) { return json({ message: `Failed to run sql query: ${(err as Error).message}` }, 400); }
  }
  if (req.method === "POST" && tail === "/functions/deploy" && form) {
    const metadata = JSON.parse(String(form.get("metadata")));
    const slug = url.searchParams.get("slug") ?? metadata.name;
    if (mgmt.refuseDeploy?.slug === slug) return json({ message: mgmt.refuseDeploy.message }, 400);
    const root = `${WORK}/deployed-${++deployCount}`;
    await Deno.mkdir(`${root}/functions/${slug}`, { recursive: true });
    const files: string[] = [];
    for (const part of form.getAll("file")) {
      const file = part as File;
      const path = `${root}/functions/${slug}/${file.name}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(path, await file.text());
      files.push(file.name);
    }
    mgmt.functions.set(slug, { slug, verify_jwt: metadata.verify_jwt ?? true, entrypoint_path: metadata.entrypoint_path, files, root });
    return json({ id: crypto.randomUUID(), slug, name: metadata.name, status: "ACTIVE", verify_jwt: metadata.verify_jwt, entrypoint_path: metadata.entrypoint_path }, 201);
  }
  if (req.method === "GET" && tail === "/functions") return json([...mgmt.functions.values()].map(f => ({ slug: f.slug, name: f.slug, status: "ACTIVE", verify_jwt: f.verify_jwt })));
  if (req.method === "GET" && tail === "/api-keys") return json([{ name: "default", type: "publishable", api_key: KEY }, { name: "default", type: "secret", api_key: "sb_secret_····" }]);
  if (tail === "/postgrest" && req.method === "GET") return json(mgmt.postgrest);
  if (tail === "/postgrest" && req.method === "PATCH") { Object.assign(mgmt.postgrest, body); return json(mgmt.postgrest); }
  if (tail === "/config/auth" && req.method === "GET") return json(mgmt.config);
  if (tail === "/config/auth" && req.method === "PATCH") { Object.assign(mgmt.config, body); return json(mgmt.config); }
  if (tail === "/config/auth/signing-keys" && req.method === "GET") return json({ keys: mgmt.keys });
  return json({ message: `The stand-in has no ${req.method} ${path}` }, 404);
}

// The files in Storage, by bucket and path, that the stand-in serves.
const stored = new Map<string, string>();
let fabrikSetup: (req: Request) => Promise<Response>;
let fabrikUpgrade: (req: Request) => Promise<Response>;
let fileSearch: (req: Request) => Promise<Response>;
const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  try {
    if (path.startsWith("/v1/")) return await managementApi(req, url);
    // In section 6, each hosted function is served from the files fabrik setup --owner deployed, with its verify_jwt.
    const slug = path.match(/^\/functions\/v1\/([a-z-]+)/)?.[1];
    if (owning && slug) {
      const fn = mgmt.functions.get(slug);
      if (!fn) return json({ code: "NOT_FOUND", message: "Requested function was not found" }, 404);
      if (fn.verify_jwt && !tokens.has(bearer)) return json({ msg: "Invalid JWT" }, 401);
      fn.handler ??= await load(slug, fn.root);
      return await fn.handler(req);
    }
    if (path.startsWith("/functions/v1/fabrik-setup/")) return await fabrikSetup(req);
    // fabrik-upgrade is deployed with verify_jwt on.
    if (path === "/functions/v1/fabrik-upgrade") return tokens.has(bearer) ? await fabrikUpgrade(req) : json({ msg: "Invalid JWT" }, 401);
    if (path === "/functions/v1/file-search") return await fileSearch(req);
    // Supabase Auth's admin API, with the service key alone.
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/auth\/v1\/admin\/users(?:\/([0-9a-f-]{36}))?$/))) {
      if (bearer !== SERVICE_KEY || req.headers.get("apikey") !== SERVICE_KEY) return json({ msg: "This endpoint requires a valid service key" }, 401);
      if (req.method === "POST" && !m[1]) {
        const body = await req.json();
        if (users.has(body.email)) return json({ msg: "A user with this email address has already been registered" }, 422);
        if (!body.email_confirm) return json({ msg: "the stand-in makes confirmed users only" }, 400);
        const user = { id: crypto.randomUUID(), email: body.email, password: body.password };
        await sql`insert into auth.users(id, email, created_at) values (${user.id}, ${user.email}, now())`;
        users.set(user.email, user);
        return json({ id: user.id, email: user.email });
      }
      const user = m[1] ? byId(m[1]) : undefined;
      if (!user) return json({ msg: "User not found" }, 404);
      if (req.method === "PUT") { const body = await req.json(); if (body.password) user.password = body.password; return json({ id: user.id, email: user.email }); }
      if (req.method === "DELETE") { users.delete(user.email); await sql`delete from auth.users where id = ${user.id}`; return json({}); }
    }
    if (req.headers.get("apikey") !== KEY) return json({ message: "Invalid API key" }, 401);
    if (req.method === "POST" && path === "/auth/v1/token") {
      const body = await req.json();
      if (url.searchParams.get("grant_type") === "password") {
        const user = users.get(body.email);
        return user && user.password === body.password ? json(issue(user)) : json({ error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400);
      }
      const id = refresh.get(body.refresh_token);
      if (!id) return json({ error_code: "refresh_token_already_used", msg: "Invalid Refresh Token: Already Used" }, 400);
      refresh.delete(body.refresh_token);
      return json(issue(byId(id)!));
    }
    const sub = tokens.get(bearer);
    if (!sub) return json({ msg: "invalid JWT" }, 401);
    if (req.method === "GET" && path === "/auth/v1/user") return json({ id: sub, email: byId(sub)!.email });
    // Storage's download of one file, as the signed-in person, when the project's storage rules let them see it.
    if (req.method === "GET" && (m = path.match(/^\/storage\/v1\/object\/authenticated\/([^/]+)\/(.+)$/))) {
      // deno-lint-ignore no-explicit-any
      const seen = await sql.begin(async (tx: any) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        return await tx`select 1 from storage.objects where bucket_id = ${m![1]} and name = ${decodeURIComponent(m![2])}`;
      });
      const kept = stored.get(`${m[1]}/${decodeURIComponent(m[2])}`);
      return seen.length && kept !== undefined ? new Response(kept, { headers: { "Content-Type": "application/json" } }) : json({ statusCode: "404", error: "not_found", message: "Object not found" }, 400);
    }
    // The Data API serves only the schemas authenticator's pgrst.db_schemas names, as PostgREST reads it.
    if (req.method === "POST" && (m = path.match(/^\/rest\/v1\/rpc\/(fabrik_[a-z_]+)$/))) {
      const [{ schemas }] = await sql`select coalesce((select substr(c, length('pgrst.db_schemas=') + 1) from pg_roles r, unnest(r.rolconfig) c
        where r.rolname = 'authenticator' and c like 'pgrst.db_schemas=%'), 'public, graphql_public') as schemas`;
      const exposed = String(schemas).split(",").map(s => s.trim());
      const profile = req.headers.get("content-profile") ?? "public";
      if (!exposed.includes(profile)) return json({ code: "PGRST106", message: `Invalid schema: ${profile}`, hint: `Only the following schemas are exposed: ${exposed.join(", ")}` }, 406);
      const call = await rpcCall(m[1], await req.json());
      if (!call) return json({ code: "PGRST202", message: `Could not find the function fabrik.${m[1]}` }, 404);
      // deno-lint-ignore no-explicit-any
      const [{ r }] = await sql.begin(async (tx: any) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub, role: "authenticated" })}, true)`;
        await tx`set local role authenticated`;
        return await tx.unsafe(call.query, call.params);
      }) as any;
      return json(r);
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return json({ code: e.code, message: e.message }, e.code === "42501" ? 403 : 400);
  }
  return json({ message: `The stand-in has no ${req.method} ${path}` }, 404);
});
const PROJECT_URL = `http://127.0.0.1:${server.addr.port}`;
Deno.env.set("SUPABASE_URL", PROJECT_URL);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
Deno.env.set("SUPABASE_ANON_KEY", KEY);
Deno.env.set("SUPABASE_DB_URL", DB);
(globalThis as Record<string, unknown>).Supabase = { ai: { Session: class { run() { return Promise.resolve(new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0))); } } } };
async function load(name: string, root = SETUP): Promise<(req: Request) => Promise<Response>> {
  let handler: ((req: Request) => Promise<Response>) | undefined;
  const serve = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (h: typeof handler) => { handler = h; return { finished: Promise.resolve(), shutdown() {} }; };
  await import(new URL(`${root}/functions/${name}/index.ts`, "file://").href);
  (Deno as unknown as { serve: unknown }).serve = serve;
  return handler!;
}
fabrikSetup = await load("fabrik-setup");
// fabrik-upgrade as deployed, with a throwaway key pair sign-upgrade.mjs makes now in place of the real one.
const SIGN = `${REPO}/scripts/sign-upgrade.mjs`;
const KEY_FILE = `${WORK}/keys/upgrade-signing-key`;
const made = await new Deno.Command("node", { args: [SIGN, "--new-key", "--key", KEY_FILE], stdout: "piped", stderr: "piped" }).output();
const throwawayKey = decoder.decode(made.stdout).trim();
must("sign-upgrade.mjs --new-key writes a private key readable by its owner alone, in a folder of its own, and prints the public key",
  made.code === 0 && /^[A-Za-z0-9+/]{43}=$/.test(throwawayKey) && (Deno.statSync(KEY_FILE).mode! & 0o777) === 0o600 && (Deno.statSync(`${WORK}/keys`).mode! & 0o777) === 0o700
    && !decoder.decode(made.stdout).includes("PRIVATE"), decoder.decode(made.stderr));
const again = await new Deno.Command("node", { args: [SIGN, "--new-key", "--key", KEY_FILE], stdout: "piped", stderr: "piped" }).output();
check("sign-upgrade.mjs --new-key never replaces a key file", again.code === 1 && decoder.decode(again.stderr).includes("is there already"), decoder.decode(again.stderr));
await Deno.mkdir(`${WORK}/functions/fabrik-upgrade`, { recursive: true });
await Deno.copyFile(`${SETUP}/functions/fabrik-upgrade/index.ts`, `${WORK}/functions/fabrik-upgrade/index.ts`);
const keyTs = await Deno.readTextFile(`${SETUP}/functions/fabrik-upgrade/upgrade-key.ts`);
must("upgrade-key.ts holds one Ed25519 public key, and no private key", /^export const UPGRADE_PUBLIC_KEY = "[A-Za-z0-9+/]{43}=";$/m.test(keyTs) && !/PRIVATE/.test(keyTs), keyTs);
await Deno.writeTextFile(`${WORK}/functions/fabrik-upgrade/upgrade-key.ts`, keyTs.replace(/^export const UPGRADE_PUBLIC_KEY = .*$/m, `export const UPGRADE_PUBLIC_KEY = "${throwawayKey}";`));
fabrikUpgrade = await load("fabrik-upgrade", WORK);
fileSearch = await load("file-search");

// ---- 0. An earlier, unfinished attempt that holds a record ----
// First, in a database of its own, which then goes with fabrik's roles, which a cluster holds once.
const partly = postgres(PARTLY_DB, { max: 1, prepare: false, onnotice() {} });
try {
  for (const name of ["setup.sql", "file-search.sql", "file-search-scopes.sql"]) await partly.unsafe(Deno.readTextFileSync(`${SETUP}/${name}`)).simple();
  const id = crypto.randomUUID();
  await partly`insert into auth.users(id, email, created_at) values (${id}, 'pat@firm.example', now())`;
  const [{ admin }] = await partly`select fabrik_private.provision_first_administrator(${id}::uuid, 'Pat Partly') as admin`;
  await partly`insert into fabrik.scope(code, display_name, description, created_by) values ('general', 'General', 'An earlier attempt', ${admin})`;
  // deno-lint-ignore no-explicit-any
  await partly.begin(async (tx: any) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: id, role: "authenticated" })}, true)`;
    await tx`set local role authenticated`;
    await tx`select fabrik.fabrik_add_record('general', 'evidence', 'A note from the earlier attempt', 'Kept by the stand-in', '{"summary":"A note.","source_reference":"Stand-in","source_date":"2026-10-25","standing":"observed","limitations":"None."}'::jsonb)`;
  });
  const before = (await partly.unsafe(Deno.readTextFileSync(`${SETUP}/state.sql`)))[0];
  let problem = "";
  try { await partly.unsafe(Deno.readTextFileSync(`${SETUP}/reset.sql`)).simple(); } catch (err) { problem = (err as Error).message; }
  const after = (await partly.unsafe(Deno.readTextFileSync(`${SETUP}/state.sql`)))[0];
  quote(`state before: ${JSON.stringify(before)}\nreset.sql: ${problem}\nstate after: ${JSON.stringify(after)}`);
  check("an unfinished attempt that holds a record: reset.sql refuses with fabrik's count, and the project is as it was",
    before.fabrik_built && !before.setup_finished && before.records === 1 && problem === "fabrik holds 1 record(s), so nothing was reset" && JSON.stringify(before) === JSON.stringify(after), { before, problem, after });
} finally {
  await partly.end();
  const admin = postgres(ADMIN_DB, { max: 1, prepare: false, onnotice() {} });
  await admin.unsafe("drop database partly");
  await admin.unsafe("drop role fabrik_owner, fabrik_identity, fabrik_writer, fabrik_reader");
  await admin.end();
}


const sha256 = async (text: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), b => b.toString(16).padStart(2, "0")).join("");
const BUILD_FILES = ["setup.sql", "file-search.sql", "file-search-scopes.sql", "schedule.sql"];

try {
  // ---- 1. A new project ----
  let s = await state();
  must("state.sql reads a new project as new: no fabrik schema, no fabrik_setup", s.fabrik_built === false && s.setup_finished === false && s.runner_ready === false, s);

  // Each hosted function, as setup deploys it: a name, an entrypoint, verify_jwt and its files.
  let ran = await run([BUILD, "functions"]);
  const listed = JSON.parse(ran.out) as { name: string; verify_jwt: boolean; entrypoint_path: string; files: { name: string; path: string }[] }[];
  check("build.mjs functions lists fabrik-setup, file search's three functions, fabrik-upgrade, graph-reader, public-agent and fabrik-apps, in the order setup deploys them",
    listed.map(f => f.name).join(",") === "fabrik-setup,file-search-worker,file-search,file-search-purge,fabrik-upgrade,graph-reader,public-agent,fabrik-apps", listed.map(f => f.name));
  for (const f of listed) {
    const files = new Set(f.files.map(x => x.name));
    const imports: string[] = [];
    for (const file of f.files) {
      const text = Deno.readTextFileSync(file.path);
      for (const [, spec] of text.matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) imports.push(spec.replace(/^\.\//, ""));
      for (const [, spec] of text.matchAll(/@deno-types="([^"]+)"/g)) if (spec.startsWith(".")) imports.push(spec.replace(/^\.\//, ""));
    }
    const missing = imports.filter(i => !files.has(i));
    const header = Deno.readTextFileSync(f.files[0].path).slice(0, 1200);
    const said = /verify_jwt off/.test(header) ? false : /verify_jwt on/.test(header) ? true : null;
    const inFolder = [...Deno.readDirSync(`${SETUP}/functions/${f.name}`)].map(e => e.name).sort();
    const left = inFolder.filter(n => !files.has(n));
    check(`${f.name}: every file it imports is listed for its deploy (${[...files].join(", ")}), with entrypoint index.ts and verify_jwt ${f.verify_jwt}, as its own header says; left in its folder: ${left.join(", ") || "nothing"}`,
      missing.length === 0 && f.entrypoint_path === "index.ts" && f.files[0].name === "index.ts" && said === f.verify_jwt
        && f.files.every(x => Deno.statSync(x.path).isFile) && left.every(n => n === "vendor" || n === "text-checks.ts"),
      { missing, said, left });
  }

  // fabrik_setup and the approvals, as setup runs approve's statement as postgres.
  ran = await run([BUILD, "approve", "--ref", REF, "--folder", FOLDER]);
  must("build.mjs approve prints one statement, and names the code file only on stderr", ran.status === 0 && ran.err.includes(".fabrik-owner-code") && !ran.out.includes(Deno.readTextFileSync(`${FOLDER}/.fabrik-owner-code`).trim()), ran.err);
  let rows = await executeSql(ran.out);
  check("the statement makes fabrik_setup and approves setup's five files", rows.map((r: { name: string }) => r.name).sort().join(",") === "file-search-scopes.sql,file-search.sql,first-administrator.sql,schedule.sql,setup.sql", rows);
  const code = Deno.readTextFileSync(`${FOLDER}/.fabrik-owner-code`).trim();
  const [held] = await sql`select sha256 from fabrik_setup.owner_code`;
  check("the owner's code is in the setup folder, readable by the owner alone, and fabrik_setup holds only its SHA-256",
    (Deno.statSync(`${FOLDER}/.fabrik-owner-code`).mode! & 0o777) === 0o600 && held.sha256 === await sha256(code), { mode: Deno.statSync(`${FOLDER}/.fabrik-owner-code`).mode });
  const [{ ok: hidden }] = await sql`select not has_schema_privilege('anon', 'fabrik_setup', 'usage') and not has_schema_privilege('authenticated', 'fabrik_setup', 'usage') as ok`;
  check("anon and authenticated cannot reach fabrik_setup", hidden, hidden);

  let res = await fetch(`${PROJECT_URL}/functions/v1/fabrik-setup/sql`, { method: "POST", body: "select 1;" });
  let body = await res.json();
  check("fabrik-setup refuses a file nobody approved", res.status === 403 && /not approved/.test(body.problem), body);

  ran = await run([BUILD, "run", "--url", PROJECT_URL, "--key", KEY, "--ref", REF, ...BUILD_FILES]);
  quote(ran.out + ran.err);
  must("build.mjs run builds fabrik and file search through fabrik-setup, one line per file", ran.status === 0 && ran.out === BUILD_FILES.map(f => `${f}: done`).join("\n") + "\n", ran.out + ran.err);
  ran = await run([BUILD, "run", "--url", PROJECT_URL, "--key", KEY, "--ref", REF, "setup.sql"]);
  check("an approval runs once: setup.sql sent again is refused", ran.status === 1 && ran.err.startsWith("setup.sql: failed: This file is not approved"), ran.err);

  // ---- 2. The same build, taken as an earlier attempt that made the administrator and scopes by hand, and stopped ----
  const earlier = { id: crypto.randomUUID(), email: "olive@firm.example", password: "an old dashboard password" };
  await sql`insert into auth.users(id, email, created_at) values (${earlier.id}, ${earlier.email}, now())`;
  users.set(earlier.email, earlier);
  const [{ admin: earlierAdmin }] = await sql`select fabrik_private.provision_first_administrator(${earlier.id}::uuid, 'Olive Owner') as admin`;
  await sql`insert into fabrik.scope(code, display_name, description, created_by) values ('general', 'General', 'An earlier attempt', ${earlierAdmin}), ('reference', 'Reference', 'An earlier attempt', ${earlierAdmin})`;
  s = await state();
  check("state.sql reads an earlier attempt as built, unfinished, with no record or file", s.fabrik_built && !s.setup_finished && s.actors === 1 && s.records === 0 && s.files === 0, s);
  ran = await run([BUILD, "approve", "--ref", REF, "--folder", FOLDER, "--reset"]);
  await executeSql(ran.out);
  ran = await run([BUILD, "run", "--url", PROJECT_URL, "--key", KEY, "--ref", REF, "reset.sql"]);
  quote(ran.out + ran.err);
  const [left] = await sql`select (select count(*) from pg_namespace where nspname in ('fabrik', 'fabrik_private', 'fabrik_storage', 'fabrik_task', 'file_search'))::int as schemas,
    (select count(*) from pg_roles where rolname like 'fabrik\\_%')::int as roles, (select count(*) from storage.buckets)::int as buckets,
    (select count(*) from cron.job)::int as jobs, (select count(*) from vault.secrets)::int as secrets, to_regnamespace('fabrik_setup') is not null as runner,
    (select count(*) from auth.users)::int as auth_users`;
  check("reset.sql takes the attempt off: no fabrik or file search schema, role, bucket, job or secret, while fabrik_setup and the Auth user stay",
    ran.status === 0 && left.schemas === 0 && left.roles === 0 && left.buckets === 0 && left.jobs === 0 && left.secrets === 0 && left.runner && left.auth_users === 1, left);
  s = await state();
  check("state.sql reads the project as new again", s.fabrik_built === false && s.runner_ready === true, s);
  ran = await run([BUILD, "run", "--url", PROJECT_URL, "--key", KEY, "--ref", REF, ...BUILD_FILES]);
  quote(ran.out + ran.err);
  must("the build runs again from the start, with the approvals the reset's approve gave", ran.status === 0 && ran.out === BUILD_FILES.map(f => `${f}: done`).join("\n") + "\n", ran.out + ran.err);

  // ---- 3. The Data API, then the owner's first sign-in ----
  rows = await executeSql(read("data-api.sql"));
  check("data-api.sql sets the Data API to serve public, graphql_public and fabrik", JSON.stringify(rows[0]?.rolconfig ?? []).includes("pgrst.db_schemas=public, graphql_public, fabrik"), rows);

  // The owner's first sign-in, as they run it: the fabrik command's sign-in --owner, at a terminal of its own.
  const signIn = async (answers: string[]) => {
    const out = await new Deno.Command("python3", { args: [`${REPO}/test/stand-in/pty-answer.py`, JSON.stringify(answers), "node", FABRIK, "sign-in", "--owner", "--url", PROJECT_URL, "--key", KEY, "--folder", FOLDER],
      cwd: FOLDER, env: { HOME, USERPROFILE: HOME }, stdout: "piped", stderr: "piped" }).output();
    return { status: out.code, out: decoder.decode(out.stdout) + decoder.decode(out.stderr) };
  };
  let signed = await signIn([REF, "Olive Owner", "olive@firm.example", "a long chosen password", "a different password", ""]);
  quote(signed.out);
  check("two different passwords ask for the password again, nothing typed stops the owner's sign-in, and nothing changes",
    signed.status === 1 && signed.out.includes("The two passwords differ. Type the new password again, or press Return with nothing typed to stop.")
      && signed.out.includes("Sign-in stopped: no password was typed. Nothing was changed.") && (await sql`select count(*)::int as n from fabrik_setup.person`)[0].n === 0, signed.out);
  signed = await signIn([REF, "Olive Owner", "olive@firm.example", "a long chosen password", "a long chosen password"]);
  quote(signed.out);
  check("the owner's sign-in asks their name, their email and their password twice, shows no password, and ends by naming the command that finishes setup",
    signed.status === 0 && /Your name: Olive Owner\nYour email: olive@firm.example\nNothing shows as you type or paste\. Do it once, then press Enter\.\nChoose a password: \nNothing shows as you type or paste\. Do it once, then press Enter\.\nThe password again: \n/.test(signed.out) && !signed.out.includes("a long chosen password")
      && signed.out.trimEnd().endsWith(`Signed in as olive@firm.example. Run node fabrik.mjs setup --owner --folder "${FOLDER}" to finish setup.`), signed.out);
  const [person] = await sql`select auth_user_id, name, email, role from fabrik_setup.person where role = 'owner'`;
  check("an earlier attempt's Auth user for the owner's email gets the chosen password, and fabrik_setup records it with the owner's name",
    person?.auth_user_id === earlier.id && person.name === "Olive Owner" && users.get("olive@firm.example")!.password === "a long chosen password", person);
  const dump = JSON.stringify(await sql`select * from fabrik_setup.person`) + JSON.stringify(await sql`select * from fabrik_setup.owner_code`);
  check("the password is nowhere in fabrik_setup, and the code is spent", !dump.includes("a long chosen password") && !dump.includes("sha256"), dump);
  check("the code file is gone, and the folder holds the owner's actor file and a saved sign-in",
    !(await Deno.stat(`${FOLDER}/.fabrik-owner-code`).then(() => true, () => false)) && JSON.parse(Deno.readTextFileSync(`${FOLDER}/.fabrik-actor.json`)).auth_email === "olive@firm.example"
      && Deno.statSync(`${HOME}/.config/supabase-auth/${REF}/olive@firm.example.json`).isFile, null);
  res = await fetch(`${PROJECT_URL}/functions/v1/fabrik-setup/owner`, { method: "POST", headers: { apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify({ code, name: "Mallory", email: "mallory@example.com", password: "someone else's password" }) });
  body = await res.json();
  check("the spent code makes no other sign-in", res.status === 403 && !users.has("mallory@example.com"), body);

  // ---- 4. "done": the administrator and the scopes, then the health check ----
  ran = await run([BUILD, "run", "--url", PROJECT_URL, "--key", KEY, "--ref", REF, "first-administrator.sql"]);
  quote(ran.out + ran.err);
  check("first-administrator.sql runs through fabrik-setup", ran.status === 0 && ran.out === "first-administrator.sql: done\n", ran.err);
  const scopes = await sql`select code, display_name, description from fabrik.scope where not starts_with(code, 'sessions_') order by code`;
  const step2 = read("bootstrap.sql").split("-- Step 2.")[1].split("-- 2b.")[0];
  const expected = [...step2.matchAll(/\('([a-z_]+)', '([^']+)', '((?:[^']|'')+)'\)/g)].map(m => ({ code: m[1], display_name: m[2], description: m[3].replaceAll("''", "'") }))
    .sort((x, y) => (x.code < y.code ? -1 : 1));
  check("the three scopes are bootstrap.sql's step 2's, word for word", expected.length === 3 && JSON.stringify(scopes) === JSON.stringify(expected), { scopes, expected });
  const actors = await sql`select display_name, authority_class, auth_user_id from fabrik.actor order by display_name`;
  const records = await sql`select count(*)::int as n from fabrik.record`;
  check("the owner is fabrik's one actor, its administrator, and first-administrator.sql saves no record",
    JSON.stringify(actors.map((a: { display_name: string; authority_class: string; auth_user_id: string | null }) => [a.display_name, a.authority_class, a.auth_user_id === null]))
      === JSON.stringify([["Olive Owner", "administrator", false]]) && records[0].n === 0, { actors, records });
  const [health] = await executeSql(read("health.sql"));
  quote(JSON.stringify(health));
  check("health.sql passes: the scopes with the owner's sessions scope, the administrator, the Data API, the schedule and file search's buckets", health.ok === true, health);

  // As the owner, with the fabrik command, in the setup folder.
  await executeSql("alter role authenticator reset pgrst.db_schemas; notify pgrst, 'reload config';");
  ran = await run([FABRIK, "fabrik_get_scopes"]);
  check("without data-api.sql's setting, the Data API refuses fabrik", ran.status === 1 && /PGRST106|Invalid schema/.test(ran.out + ran.err), ran.out + ran.err);
  await executeSql(read("data-api.sql"));
  ran = await run([FABRIK, "fabrik_get_scopes"]);
  const scopeList = ran.status === 0 ? (JSON.parse(ran.out).items ?? JSON.parse(ran.out)) as { code: string; name?: string; display_name?: string }[] : [];
  const codes = scopeList.map(x => x.code).sort();
  const ownSessions = `sessions_${String(person.auth_user_id).replaceAll("-", "")}`;
  quote(JSON.stringify(scopeList.map(x => [x.code, x.name ?? x.display_name])));
  check("the owner, signed in, lists exactly General, Reference, Administration and the owner's own sessions scope with fabrik_get_scopes",
    JSON.stringify(codes) === JSON.stringify(["administration", "general", "reference", ownSessions].sort()), ran.out + ran.err);
  ran = await run([FABRIK, "call_function", "name=file-search", "body.query=setup check"]);
  quote(ran.out.slice(0, 300));
  check("one search through the file-search hosted function answers, as the owner", ran.status === 0 && Array.isArray(JSON.parse(ran.out).hits), ran.out + ran.err);
  ran = await run([FABRIK, "fabrik_add_record", "p_scope=administration", "p_kind=evidence", "p_title=fabrik setup",
    "p_reason=The record of who set the project up, and how.",
    'p_fields={"summary":"Olive Owner set up fabrik: fabrik and file search built, the functions deployed, the three scopes and the Data API set; the health check passed.","source_reference":"The setup skill","source_date":"2026-10-25","standing":"observed","limitations":"Written down during setup."}']);
  check("the setup record is saved in Administration as the owner, with no file on the owner's computer", ran.status === 0 && Boolean(JSON.parse(ran.out).record_id), ran.out + ran.err);
  s = await state();
  check("state.sql reads the project as finished, with the setup record", s.setup_finished === true && s.records === 1, s);

  // fabrik setup for a second folder of the owner's, as they run it at a terminal: the real sign-in against this project,
  // with a stand-in for Claude Code's claude command, which only records the plugin install.
  const bin = `${WORK}/bin`, second = `${HOME}/fabrik-second`;
  await Deno.mkdir(bin, { recursive: true });
  await Deno.writeTextFile(`${bin}/claude`, `#!/bin/sh
echo "$@" >> "${bin}/claude.log"
case "$*" in
  "plugin marketplace list --json") echo '[{"name":"fabrik","source":"github","repo":"Kinetik-Infotech/fabrik"}]' ;;
  "plugin list --json") echo "[]" ;;
  "plugin install fabrik@fabrik") echo "✔ Successfully installed plugin: fabrik@fabrik (scope: user)" ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`);
  await Deno.chmod(`${bin}/claude`, 0o755);
  const setupOut = await new Deno.Command("python3", { args: [`${REPO}/test/stand-in/pty-answer.py`, JSON.stringify([REF, "a long chosen password"]), "node", FABRIK, "setup", "--folder", second, "--email", "olive@firm.example", "--url", PROJECT_URL, "--key", KEY],
    cwd: HOME, env: { HOME, USERPROFILE: HOME, PATH: `${bin}:${Deno.env.get("PATH")}` }, stdout: "piped", stderr: "piped" }).output();
  const setupText = decoder.decode(setupOut.stdout) + decoder.decode(setupOut.stderr);
  quote(setupText);
  check("fabrik setup makes the folder for the fabrik:assistant agent, installs fabrik@fabrik and signs the owner in there",
    setupOut.code === 0 && JSON.parse(Deno.readTextFileSync(`${second}/.claude/settings.json`)).agent === "fabrik:assistant"
      && Deno.readTextFileSync(`${bin}/claude.log`).includes("plugin install fabrik@fabrik")
      && JSON.parse(Deno.readTextFileSync(`${second}/.fabrik-actor.json`)).auth_email === "olive@firm.example"
      && setupText.trimEnd().endsWith(`Done. Start a new Code session on ${second}, and type: who am I?`), setupText);
  const who = await new Deno.Command("node", { args: [FABRIK, "whoami"], cwd: second, env: { HOME, USERPROFILE: HOME }, stdout: "piped", stderr: "piped" }).output();
  const whoText = decoder.decode(who.stdout) + decoder.decode(who.stderr);
  quote(whoText.slice(0, 300));
  check("whoami in the folder setup made answers as the owner, on this project", who.code === 0 && whoText.includes("olive@firm.example") && whoText.includes(REF), whoText);

  // ---- 4b. A signed upgrade, applied through fabrik-upgrade ----
  // The upgrade is a file in an upgrades/ folder, signed by sign-upgrade.mjs with the throwaway key. The owner, an
  // administrator, applies it with the fabrik command; a signed-in person who is no administrator, and a file with one
  // byte changed after signing, are refused.
  // It is numbered one past fabrik's newest upgrade, and before it the ledger holds every upgrade in setup/upgrades.
  await Deno.mkdir(`${WORK}/upgrades`, { recursive: true });
  const shipped = [...Deno.readDirSync(new URL("../../setup/upgrades/", import.meta.url))]
    .map((e) => e.name).filter((n) => /^\d{4}-.+\.sql$/.test(n)).map((n) => n.replace(/\.sql$/, "")).sort();
  const CHECK_ID = `${String(Number(shipped.at(-1)!.slice(0, 4)) + 1).padStart(4, "0")}-stand-in-check`;
  const upgradeFile = `${WORK}/upgrades/${CHECK_ID}.sql`;
  await Deno.writeTextFile(upgradeFile, `-- ${CHECK_ID}
-- base: new
create table fabrik_private.stand_in_check (note text not null);
insert into fabrik_private.stand_in_check(note) values ('applied by fabrik-upgrade');
insert into fabrik_private.schema_upgrade(id) values ('${CHECK_ID}') on conflict (id) do nothing;
`);
  const signedFile = `${FOLDER}/${CHECK_ID}.signed.json`;
  ran = await run([SIGN, upgradeFile, "--key", KEY_FILE, "--out", signedFile]);
  must("sign-upgrade.mjs signs the upgrade into a request file", ran.status === 0, ran.err);
  const request = JSON.parse(Deno.readTextFileSync(signedFile));
  const applied = async () => (await sql`select id from fabrik_private.schema_upgrade order by id`).map((r: { id: string }) => r.id);
  const hasCheckTable = async () => (await sql`select to_regclass('fabrik_private.stand_in_check') is not null as there`)[0].there;
  check(`before it, the ledger holds every upgrade in setup/upgrades, ${shipped[0]} to ${shipped.at(-1)}, and the upgrade's table is not there`,
    (await applied()).join(",") === shipped.join(",") && !await hasCheckTable(), await applied());

  // A signed-in person who is no administrator: an enabled restricted human, made as the owner's approval makes one.
  const sam = { id: crypto.randomUUID(), email: "sam@firm.example", password: "sam's chosen password" };
  await sql`insert into auth.users(id, email, created_at) values (${sam.id}, ${sam.email}, now())`;
  users.set(sam.email, sam);
  const [{ actor_id: ownerActor }] = await sql`select actor_id from fabrik.actor where authority_class = 'administrator'`;
  // deno-lint-ignore no-explicit-any
  await sql.begin(async (tx: any) => {
    await tx`select set_config('fabrik.provisioning_actor', ${ownerActor}, true)`;
    await tx`insert into fabrik.actor(actor_id, auth_user_id, display_name, actor_kind, accountable_human_id, authority_class, enabled)
      values (${sam.id}, ${sam.id}, 'Sam Restricted', 'human', ${sam.id}, 'restricted', true)`;
  });
  const samToken = issue(sam).access_token;
  res = await fetch(`${PROJECT_URL}/functions/v1/fabrik-upgrade`, { method: "POST", headers: { Authorization: `Bearer ${samToken}`, apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(request) });
  body = await res.json();
  quote(`${res.status} ${JSON.stringify(body)}`);
  check("a signed-in person who is not an administrator is refused, and nothing is applied",
    res.status === 403 && body.ok === false && body.problem === "Only an administrator applies an upgrade." && !(await applied()).includes(CHECK_ID) && !await hasCheckTable(), { status: res.status, body });

  // An administrator who is disabled: the same request, from a signed-in administrator whose actor is turned off.
  const dana = { id: crypto.randomUUID(), email: "dana@firm.example", password: "dana's chosen password" };
  await sql`insert into auth.users(id, email, created_at) values (${dana.id}, ${dana.email}, now())`;
  users.set(dana.email, dana);
  // deno-lint-ignore no-explicit-any
  await sql.begin(async (tx: any) => {
    await tx`select set_config('fabrik.provisioning_actor', ${ownerActor}, true)`;
    await tx`insert into fabrik.actor(actor_id, auth_user_id, display_name, actor_kind, accountable_human_id, authority_class, enabled)
      values (${dana.id}, ${dana.id}, 'Dana Disabled', 'human', ${dana.id}, 'administrator', false)`;
  });
  const [danaRow] = await sql`select authority_class, enabled from fabrik.actor where actor_id = ${dana.id}`;
  must("Dana is an administrator whose actor is disabled", danaRow?.authority_class === "administrator" && danaRow.enabled === false, danaRow);
  const ledgerBefore = (await applied()).join(",");
  res = await fetch(`${PROJECT_URL}/functions/v1/fabrik-upgrade`, { method: "POST", headers: { Authorization: `Bearer ${issue(dana).access_token}`, apikey: KEY, "Content-Type": "application/json" }, body: JSON.stringify(request) });
  body = await res.json();
  quote(`${res.status} ${JSON.stringify(body)}`);
  // fabrik's own actor lookup refuses a disabled actor, so the gate stops Dana there, before the administrator check.
  check("a signed-in administrator whose actor is disabled is refused, and the ledger is unchanged",
    res.status === 403 && body.ok === false && body.problem === "Your sign-in has no enabled actor in this fabrik, so it applies no upgrade." && (await applied()).join(",") === ledgerBefore && !await hasCheckTable(), { status: res.status, body });

  // One byte changed after signing.
  const changed = { ...request, sql: request.sql.replace("applied by fabrik-upgrade", "applied by fabrik-upgradf") };
  const changedFile = `${FOLDER}/${CHECK_ID}.changed.json`;
  await Deno.writeTextFile(changedFile, JSON.stringify(changed));
  must("the changed file differs from the signed one by one byte", changed.sql.length === request.sql.length && changed.sql !== request.sql, "");
  ran = await run([FABRIK, "upgrade", changedFile]);
  quote(ran.out + ran.err);
  check("the owner sending a file with one byte changed is refused for its signature, and nothing is applied",
    ran.status === 1 && ran.err.includes("signature does not match the upgrade key") && !(await applied()).includes(CHECK_ID) && !await hasCheckTable(), ran.out + ran.err);

  // The owner, an administrator, applies the signed file.
  ran = await run([FABRIK, "upgrade", signedFile]);
  quote(ran.out + ran.err);
  const done = ran.status === 0 ? JSON.parse(ran.out) : {};
  check("the owner, an administrator, applies the signed file with fabrik upgrade, and it is applied: the ledger holds it and its table is there",
    ran.status === 0 && done.upgrade === CHECK_ID && done.ledger.includes(CHECK_ID) && (await applied()).includes(CHECK_ID) && await hasCheckTable()
      && (await sql`select note from fabrik_private.stand_in_check`)[0].note === "applied by fabrik-upgrade", { out: ran.out, err: ran.err });
  ran = await run([FABRIK, "upgrade", signedFile]);
  check("the same file sent again is refused as already applied", ran.status === 1 && ran.err.includes("already applied"), ran.out + ran.err);

  // The ledgers, as fabrik update reads them: given to the administrator, refused to anyone else.
  ran = await run([FABRIK, "call_function", "name=fabrik-upgrade", 'body={"list":true}']);
  const ledgersAnswer = ran.status === 0 ? JSON.parse(ran.out) : {};
  res = await fetch(`${PROJECT_URL}/functions/v1/fabrik-upgrade`, { method: "POST", headers: { Authorization: `Bearer ${samToken}`, apikey: KEY, "Content-Type": "application/json" }, body: '{"list":true}' });
  body = await res.json();
  check("fabrik-upgrade given { list: true } answers the administrator each series' ledger, and refuses anyone else",
    ledgersAnswer.ok === true && JSON.stringify(ledgersAnswer.ledgers?.fabrik) === JSON.stringify(await applied())
      && JSON.stringify(ledgersAnswer.ledgers?.file_search) === JSON.stringify([...Deno.readDirSync(new URL("../../setup/file-search-upgrades/", import.meta.url))]
        .map((e) => e.name).filter((n) => n.endsWith(".sql")).map((n) => n.replace(/\.sql$/, "")).sort()) && res.status === 403 && body.problem === "Only an administrator applies an upgrade.",
    { ledgersAnswer, sam: body });

  // ---- 5. reset.sql once fabrik holds records ----
  const before = (await state()).records;
  ran = await run([BUILD, "approve", "--ref", REF, "--folder", FOLDER, "--reset"]);
  await executeSql(ran.out);
  ran = await run([BUILD, "run", "--url", PROJECT_URL, "--key", KEY, "--ref", REF, "reset.sql"]);
  quote(ran.err);
  s = await state();
  check("reset.sql refuses once fabrik holds a record, and changes nothing", ran.status === 1 && ran.err.includes(`fabrik holds ${before} record(s), so nothing was reset`) && s.fabrik_built && s.setup_finished && s.records === before, { err: ran.err, s });

  // ---- 6. fabrik setup --owner: the whole setup in one run, through Supabase's Management API ----
  // The flow database goes, with fabrik's roles, which a cluster holds once, and the stand-in serves the owner database,
  // a new project. The real command runs at a terminal of its own, in a home of the owner's own, with a stand-in for
  // the claude command that only records the plugin install, answering as the owner. fabrik-setup, file search and
  // the rest are served from the files the command deployed.
  {
  await sql.end();
  {
    const admin = postgres(ADMIN_DB, { max: 1, prepare: false, onnotice() {} });
    await admin.unsafe("drop database flow with (force)");
    await admin.unsafe("drop role fabrik_owner, fabrik_identity, fabrik_writer, fabrik_reader");
    await admin.end();
  }
  const OWNER_DB = Deno.env.get("STAND_IN_OWNER_DB")!;
  sql = postgres(OWNER_DB, { max: 2, prepare: false, onnotice() {} });
  Deno.env.set("SUPABASE_DB_URL", OWNER_DB);
  users.clear(); tokens.clear(); refresh.clear();
  owning = true;
  const ownerHome = `${WORK}/owner`;
  const ownerFolder = `${ownerHome}/fabrik`;
  const ownerBin = `${WORK}/owner-bin`;
  await Deno.mkdir(ownerBin, { recursive: true });
  await Deno.writeTextFile(`${ownerBin}/claude`, `#!/bin/sh
printf '%s\n' "$*" >> "${ownerBin}/claude-args.log"
env >> "${ownerBin}/claude-env.log"
case "$*" in
  "plugin marketplace list --json") if [ -f "${ownerBin}/added" ]; then echo '[{"name":"fabrik","source":"github","repo":"Kinetik-Infotech/fabrik"}]'; else echo "[]"; fi ;;
  "plugin marketplace add Kinetik-Infotech/fabrik") touch "${ownerBin}/added"; echo "✔ Successfully added marketplace: fabrik" ;;
  "plugin list --json") echo "[]" ;;
  "plugin install fabrik@fabrik") echo "✔ Successfully installed plugin: fabrik@fabrik (scope: user)" ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`, { mode: 0o755 });
  // A stand-in for Cloudflare's Wrangler: no one signed in until the browser sign-in, then one account and its Pages
  // projects, each call logged with the sign-in folder it ran under.
  await Deno.writeTextFile(`${ownerBin}/wrangler.mjs`, `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const file = "${ownerBin}/wrangler-state.json";
const s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { signedIn: false, projects: [] };
const args = process.argv.slice(2), cmd = args.join(" ");
appendFileSync("${ownerBin}/wrangler.log", JSON.stringify({ args, xdg: process.env.XDG_CONFIG_HOME }) + "\\n");
const save = () => writeFileSync(file, JSON.stringify(s));
if (cmd === "whoami --json") { console.log(JSON.stringify(s.signedIn ? { loggedIn: true, email: "olive@owner.example", accounts: [{ id: "acc-1", name: "Olive's Account" }] } : { loggedIn: false })); process.exit(s.signedIn ? 0 : 1); }
else if (cmd === "login --scopes ${SCOPES.join(" ")}") { s.signedIn = true; save(); console.log("Successfully logged in."); }
else if (cmd === "pages project list --json") console.log(JSON.stringify(s.projects.map(p => ({ "Project Name": p, "Project Domains": p + "-3x7.pages.dev" }))));
else if (args.slice(0, 3).join(" ") === "pages project create") { s.projects.push(args[3]); save(); }
else if (args.slice(0, 2).join(" ") === "pages deploy") { s.deployed = args[2]; save(); console.log("Deployment complete!"); }
else { console.error("unexpected: " + cmd); process.exit(9); }
`);
  const ownerEnvironment = { HOME: ownerHome, USERPROFILE: ownerHome, PATH: `${ownerBin}:${Deno.env.get("PATH")}`,
    FABRIK_TEST_MANAGEMENT_API: PROJECT_URL, FABRIK_TEST_HEALTH_WAIT_MS: "1500", FABRIK_TEST_WRANGLER: `${ownerBin}/wrangler.mjs` };
  await Deno.mkdir(ownerHome, { recursive: true });
  const OWNER_COMMAND = ["node", FABRIK, "setup", "--owner", "--folder", ownerFolder];
  const ownerOutputs: string[] = [];
  const ownerSetup = async (answers: string[], early = "") => {
    const out = await new Deno.Command("python3", { args: [`${REPO}/test/stand-in/pty-answer.py`, JSON.stringify(answers), ...OWNER_COMMAND],
      cwd: ownerHome, env: early ? { ...ownerEnvironment, PTY_EARLY: early } : ownerEnvironment, stdout: "piped", stderr: "piped" }).output();
    const shown = decoder.decode(out.stdout) + decoder.decode(out.stderr);
    ownerOutputs.push(shown);
    return { status: out.code, out: shown };
  };
  const projectFile = `${ownerFolder}/.fabrik-setup-project.json`;
  const readProject = async () => JSON.parse(await Deno.readTextFile(projectFile).catch(() => "null"));
  const PASSWORD = "olive's own chosen password";
  const PAGES = `https://fabrik-sign-in-${OWNER_REF}-3x7.pages.dev`;
  const inOrder = (out: string, stages: string[]) => {
    const lines = out.split("\n");
    const at = stages.map(line => lines.indexOf(line));
    return at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1])) && stages.every(line => lines.filter(l => l === line).length === 1);
  };

  // A. A paid organisation, answered no: nothing is created.
  let owned = await ownerSetup([MGMT_TOKEN, "2", "Olive's fabrik", "1", "no"]);
  quote(owned.out);
  check("a paid organisation answered no: the command says the plan charges, creates nothing, keeps no project file, and exits 1",
    owned.status === 1 && owned.out.includes("Olive's paid organisation is on Supabase's pro plan, so Supabase charges for a new project there.\nType 'yes' to create the project Olive's fabrik in London: no\nNothing was created.")
      && mgmt.projects.length === 0 && await readProject() === null, { status: owned.status, projects: mgmt.projects });

  // B. A new project in the free organisation, in the region picked, that never turns healthy: exit 1, carried on next run.
  // A Left arrow is typed in the project's name, as a person fixing a typo may: it is dropped whole, not kept in the name.
  owned = await ownerSetup([MGMT_TOKEN, "1", "Olive's\u001b[D fabrik", "4"]);
  quote(owned.out);
  let kept = await readProject();
  check("a project never healthy: the project is made in the region picked, the command stops with exit 1 saying a run later carries on, and the folder keeps the project",
    owned.status === 1 && mgmt.projects.length === 1 && mgmt.projects[0].region === "eu-central-1" && mgmt.projects[0].name === "Olive's fabrik"
      && owned.out.includes("Creating your project in Frankfurt: done.\nWaiting for your project to be ready. This can take a few minutes.\nYour project was not ready within 1 minute. Run this command again later, and it carries on from here.")
      && kept?.ref === OWNER_REF && (Deno.statSync(projectFile).mode! & 0o777) === 0o600, { status: owned.status, projects: mgmt.projects, kept });

  // C. Run again, healthy, with fabrik-apps' deploy refused: it carries on with the saved project, builds fabrik, and
  // stops at the refused deploy with Supabase's reason.
  mgmt.healthy = true;
  mgmt.refuseDeploy = { slug: "fabrik-apps", message: "Function size exceeds the limit." };
  owned = await ownerSetup([MGMT_TOKEN]);
  quote(owned.out);
  mgmt.refuseDeploy = null;
  check("a second run carries on with the saved project: no organisation, project or region asked, and no second project",
    owned.out.includes("Carrying on with setup in your Supabase project Olive's fabrik.\n") && !owned.out.includes("Type its number") && !owned.out.includes("Where should")
      && mgmt.projects.length === 1 && owned.out.includes("Waiting for your project to be ready: done."), owned.out);
  check("a step Supabase refuses: one plain line with Supabase's own reason, exit 1, and every step before it kept",
    owned.status === 1 && owned.out.trimEnd().endsWith("Building fabrik: done.\nDeploying fabrik's hosted functions: failed. Supabase said: Function size exceeds the limit. Every step before it stays done. Run this command again to carry on.")
      && (await state()).fabrik_built === true, owned.out);

  // D. Run again: state.sql finds the unfinished build, the owner agrees to clear it, and setup runs to the end, with
  // the sign-in page put up through the browser sign-in to Cloudflare.
  // The email is left empty, so the one Supabase's profile gives is taken. The owner's folder holds a sign-in folder of
  // their own, which setup leaves alone.
  await Deno.mkdir(`${ownerFolder}/sign-in`, { recursive: true });
  await Deno.writeTextFile(`${ownerFolder}/sign-in/notes.md`, "Olive's own notes.\n");
  const pageDir = `${ownerHome}/.config/fabrik/sign-in/${OWNER_REF}`;
  owned = await ownerSetup([MGMT_TOKEN, "yes", "Olive Owner", "", PASSWORD, PASSWORD, "no"]);
  quote(owned.out);
  check("killed after a refused step and run again: it asks to clear the earlier attempt, then one progress line per stage, in order, ending with the summary, exit 0",
    owned.status === 0 && owned.out.includes("An earlier setup in Olive's fabrik stopped part way. Type 'yes' to clear it and set fabrik up again: yes\n")
      && inOrder(owned.out, ["Waiting for your project to be ready: done.", "Building fabrik: done.", "Deploying fabrik's hosted functions: done.", "Turning on the Data API: done.",
        "Signed in as olive@owner.example.", "Making you the administrator: done.", "Checking everything works: done.", "Saving the setup record: done.", "Signed in to Cloudflare as olive@owner.example.", `Your sign-in page: done, at ${PAGES}.`,
        "Asymmetric signing key: already done.", "OAuth server, with dynamic OAuth apps: done.", "Authorization path /oauth/consent: done.", `Site URL ${PAGES}/prod: done.`, "Public sign-up off: done.",
        "fabrik is set up in Olive's fabrik, and you are its administrator.", "Your Supabase plan is Free, which pauses a project nobody uses for a week. A paid plan keeps it running.",
        "Can you add a custom connector in Claude's Settings? Some Claude teams don't allow it. Type 'no' if you can't, or press Enter if you can: no",
        `fabrik's local connector is on in ${ownerFolder}. Open a Code session in the Claude desktop app in that folder, and fabrik's tools are there, with no connector in Claude's Settings.`,
        "fabrik reaches only that folder's Code sessions this way, not claude.ai, the phone app or Cowork."]) && !owned.out.includes("One step is left"), owned.out);
  check("an owner who can't add a custom connector has the folder's actor file say connector local, beside their sign-in",
    JSON.stringify(JSON.parse(Deno.readTextFileSync(`${ownerFolder}/.fabrik-actor.json`))) === JSON.stringify({ project_ref: OWNER_REF, auth_email: "olive@owner.example", connector: "local" }),
    Deno.readTextFileSync(`${ownerFolder}/.fabrik-actor.json`));
  check("the owner's sign-in asks their name, offers their Supabase account's email, which Enter takes, asks their password twice, and shows no password",
    /Your name: Olive Owner\nYour email \(Enter for olive@owner\.example\): \nNothing shows as you type or paste\. Do it once, then press Enter\.\nChoose a password: \nNothing shows as you type or paste\. Do it once, then press Enter\.\nThe password again: \n/.test(owned.out) && !ownerOutputs.join("").includes(PASSWORD), owned.out);
  const wranglerCalls = Deno.readTextFileSync(`${ownerBin}/wrangler.log`).trim().split("\n").map(l => JSON.parse(l));
  check("the sign-in page: its folder is made with the project's address and key, and put up under fabrik's own Cloudflare sign-in, after the browser sign-in, with nothing pasted",
    owned.out.includes("A browser window opens for Cloudflare.") && !owned.out.includes("paste the address")
      && wranglerCalls.every(c => c.xdg === `${ownerHome}/.config/fabrik/wrangler`)
      && JSON.parse(Deno.readTextFileSync(`${ownerBin}/wrangler-state.json`)).deployed === pageDir
      && Deno.readTextFileSync(`${pageDir}/prod/fabrik.js`).includes(`https://${OWNER_REF}.supabase.co`) && Deno.readTextFileSync(`${pageDir}/prod/fabrik.js`).includes(KEY), owned.out);
  check("the sign-in page's folder is fabrik's own, and a sign-in folder in the owner's folder is left as it was",
    Deno.readTextFileSync(`${ownerFolder}/sign-in/notes.md`) === "Olive's own notes.\n" && [...Deno.readDirSync(`${ownerFolder}/sign-in`)].length === 1, null);
  check("the Data API's own setting serves fabrik beside public and graphql_public",
    mgmt.postgrest.db_schema === "public, graphql_public, fabrik", mgmt.postgrest);
  const listedNow = JSON.parse((await run([BUILD, "functions"])).out) as { name: string; verify_jwt: boolean; files: { name: string; path: string }[] }[];
  const sameFiles = listedNow.every(f => { const d = mgmt.functions.get(f.name); return d && d.files.every(n => Deno.readTextFileSync(`${d.root}/functions/${f.name}/${n}`) === Deno.readTextFileSync(f.files.find(x => x.name === n)!.path)); });
  check("all seven functions are deployed, each with every file build.mjs lists, word for word, entrypoint index.ts and its verify_jwt; fabrik-apps with every file of its own",
    JSON.stringify([...mgmt.functions.values()].map(f => [f.slug, f.verify_jwt, f.entrypoint_path, f.files.join("+")]).sort())
      === JSON.stringify(listedNow.map(f => [f.name, f.verify_jwt, "index.ts", f.files.map(x => x.name).join("+")]).sort()) && sameFiles && mgmt.functions.get("fabrik-apps")!.files.length === listedNow.find(f => f.name === "fabrik-apps")!.files.length, [...mgmt.functions.keys()]);
  const [ownerHealth] = await executeSql(read("health.sql"));
  const ownerActors = await sql`select display_name, authority_class from fabrik.actor order by display_name`;
  const savedRecords = await sql`select distinct on (v.record_id) v.title, v.payload from fabrik.record_version v join fabrik.record r using (record_id) join fabrik.scope sc on sc.scope_id = r.scope_id
    where sc.code = 'administration' order by v.record_id, v.change_no desc`;
  const [runner] = await sql`select to_regnamespace('fabrik_setup') is null as dropped`;
  check("the owner is fabrik's administrator, health.sql passes, the setup record is saved in Administration, and fabrik_setup is dropped",
    JSON.stringify(ownerActors.map((a: { display_name: string; authority_class: string }) => [a.display_name, a.authority_class])) === JSON.stringify([["Olive Owner", "administrator"]])
      && ownerHealth.ok === true && savedRecords.length === 1 && savedRecords[0].title === "fabrik setup" && savedRecords[0].payload?.summary?.includes("olive@owner.example") && runner.dropped,
    { ownerActors, ownerHealth, savedRecords, runner });
  ran = await new Deno.Command("node", { args: [FABRIK, "fabrik_get_scopes"], cwd: ownerFolder, env: { HOME: ownerHome, USERPROFILE: ownerHome }, stdout: "piped", stderr: "piped" }).output()
    .then(o => ({ status: o.code, out: decoder.decode(o.stdout), err: decoder.decode(o.stderr) }));
  const ownerScopes = ran.status === 0 ? ((JSON.parse(ran.out).items ?? JSON.parse(ran.out)) as { code: string }[]).map(x => x.code) : [];
  check("the owner is signed in in the folder, and lists General, Reference and Administration there",
    JSON.parse(Deno.readTextFileSync(`${ownerFolder}/.fabrik-actor.json`)).auth_email === "olive@owner.example" && ["general", "reference", "administration"].every(c => ownerScopes.includes(c))
      && JSON.parse(Deno.readTextFileSync(`${ownerFolder}/.claude/settings.json`)).agent === "fabrik:assistant", { ownerScopes, err: ran.err });
  check("the connector's settings are made: the OAuth server with dynamic registration, /oauth/consent, and the Site URL the sign-in page's address with /prod",
    mgmt.config.site_url === `${PAGES}/prod` && mgmt.config.oauth_server_enabled === true && mgmt.config.oauth_server_allow_dynamic_registration === true
      && mgmt.config.oauth_server_authorization_path === "/oauth/consent", mgmt.config);
  check("public sign-up is off, so a stranger with the sign-in page's key cannot make an account",
    mgmt.config.disable_signup === true, mgmt.config);
  kept = await readProject();
  check(".fabrik-setup-project.json keeps the project and the sign-in page's address, for a run again", kept?.ref === OWNER_REF && kept.site === PAGES, kept);

  // The owner adds the connector after all, and takes "connector": "local" out of the folder's actor file.
  Deno.writeTextFileSync(`${ownerFolder}/.fabrik-actor.json`, JSON.stringify({ project_ref: OWNER_REF, auth_email: "olive@owner.example" }));

  // E. Run again: setup has finished, so it goes straight to the connector's settings, all already done. A token is
  // pasted before its prompt, as a person may: it is not shown, and not joined to the one pasted at the prompt.
  const EARLY = "sbp_pasted_too_soon_0000";
  const callsBefore = mgmt.calls.length;
  owned = await ownerSetup([MGMT_TOKEN], EARLY);
  quote(owned.out);
  check("a run after setup finished: setup found done, nothing built or deployed, the sign-in page not asked again, every setting already done, exit 0",
    owned.status === 0 && owned.out.includes("fabrik is already set up in Olive's fabrik.") && !owned.out.includes("Building fabrik") && !owned.out.includes("Your sign-in page")
      && !mgmt.calls.slice(callsBefore).some(c => c.path.includes("/functions/deploy")) && owned.out.includes(`Site URL ${PAGES}/prod: already done.`), owned.out);
  check("a run after setup finished does not ask for the connector as a step left, and gives its address for one not yet added",
    !owned.out.includes("One step is left") && owned.out.includes("If fabrik's connector is already in Claude, nothing more is needed.")
      && owned.out.includes(`${PROJECT_URL}/functions/v1/fabrik-apps`), owned.out);
  check("a run after setup finished leaves public sign-up off, and says it is already done",
    mgmt.config.disable_signup === true && owned.out.includes("Public sign-up off: already done."), owned.out);
  check("a token pasted before its prompt is not shown and not used: the run says so, and the token pasted at the prompt works alone",
    owned.status === 0 && !owned.out.includes(EARLY) && owned.out.includes("What was typed before this prompt was not used, and was not shown.\nNothing shows as you type or paste. Do it once, then press Enter.\nSupabase access token: "), owned.out);

  // F. A later version of the sign-in page: the kept hash differs from the page's files, so the page is put up again.
  const deploysBefore = Deno.readTextFileSync(`${ownerBin}/wrangler.log`).trim().split("\n").filter(l => JSON.parse(l).args[1] === "deploy").length;
  await Deno.writeTextFile(projectFile, JSON.stringify({ ...await readProject(), page: "0".repeat(64) }));
  owned = await ownerSetup([MGMT_TOKEN]);
  quote(owned.out);
  const deploysAfter = Deno.readTextFileSync(`${ownerBin}/wrangler.log`).trim().split("\n").filter(l => JSON.parse(l).args[1] === "deploy").length;
  check("a run whose sign-in page files differ from those last put up puts the page up again, with no Cloudflare sign-in asked, and keeps the new hash",
    owned.status === 0 && deploysAfter === deploysBefore + 1 && owned.out.includes(`Your sign-in page: done, at ${PAGES}.`) && !owned.out.includes("A browser window opens")
      && (await readProject())?.page !== "0".repeat(64), owned.out);

  // G. A later version of fabrik-apps: its kept hash differs from its files, so that function alone is deployed again.
  const callsBeforeG = mgmt.calls.length;
  const keptG = await readProject();
  await Deno.writeTextFile(projectFile, JSON.stringify({ ...keptG, functions: { ...keptG.functions, "fabrik-apps": "0".repeat(64) } }));
  owned = await ownerSetup([MGMT_TOKEN]);
  quote(owned.out);
  const deployedG = mgmt.calls.slice(callsBeforeG).filter(c => c.path.includes("/functions/deploy")).map(c => new URL(`http://x${c.path}`).searchParams.get("slug"));
  check("a run whose fabrik-apps files differ from those last deployed deploys fabrik-apps alone, says so, and keeps its new hash",
    owned.status === 0 && JSON.stringify(deployedG) === JSON.stringify(["fabrik-apps"]) && owned.out.includes("Updating fabrik's hosted functions: done, fabrik-apps.")
      && (await readProject())?.functions?.["fabrik-apps"] === keptG.functions["fabrik-apps"], { deployedG, out: owned.out });

  // H. fabrik update, run in the owner's folder as the owner: a changed fabrik-apps is found, then deployed from this
  // computer's files with the token typed at the prompt, and a check after it finds nothing behind.
  const update = async (flag: string, answers: string[] = []) => {
    const out = await new Deno.Command("python3", { args: [`${REPO}/test/stand-in/pty-answer.py`, JSON.stringify(answers), "node", FABRIK, "update", flag],
      cwd: ownerFolder, env: ownerEnvironment, stdout: "piped", stderr: "piped" }).output();
    const shown = decoder.decode(out.stdout) + decoder.decode(out.stderr);
    ownerOutputs.push(shown);
    return { status: out.code, out: shown };
  };
  const keptH = await readProject();
  await Deno.writeTextFile(projectFile, JSON.stringify({ ...keptH, functions: { ...keptH.functions, "fabrik-apps": "0".repeat(64) } }));
  const json = (text: string) => { try { return JSON.parse(text.slice(text.indexOf("{"))); } catch { return null; } };
  const before = json((await update("--check")).out);
  check("fabrik update --check in the owner's folder lists fabrik-apps as changed and no upgrade as missing",
    before?.ok === true && before.behind === true && JSON.stringify(before.functions) === '["fabrik-apps"]' && before.upgrades?.length === 0, before);
  const callsBeforeH = mgmt.calls.length;
  const applied = await update("--apply", [MGMT_TOKEN]);
  quote(applied.out);
  const deployedH = mgmt.calls.slice(callsBeforeH).filter(c => c.path.includes("/functions/deploy")).map(c => new URL(`http://x${c.path}`).searchParams.get("slug"));
  const after = json((await update("--check")).out);
  check("fabrik update --apply asks for the token, deploys fabrik-apps alone, records it, and the check after it finds nothing behind",
    applied.status === 0 && JSON.stringify(deployedH) === '["fabrik-apps"]' && applied.out.includes("Deployed fabrik-apps.")
      && applied.out.includes("fabrik is up to date.") && (await readProject())?.functions?.["fabrik-apps"] === keptH.functions["fabrik-apps"]
      && after?.behind === false, { deployedH, out: applied.out, after });

  // The token and the database password the command made, in no output, file, argument or environment.
  const filesWith: string[] = [];
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isSymlink) continue;
      if (e.isDirectory) await walk(p);
      else if (e.isFile) { const text = await Deno.readTextFile(p).catch(() => ""); for (const secret of [MGMT_TOKEN, ...mgmt.dbPasses]) if (text.includes(secret)) filesWith.push(p); }
    }
  };
  await walk(ownerHome);
  await walk(ownerBin);
  const everyOutput = ownerOutputs.join("\n");
  check("the token and the database password are in no output, no file, no argument and no environment, and reached the Management API only in its Authorization header",
    filesWith.length === 0 && ![MGMT_TOKEN, ...mgmt.dbPasses].some(x => everyOutput.includes(x) || OWNER_COMMAND.join(" ").includes(x) || JSON.stringify(ownerEnvironment).includes(x))
      && mgmt.leaks.length === 0 && mgmt.dbPasses.length === 1 && mgmt.dbPasses[0].length >= 32
      && (await Deno.readTextFile(`${ownerBin}/claude-args.log`).catch(() => "")).includes("plugin install fabrik@fabrik"), { filesWith, leaks: mgmt.leaks });
  }
} finally {
  await sql.end();
  await server.shutdown();
  await Deno.remove(WORK, { recursive: true }).catch(() => {});
}

if (failed) { console.log(`FAIL - ${failed} setup flow check(s) failed`); Deno.exit(1); }
console.log("PASS: the setup flow");
Deno.exit(0);
