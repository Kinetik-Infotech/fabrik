// The maxy import, driven as the owner runs it: `node fabrik.mjs import maxy <folder>` against a small stand-in for
// Supabase's Auth, Data API and Storage that makes every call in the stand-in database, as the signed-in owner, under
// fabrik's own grants and storage policies. The export is written by maxy-export.mjs's own exportAccount, from a stand-in
// for Neo4j, so the two programs cannot drift apart: 12 nodes across 5 labels, one trashed and one carrying magicToken
// and sliceToken, an AdminUser node, 13 relationships of 5 types, one to the AdminUser, one to another account's node, a
// duplicate and a type whose code clashes, and an account folder with a 6.5 MB file, which goes by the resumable upload,
// a system file and dot-named configuration. The first run loads it and its report gives each label's and type's
// numbers; a second run loads nothing; a file over the project's size limit is left out; an export with a label the map
// does not name, and one changed after it was written, are refused before anything is saved. run.sh runs it.
import postgres from "npm:postgres@3.4.9";

const DB = Deno.env.get("STAND_IN_DB")!;
const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const FABRIK = `${REPO}/plugins/fabrik/cli/fabrik.mjs`;
const REF = "standinmaxyimport000";
const KEY = "sb_publishable_maxyimport";
const EMAIL = "owner@firm.example";
const WORK = await Deno.makeTempDir({ prefix: "fabrik-maxy-import-" });
const HOME = `${WORK}/home`;
const decoder = new TextDecoder();
const sql = postgres(DB, { max: 4, prepare: false, onnotice() {} });

let failed = 0;
function check(what: string, ok: boolean, seen: unknown) {
  console.log(`${ok ? "ok" : "FAIL"} - ${what}${ok ? "" : `: ${typeof seen === "string" ? seen : JSON.stringify(seen)}`}`);
  if (!ok) failed++;
}
function quote(out: string) { for (const line of out.trimEnd().split("\n")) console.log(`    | ${line}`); }

// ---- The owner, General and Reference, as first-administrator.sql makes them ----
const owner = crypto.randomUUID();
await sql`insert into auth.users(id, email, created_at) values (${owner}, ${EMAIL}, now())`;
const [{ admin }] = await sql`select fabrik_private.provision_first_administrator(${owner}::uuid, 'Olive Owner') as admin`;
await sql`insert into fabrik.scope(code, display_name, description, created_by) values
  ('general', 'General', 'Day-to-day records and files.', ${admin}), ('reference', 'Reference', 'The glossary.', ${admin})`;

// ---- Supabase's Auth, Data API and Storage, as far as the import uses them ----
const json = (body: unknown, status = 200) => Response.json(body, { status });
const tokens = new Map<string, string>();
// deno-lint-ignore no-explicit-any
const asOwner = (sub: string, fn: (tx: any) => Promise<any>) => sql.begin(async (tx: any) => {
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub, role: "authenticated" })}, true)`;
  await tx`set local role authenticated`;
  return await fn(tx);
});
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
    params.push(v === null ? null : type === "jsonb" ? v : typeof v === "object" ? JSON.stringify(v) : typeof v === "boolean" ? v : String(v));
    return `${k} => $${params.length}::${type}`;
  });
  return { query: `select to_jsonb(fabrik.${fn}(${parts.join(", ")})) as r`, params };
}
let calls = 0;
// The files Storage holds, by bucket and path, and the resumable uploads under way. The stand-in project's file size
// limit is 10 MB; Supabase Storage takes a resumable upload's parts at exactly 6 MB, but for the last.
const stored = new Map<string, Uint8Array>();
const uploads = new Map<string, { bucket: string; name: string; length: number; parts: Uint8Array[]; offset: number; sub: string }>();
const LIMIT = 10 * 1024 * 1024, PART = 6 * 1024 * 1024;
const tus = { "Tus-Resumable": "1.0.0" };
async function keep(sub: string, bucket: string, name: string, body: Uint8Array, type: string | null) {
  try {
    await asOwner(sub, tx => tx`insert into storage.objects(bucket_id, name, owner_id, metadata) values (${bucket}, ${name}, ${sub}, ${tx.json({ size: body.length, mimetype: type })})`);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "23505") return json({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }, 400);
    if (code === "42501") return json({ statusCode: "403", error: "Unauthorized", message: "new row violates row-level security policy" }, 400);
    throw err;
  }
  stored.set(`${bucket}/${name}`, body);
  return null;
}
const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, async (req) => {
  const url = new URL(req.url), path = decodeURIComponent(url.pathname);
  if (req.headers.get("apikey") !== KEY) return json({ message: "Invalid API key" }, 401);
  try {
    if (req.method === "POST" && path === "/auth/v1/token") {
      const body = await req.json();
      if (body.refresh_token !== "rt-owner") return json({ error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" }, 400);
      const access = `at-${crypto.randomUUID()}`;
      tokens.set(access, owner);
      return json({ access_token: access, refresh_token: "rt-owner", token_type: "bearer", expires_in: 3600, user: { id: owner, email: EMAIL } });
    }
    const sub = tokens.get((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));
    if (!sub) return json({ message: "Invalid JWT" }, 401);
    let m: RegExpMatchArray | null;
    if (req.method === "POST" && (m = path.match(/^\/rest\/v1\/rpc\/(fabrik_[a-z_]+)$/))) {
      calls++;
      const call = await rpcCall(m[1], await req.json());
      if (!call) return json({ code: "PGRST202", message: `Could not find the function fabrik.${m[1]}` }, 404);
      const [{ r }] = await asOwner(sub, tx => tx.unsafe(call.query, call.params));
      return json(r);
    }
    // Storage's upload, with the bodies Supabase Storage gives for a missing bucket, a duplicate and a policy's refusal.
    if (req.method === "POST" && (m = path.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/)) && m[1] !== "list") {
      const [bucket, name] = [m[1], m[2]];
      const body = new Uint8Array(await req.arrayBuffer());
      if (!(await sql`select 1 from storage.buckets where id = ${bucket}`).length) return json({ statusCode: "404", error: "Bucket not found", message: "Bucket not found" }, 400);
      if (body.length > LIMIT) return json({ statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" }, 400);
      return (await keep(sub, bucket, name, body, req.headers.get("content-type"))) ?? json({ Key: `${bucket}/${name}`, Id: crypto.randomUUID() });
    }
    // Storage's resumable (TUS) upload: made with its length and metadata, then sent in parts.
    if (req.method === "POST" && path === "/storage/v1/upload/resumable") {
      const meta = Object.fromEntries((req.headers.get("upload-metadata") ?? "").split(",").map(p => { const [k, v] = p.split(" "); return [k, atob(v ?? "")]; }));
      const length = Number(req.headers.get("upload-length"));
      if (!(await sql`select 1 from storage.buckets where id = ${meta.bucketName}`).length) return json({ statusCode: "404", error: "Bucket not found", message: "Bucket not found" }, 400);
      if (length > LIMIT) return json({ statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" }, 413);
      if ((await sql`select 1 from storage.objects where bucket_id = ${meta.bucketName} and name = ${meta.objectName}`).length)
        return json({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }, 409);
      const upload = crypto.randomUUID();
      uploads.set(upload, { bucket: meta.bucketName, name: meta.objectName, length, parts: [], offset: 0, sub });
      return new Response(null, { status: 201, headers: { ...tus, Location: `${PROJECT_URL}/storage/v1/upload/resumable/${upload}` } });
    }
    if (req.method === "PATCH" && (m = path.match(/^\/storage\/v1\/upload\/resumable\/([0-9a-f-]+)$/))) {
      const u = uploads.get(m[1]);
      if (!u || u.sub !== sub) return json({ message: "Upload not found" }, 404);
      if (Number(req.headers.get("upload-offset")) !== u.offset || req.headers.get("content-type") !== "application/offset+octet-stream") return json({ message: "Offset or type wrong" }, 409);
      const part = new Uint8Array(await req.arrayBuffer());
      if (part.length !== PART && u.offset + part.length !== u.length) return json({ message: "A part is 6 MB but the last" }, 400);
      u.parts.push(part); u.offset += part.length;
      if (u.offset === u.length) {
        const whole = new Uint8Array(u.length);
        let at = 0;
        for (const p of u.parts) { whole.set(p, at); at += p.length; }
        uploads.delete(m[1]);
        const refused = await keep(sub, u.bucket, u.name, whole, "application/octet-stream");
        if (refused) return refused;
      }
      return new Response(null, { status: 204, headers: { ...tus, "Upload-Offset": String(u.offset) } });
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return json({ code: e.code, message: e.message }, e.code === "42501" ? 403 : 400);
  }
  return json({ message: `The stand-in has no ${req.method} ${path}` }, 404);
});
const PROJECT_URL = `http://127.0.0.1:${server.addr.port}`;

// The owner's saved sign-in, as sign-in.mjs writes it.
await Deno.mkdir(`${HOME}/.config/supabase-auth/${REF}`, { recursive: true, mode: 0o700 });
await Deno.chmod(`${HOME}/.config/supabase-auth`, 0o700);
await Deno.writeTextFile(`${HOME}/.config/supabase-auth/${REF}/${EMAIL}.json`,
  JSON.stringify({ version: 1, url: PROJECT_URL, publishableKey: KEY, email: EMAIL, refreshToken: "rt-owner" }), { mode: 0o600 });

// ---- The export, written by maxy-export.mjs's own exportAccount from a stand-in for Neo4j ----
// Values as the Neo4j driver gives them: an Integer, a temporal or a point carries its marker, as encodeValue reads it.
// deno-lint-ignore no-explicit-any
const { exportAccount } = await import(`${REPO}/scripts/maxy-export.mjs`) as any;
const int = (v: number) => ({ __isInteger__: true, toString: () => String(v) });
const temporal = (marker: string, text: string) => ({ [marker]: true, toString: () => text });
const id = (n: number | string) => `4:acct-test:${n}`;
type Source = { id: string; labels: string[]; props: Record<string, unknown> };
const node = (n: number, labels: string[], props: Record<string, unknown>): Source => ({ id: id(n), labels, props: { accountId: "acct-test", ...props } });
const NODES: Source[] = [
  node(1, ["Person"], { name: "Ann Archer", createdAt: temporal("__isDateTime__", "2026-03-01T09:00:00Z"), compiledTruthPublic: "Ann is private." }),
  node(2, ["Person"], { name: "Ben Baker", age: int(41), magicToken: "mt-SECRET-1", slice_token: "st-SECRET-2", "API-KEY": "ak-SECRET-3" }),
  node(3, ["Person"], { name: "Cat Cole", born: temporal("__isDate__", "1990-05-06") }),
  node(4, ["Organization"], { name: "Acme Bakery", compiledTruthPublic: "Acme bakes bread every morning from 6am.", location: { __isPoint__: true, srid: int(4326), x: -0.1, y: 51.5 } }),
  node(5, ["Organization"], { name: "Bread Co", score: NaN }),
  node(6, ["Project"], { name: "New shop", description: "Open the second shop.", compiledTruthPublic: "A second shop opens in spring." }),
  node(7, ["Project", "Trashed"], { title: "Old shop refit" }),
  node(8, ["Task"], { name: "Sign the lease", due: temporal("__isDate__", "2026-12-01"), took: temporal("__isDuration__", "P1DT2H") }),
  node(9, ["Task"], { name: "Hire a baker", at: temporal("__isLocalTime__", "09:30:00") }),
  node(10, ["Task"], {}),
  node(11, ["Decision"], { name: "Take the corner unit", rationale: "Most passing trade.", tags: ["shop", "lease"] }),
  node(12, ["Decision"], { name: "Keep Sunday hours", decision: "Open 8 to 2." }),
  node(13, ["AdminUser"], { name: "Device admin" }),
];
const rel = (n: number, type: string, start: number | string, end: number | string, props: Record<string, unknown> = {}) =>
  ({ id: `5:acct-test:${n}`, type, start: id(start), end: id(end), props });
const RELS = [
  rel(1, "WORKS_AT", 1, 4, { since: int(2019) }),
  rel(2, "WORKS_AT", 2, 4, { apiKey: "ak-SECRET-4" }),
  rel(3, "WORKS_AT", 3, 5),
  rel(4, "HAS_TASK", 6, 8),
  rel(5, "HAS_TASK", 6, 9),
  rel(6, "HAS_TASK", 7, 10),
  rel(7, "HAS-2-OWNERS", 4, 1),
  rel(8, "HAS-2-OWNERS", 5, 3),
  rel(9, "ADMIN_OF", 13, 4),
  // To a node of another account, which the export counts and leaves out.
  rel(10, "HAS-2-OWNERS", 6, "other"),
  // A second WORKS_AT between Ann and Acme, merged into the first link's note; a third whose properties do not fit in it;
  // and HAS-TASK, whose derived code has_task is HAS_TASK's, so it takes has_task_two.
  rel(11, "WORKS_AT", 1, 4, { role: "baker", since: int(2021) }),
  rel(12, "WORKS_AT", 1, 4, { history: "x".repeat(4100) }),
  rel(13, "HAS-TASK", 6, 9, { order: int(1) }),
];
/** The three reads exportAccount makes, answered from the lists as Neo4j answers its queries: by account, in elementId order. */
function sourceOf(nodes: Source[], rels: typeof RELS) {
  const mine = new Set(nodes.map(n => n.id));
  const page = <T extends { id: string }>(items: T[], after: string) => items.filter(x => x.id > after).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 1000);
  return {
    nodePage: (_: string, after: string) => Promise.resolve(page(nodes, after)),
    relPage: (_: string, after: string) => Promise.resolve(page(rels.filter(r => mine.has(r.start) && mine.has(r.end)), after)),
    outsideCounts: () => Promise.resolve(rels.filter(r => mine.has(r.start) !== mine.has(r.end)).map(r => ({ type: r.type, labels: ["Person"], n: 1 }))),
  };
}
const ACCOUNTS = `${WORK}/accounts`;
async function account(name: string, files: Record<string, string | Uint8Array>) {
  for (const [path, body] of Object.entries(files)) {
    await Deno.mkdir(`${ACCOUNTS}/${name}/${path}`.replace(/\/[^/]+$/, ""), { recursive: true });
    if (typeof body === "string") await Deno.writeTextFile(`${ACCOUNTS}/${name}/${path}`, body); else await Deno.writeFile(`${ACCOUNTS}/${name}/${path}`, body);
  }
}
const MB = 1024 * 1024;
await account("acct-test", { "account.json": "{}", "notes/opening.md": "# Opening\nSix in the morning.\n", "price-list.csv": "loaf,2.10\n", "Thumbs.db": "windows",
  ".claude/settings.local.json": '{"key":"x"}', ".gitkeep": "", "uploads/oven.bin": new Uint8Array(6.5 * MB).fill(7) });
const EXPORT = `${WORK}/export`;
await exportAccount({ source: sourceOf(NODES, RELS), accountId: "acct-test", outDir: EXPORT, accountsDir: ACCOUNTS, now: new Date("2026-11-15T10:00:00Z") });
// Finder writes its own file into a folder the person opens, after the export.
await Deno.writeTextFile(`${EXPORT}/files/notes/.DS_Store`, "finder");
const exported = JSON.parse(await Deno.readTextFile(`${EXPORT}/manifest.json`));
check("exportAccount's manifest counts every node by label, AdminUser too, and leaves out the account file, the system file and the dot-named ones",
  exported.nodes.byLabel.AdminUser === 1 && exported.nodes.byLabel.Person === 3 && exported.nodes.byLabel.Trashed === 1 && exported.skipped.AdminUser.count === 1
    && JSON.stringify(exported.filesLeftOut.map((f: { path: string }) => f.path).sort()) === '[".claude",".gitkeep","Thumbs.db","account.json"]'
    && exported.droppedProperties.magicToken === 1, exported);

async function importRun(folder: string) {
  const out = await new Deno.Command("node", { args: [FABRIK, "import", "maxy", folder, "--project", REF, "--email", EMAIL], cwd: WORK,
    env: { HOME, USERPROFILE: HOME }, stdout: "piped", stderr: "piped" }).output();
  return { status: out.code, out: decoder.decode(out.stdout), err: decoder.decode(out.stderr) };
}
const counts = async () => (await sql`select (select count(*) from fabrik.record)::int as records, (select count(*) from fabrik.record_version)::int as versions,
  (select count(*) from fabrik.version_link)::int as links, (select count(*) from storage.objects where bucket_id = 'general')::int as files,
  (select count(*) from fabrik.relation_type)::int as relations`)[0];
const before = await counts();

try {
  // ---- 1. The first run ----
  let began = Date.now();
  let ran = await importRun(EXPORT);
  const firstMs = Date.now() - began, firstCalls = calls;
  quote(ran.out + ran.err);
  const report = JSON.parse(await Deno.readTextFile(`${EXPORT}/import-report.json`));
  const n = (r: { exported: number; loaded: number; alreadyPresent: number; leftOut: { count: number; reason: string; expected: boolean }[] }) =>
    [r.exported, r.loaded, r.alreadyPresent, r.leftOut.reduce((s, l) => s + l.count, 0)];
  const L = report.labels, R = report.relationships;
  type Row = { exported: number; loaded: number; merged?: number; alreadyPresent: number; leftOut: { count: number }[] };
  const m = (r: Row) => [r.exported, r.loaded, r.merged ?? 0, r.alreadyPresent, r.leftOut.reduce((s, l) => s + l.count, 0)];
  const adds = (r: Row) => r.loaded + (r.merged ?? 0) + r.alreadyPresent + r.leftOut.reduce((s, l) => s + l.count, 0) === r.exported;
  const balanced = (rep: { labels: Record<string, Row>; relationships: Record<string, Row>; files: Row }) =>
    [...Object.values(rep.labels), ...Object.values(rep.relationships), rep.files].every(adds);
  check(`the import exits 0, in ${firstMs} ms with ${firstCalls} calls to the Data API`, ran.status === 0, ran.err);
  check("the report gives each label's exported, loaded, already present and left out: Person 3 3 0 0, Organization 2 2 0 0, Project 2 2 0 0 with one as deleted, Task 3 3 0 0, Decision 2 2 0 0, AdminUser 1 0 0 1",
    JSON.stringify([n(L.Person), n(L.Organization), n(L.Project), n(L.Task), n(L.Decision), n(L.AdminUser)])
      === JSON.stringify([[3, 3, 0, 0], [2, 2, 0, 0], [2, 2, 0, 0], [3, 3, 0, 0], [2, 2, 0, 0], [1, 0, 0, 1]]) && L.Project.loadedAsDeleted === 1
      && L.AdminUser.leftOut[0].expected === true, L);
  check("and each relationship type's exported, loaded, merged, already present and left out: WORKS_AT 5 3 1 0 1 (duplicate link, note full), HAS_TASK 3 2 0 0 1 (an end trashed), HAS-TASK 1 1 0 0 0, HAS-2-OWNERS 2 2 0 0 0, ADMIN_OF 1 0 0 0 1 (the exporter left out its AdminUser end)",
    JSON.stringify([m(R.WORKS_AT), m(R.HAS_TASK), m(R["HAS-TASK"]), m(R["HAS-2-OWNERS"]), m(R.ADMIN_OF)])
      === JSON.stringify([[5, 3, 1, 0, 1], [3, 2, 0, 0, 1], [1, 1, 0, 0, 0], [2, 2, 0, 0, 0], [1, 0, 0, 0, 1]])
      && R.WORKS_AT.leftOut[0].reason === "duplicate link, note full" && R.WORKS_AT.leftOut[0].expected === true
      && R.HAS_TASK.leftOut[0].reason.includes("trashed") && R.ADMIN_OF.leftOut[0].reason === "an end is a node that is not imported" && report.ok === true, R);
  const F = report.files;
  const why = (reason: string) => F.leftOut.find((l: { reason: string }) => l.reason === reason)?.count ?? 0;
  check("the files: 8 exported, 3 loaded, oven.bin's 6.5 MB through the resumable upload; left out, none failing the import: Thumbs.db and Finder's .DS_Store as system files, .claude and .gitkeep as the install's configuration, and account.json",
    JSON.stringify(n(F)) === "[8,3,0,5]" && why("a system file, not the person's data") === 2 && why("the install's own configuration, not the person's data") === 2
      && why("left out by the exporter: account file") === 1 && F.leftOut.every((l: { expected: boolean }) => l.expected), F);
  check("the outside-account relationship is printed", ran.out.includes("Relationships to nodes outside this account, not exported: HAS-2-OWNERS 1"), ran.out);
  check("progress goes to stderr, a line for each phase", ["Checked the export: 12 nodes, 11 relationships.", "Records: 12 nodes to load into General.", "Links: 10 relationships to link.",
    "Files: 4 to upload to General's bucket.", "KNOWLEDGE.md: drafting it."].every(l => ran.err.includes(l)), ran.err);
  check("for every label, relationship type and the files, loaded, merged, already present and left out add up to the export", balanced(report), report);
  const [ann] = await sql`select l.note from fabrik.version_link l join fabrik.record_version v on v.version_id = l.source_version_id
    where v.payload->'source'->>'id' = ${id(1)} and l.relation = 'works_at'
    and v.change_no = (select max(c.change_no) from fabrik.record_version c where c.record_id = v.record_id)`;
  const annNote = JSON.parse(ann.note);
  check("Ann's works_at link keeps its own properties and, merged, the second WORKS_AT's, in its note",
    annNote.source.id === "5:acct-test:1" && annNote.properties.since === 2019 && JSON.stringify(annNote.merged) === '[{"id":"5:acct-test:11","properties":{"role":"baker","since":2021}}]', annNote);
  const [rows] = await sql`select count(*)::int as n, count(*) filter (where r.deleted_at is not null)::int as deleted from fabrik.record r
    join fabrik.scope s using(scope_id) where s.code = 'general'`;
  check("General holds 12 records, the trashed one deleted", rows.n === 12 && rows.deleted === 1, rows);
  const [ben] = await sql`select v.payload from fabrik.record_version v where v.payload->'source'->>'id' = ${id(2)}`;
  const kept = await sql`select ((select count(*) from fabrik.record_version v where v.payload::text ~* '(SECRET|magic_?token|slice_?token|api-?key)')
    + (select count(*) from fabrik.version_link l where l.note ~* '(SECRET|api_?key)'))::int as n`;
  check("the node carrying magicToken, slice_token and API-KEY is saved without any of them, and no version or link note holds a secret",
    ben && !("magicToken" in ben.payload.properties) && !("slice_token" in ben.payload.properties) && !("API-KEY" in ben.payload.properties) && kept[0].n === 0, { properties: ben?.payload.properties, kept });
  check("a node's payload keeps type, labels, source and each property decoded: age 41, the point as {srid, x, y}",
    ben.payload.type === "Person" && JSON.stringify(ben.payload.labels) === '["Person"]' && ben.payload.source.system === "maxy-code" && ben.payload.properties.age === 41, ben.payload);
  const [acme] = await sql`select v.payload->'properties'->'location' as loc, v.title from fabrik.record_version v where v.payload->'source'->>'id' = ${id(4)}`;
  check("Acme Bakery's location decodes to {srid: 4326, x: -0.1, y: 51.5}", acme.title === "Acme Bakery" && acme.loc.srid === 4326 && acme.loc.x === -0.1 && acme.loc.y === 51.5 && Object.keys(acme.loc).length === 3, acme);
  const [untitled] = await sql`select v.title, r.kind, v.payload->>'activity_kind' as ak from fabrik.record_version v join fabrik.record r using(record_id) where v.payload->'source'->>'id' = ${id(10)}`;
  check("a node with no name or title is titled by its label and short id, and a Task is a task", untitled.title === "Task 10" && untitled.kind === "activity" && untitled.ak === "task", untitled);
  const links = await sql`select l.relation, count(*)::int as n from fabrik.version_link l join fabrik.record_version v on v.version_id = l.source_version_id
    where v.change_no = (select max(c.change_no) from fabrik.record_version c where c.record_id = v.record_id) group by 1 order by 1`;
  const [versions] = await sql`select max(n)::int as most from (select count(*) as n from fabrik.record_version v join fabrik.record r using(record_id) where r.deleted_at is null group by v.record_id) c`;
  check("a record's links are saved together: no imported record has more than two versions, its save and its links", versions.most === 2, versions);
  check("the latest versions hold 3 works_at, 2 has_task, 1 has_task_two and 2 has_owners links",
    JSON.stringify(links) === '[{"relation":"has_owners","n":2},{"relation":"has_task","n":2},{"relation":"has_task_two","n":1},{"relation":"works_at","n":3}]', links);
  check("each type's relation was saved first: works_at from the map, has_owners derived from HAS-2-OWNERS, and has_task_two from HAS-TASK, whose has_task HAS_TASK has; has_task is fabrik's own",
    JSON.stringify(report.relationTypesSaved.sort()) === '["has_owners","has_task_two","works_at"]'
    && (await sql`select 1 from fabrik.relation_type where code = 'has_owners'`).length === 1, report.relationTypesSaved);
  const objects = await sql`select name, metadata->>'size' as size from storage.objects where bucket_id = 'general' order by name`;
  check("the files are in General's bucket under their paths, oven.bin whole", JSON.stringify(objects.map(o => [o.name, o.size])) === `[["notes/opening.md","30"],["price-list.csv","10"],["uploads/oven.bin","${6.5 * MB}"]]`
    && stored.get("general/uploads/oven.bin")?.length === 6.5 * MB && stored.get("general/uploads/oven.bin")?.every(b => b === 7), objects);
  const knowledge = await Deno.readTextFile(`${EXPORT}/KNOWLEDGE.md`).catch(() => "");
  check("with no public-agent bucket, the KNOWLEDGE.md draft is written to the export folder, Organization and Project sections only, and the report says why",
    knowledge === "## Acme Bakery\n\nAcme bakes bread every morning from 6am.\n\n## New shop\n\nA second shop opens in spring.\n"
      && report.knowledge.why === "fabrik has no public-agent bucket yet" && ran.out.includes("because fabrik has no public-agent bucket yet"), { knowledge, k: report.knowledge });

  // ---- 2. A second run loads nothing ----
  const after = await counts();
  calls = 0; began = Date.now();
  ran = await importRun(EXPORT);
  quote(ran.out + ran.err);
  const again = JSON.parse(await Deno.readTextFile(`${EXPORT}/import-report.json`));
  const loaded = [...Object.values(again.labels), ...Object.values(again.relationships), again.files].reduce((s: number, r) => s + (r as { loaded: number }).loaded, 0);
  check(`a second run exits 0 and loads nothing, in ${Date.now() - began} ms with ${calls} calls: every record, link and file already present`, ran.status === 0 && loaded === 0
    && again.labels.Person.alreadyPresent === 3 && again.labels.Project.alreadyPresent === 2 && again.relationships.WORKS_AT.alreadyPresent === 4 && again.relationships["HAS-TASK"].alreadyPresent === 1 && again.files.alreadyPresent === 3
    && balanced(again), again);
  const [annAgain] = await sql`select l.note from fabrik.version_link l join fabrik.record_version v on v.version_id = l.source_version_id
    where v.payload->'source'->>'id' = ${id(1)} and l.relation = 'works_at'
    and v.change_no = (select max(c.change_no) from fabrik.record_version c where c.record_id = v.record_id)`;
  check("and Ann's link note holds the merged relationship once", annAgain.note === ann.note, annAgain.note);
  const second = await counts();
  check("and the database is as the first run left it", JSON.stringify(second) === JSON.stringify(after), { after, second });

  // ---- 3. A file over the project's size limit ----
  await account("acct-big", { "uploads/huge.bin": new Uint8Array(11 * MB).fill(1) });
  const BIG = `${WORK}/big`;
  await exportAccount({ source: sourceOf([{ id: "4:acct-big:1", labels: ["Person"], props: { name: "Dee Dean" } }], []), accountId: "acct-big", outDir: BIG, accountsDir: ACCOUNTS });
  ran = await importRun(BIG);
  quote(ran.out);
  const big = JSON.parse(await Deno.readTextFile(`${BIG}/import-report.json`));
  check("a file over the project's 10 MB limit is left out with its size and how to raise the limit, and the import exits 1",
    ran.status === 1 && big.files.leftOut[0]?.reason === "larger than the project's file size limit (11.0 MB)" && ran.out.includes("Upload file size limit") && !stored.has("general/uploads/huge.bin"), big.files);
  const afterBig = await counts();

  // ---- 4. Refused before anything is saved ----
  const UNKNOWN = `${WORK}/unknown`;
  await exportAccount({ source: sourceOf([...NODES.slice(0, 3), node(20, ["Mystery"], { name: "Nobody knows" })], []), accountId: "acct-test", outDir: UNKNOWN, accountsDir: ACCOUNTS });
  ran = await importRun(UNKNOWN);
  quote(ran.err);
  check("an export with a label the map does not name is refused, naming it, and nothing is saved", ran.status === 1 && ran.err.includes("Mystery")
    && JSON.stringify(await counts()) === JSON.stringify(afterBig) && !(await Deno.stat(`${UNKNOWN}/import-report.json`).catch(() => null)), ran.err);
  const TAMPERED = `${WORK}/tampered`;
  await exportAccount({ source: sourceOf(NODES, RELS), accountId: "acct-test", outDir: TAMPERED, accountsDir: ACCOUNTS });
  await Deno.writeTextFile(`${TAMPERED}/files/price-list.csv`, "loaf,0.01\n");
  ran = await importRun(TAMPERED);
  quote(ran.err);
  check("an export changed after it was written is refused, naming the file, and nothing is saved", ran.status === 1 && ran.err.includes("files/price-list.csv does not match its sha256")
    && JSON.stringify(await counts()) === JSON.stringify(afterBig), ran.err);
  check("the first run added 12 records, and 3 relations, each with its record in Reference", after.records - before.records === 12 + 3 && after.relations - before.relations === 3, { before, after });
} finally {
  await server.shutdown();
  await sql.end();
  await Deno.remove(WORK, { recursive: true });
}
if (failed) { console.log(`FAIL ${failed} check(s)`); Deno.exit(1); }
