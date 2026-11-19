// A glossary term that ordinary files bury, at the database level, as fabrik would meet it: the question
// "chain" asked through the file-search hosted function against the stand-in, after
// file-search-functions.ts. The glossary term "chain" is saved with fabrik_save_term. Ten files in
// `general` each use "chain" many times; one guide in `reference` names it once; and a session in the
// test person's sessions scope says fabrik has no definition of it. file-search-worker takes the files'
// text and vectors. A search across all scopes returns the reference scope's own top hits as
// reference_hits, beside hits from the other scopes, and nothing from the sessions scope; a search
// naming a scope returns hits only; a search naming the sessions scope returns the session; and
// fabrik_get_reference('glossary') returns the definition. The term's record is found by the administrator, and not by
// the reader, whose grant covers activities only. A model of words stands in for gte-small,
// which runs only in Supabase's hosted functions. run.sh runs it.
import postgres from "npm:postgres@3.4.9";

const DB = Deno.env.get("STAND_IN_DB")!;
const FUNCTIONS = new URL("../../setup/functions/", import.meta.url);
// file-search-functions.ts saved the worker secret in the vault.
const SECRET = "worker-secret";
const STORAGE_KEY = "storage-key";
const DEFINITION = "A line of linked sales, in which each buyer's purchase depends on their own sale going through.";

/** Each word of the text, hashed into one of 384 places, normalised: texts that share words point the same way. */
function vectorFor(text: string): number[] {
  const v = new Array(384).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 0;
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) % 384;
    v[h] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

let failed = 0;
function check(what: string, ok: boolean, seen: unknown) {
  console.log(`${ok ? "ok" : "FAIL"} - ${what}${ok ? "" : `: ${JSON.stringify(seen)}`}`);
  if (!ok) failed++;
}

const encode = (text: string) => new TextEncoder().encode(text);
// The guide in the reference scope names a chain once, among other words.
const guide = encode("# Sales progression guide\n\nOnce an offer is agreed, the sales progressor writes the memorandum of sale, "
  + "confirms each solicitor, checks the buyer's mortgage offer and the survey, and asks whether the buyer's own sale sits in a chain. "
  + "They chase searches and enquiries weekly and agree a completion date with both sides.\n");
// Each general file repeats the word.
const general = (n: number) => encode(`# Sale ${n} update\n\nChain update for sale ${n}: chain of four, chain still moving, `
  + `the chain's top buyer chases, the chain's bottom seller waits, chain call booked, chain notes saved.\n`);
// The session says fabrik has no definition, and names the word more often than any update does.
const session = encode("# Session\n\nWhat is a chain? Chain, chain, chain: I searched fabrik's files for chain. fabrik has no definition "
  + "of chain; no chain file defines a chain. Every chain hit was a chain update about a chain of sales.\n");
let sessions = "";
/** The bytes Storage holds for an object, by its bucket and name. */
function stored(bucket: string, name: string): Uint8Array | undefined {
  if (bucket === "reference" && name === "guides/sales-progression.md") return guide;
  const update = bucket === "general" && name.match(/^updates\/sale-(\d+)\.md$/);
  if (update) return general(Number(update[1]));
  if (bucket === sessions && name === "2026-10-15-chain.md") return session;
}

// Supabase's Storage and Auth, as far as the functions use them. A token is a user's id.
const users = new Set<string>();
const supabase = Deno.serve({ port: 0, onListen() {} }, (req) => {
  const path = new URL(req.url).pathname;
  const auth = req.headers.get("Authorization") ?? "";
  const object = path.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
  if (object && req.method === "GET" && auth === `Bearer ${STORAGE_KEY}`) {
    const bytes = stored(object[1], decodeURIComponent(object[2]));
    if (bytes) return new Response(bytes, { headers: { "Content-Type": "text/markdown" } });
    return Response.json({ statusCode: "404", message: "Object not found" }, { status: 400 });
  }
  const token = auth.replace(/^Bearer /, "");
  if (path === "/auth/v1/user") return users.has(token) ? Response.json({ id: token }) : Response.json({ msg: "invalid JWT" }, { status: 403 });
  return new Response("Not found", { status: 404 });
});
Deno.env.set("SUPABASE_URL", `http://127.0.0.1:${supabase.addr.port}`);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", STORAGE_KEY);
Deno.env.set("SUPABASE_ANON_KEY", "publishable-key");
Deno.env.set("SUPABASE_DB_URL", DB);
(globalThis as Record<string, unknown>).Supabase = { ai: { Session: class {
  run(text: string) { return Promise.resolve(vectorFor(text)); } } } };

/** Load a function and take the handler it gives Deno.serve, instead of listening. */
async function load(name: string): Promise<(req: Request) => Promise<Response>> {
  let handler: ((req: Request) => Promise<Response>) | undefined;
  const serve = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (h: typeof handler) => { handler = h; return { finished: Promise.resolve(), shutdown() {} }; };
  await import(new URL(`${name}/index.ts`, FUNCTIONS).href);
  (Deno as unknown as { serve: unknown }).serve = serve;
  return handler!;
}
const worker = await load("file-search-worker");
const search = await load("file-search");

const sql = postgres(DB, { max: 1, prepare: false, onnotice() {} });
const work = async (job: string) => (await worker(new Request("http://function/", { method: "POST",
  headers: { Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ job }) }))).json();
const ask = async (token: string, body: Record<string, unknown>) => (await search(new Request("http://function/", { method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }))).json();
/** Run a database function as a signed-in user, as PostgREST does. */
const asUser = (user: string, run: (tx: postgres.TransactionSql) => Promise<unknown>) => sql.begin(async (tx) => {
  await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: "authenticated" })}, true)`;
  await tx`set local role authenticated`;
  return await run(tx);
});
type Hit = { bucket: string; file: string; place: string | null; section: number; found: string[]; record_id?: string; version_number?: number };
const listed = (hits: Hit[] | undefined) => (hits ?? []).map((h) => `${h.bucket}/${h.file} [${h.found.join(",")}] section ${h.section}`);

try {
  const reader = crypto.randomUUID();
  await sql`insert into auth.users(id) values (${reader})`;
  users.add(reader);
  const [first] = await sql`select actor_id, auth_user_id from fabrik.actor where authority_class='administrator' and actor_kind='human' and enabled
    order by actor_id limit 1`;
  const [{ r }] = await sql`select fabrik_private.provision_actor(${first.actor_id}::uuid, ${reader}::uuid, 'Chain question reader', 'human', null::uuid, 'restricted', false) as r`;
  sessions = `sessions_${reader.replaceAll("-", "")}`;
  for (const [code, name] of [["reference", "Reference"], ["general", "General"], [sessions, "Chain question reader's sessions"]])
    await sql`insert into fabrik.scope(code, display_name, description, created_by)
      select ${code}, ${name}, 'Stand-in fixture', ${first.actor_id} where not exists (select 1 from fabrik.scope where code=${code})`;
  for (const code of ["reference", "general", sessions])
    await sql`select fabrik_private.provision_grant(${first.actor_id}::uuid, gen_random_uuid(), ${r}::uuid, (select scope_id from fabrik.scope where code=${code}),
      array['activity'], null::uuid, array['read'], null::timestamptz, 'Chain question reader')`;
  const marks = await sql`select bucket_id, ranked_apart, searched_by_default from file_search.indexed_bucket
    where bucket_id in ('reference', 'general', ${sessions}) order by bucket_id`.catch((e) => [{ error: e.message }]);
  console.log(`  indexed buckets: ${JSON.stringify(marks)}`);
  const mark = (b: string) => (marks as { bucket_id?: string; ranked_apart?: boolean; searched_by_default?: boolean }[]).find((m) => m.bucket_id === b);
  check("the reference scope's bucket is ranked apart, general's is not, and a new sessions scope's is not searched by default",
    mark("reference")?.ranked_apart === true && mark("reference")?.searched_by_default === true
      && mark("general")?.ranked_apart === false && mark("general")?.searched_by_default === true
      && mark(sessions)?.ranked_apart === false && mark(sessions)?.searched_by_default === false, marks);

  // The administrator saves the glossary term, as the reference skill does.
  await asUser(first.auth_user_id, (tx) => tx`select fabrik.fabrik_save_term('chain', 'term', ${DEFINITION}, 'Glossary stand-in', array['property chain'])`);
  await sql`insert into storage.objects(bucket_id, name, owner_id, metadata) values ('reference', 'guides/sales-progression.md', ${first.auth_user_id}, '{"eTag":"c0"}')`;
  for (let n = 1; n <= 10; n++)
    await sql`insert into storage.objects(bucket_id, name, owner_id, metadata) values ('general', ${`updates/sale-${n}.md`}, ${first.auth_user_id}, ${sql.json({ eTag: `c${n}` })})`;
  await sql`insert into storage.objects(bucket_id, name, owner_id, metadata) values (${sessions}, '2026-10-15-chain.md', ${reader}, '{"eTag":"s1"}')`;

  // The worker takes the files' text, then their vectors, run by run until none is left.
  for (const job of ["extract", "embed"])
    for (let run = 0; run < 200; run++) if (!(await work(job)).continued) break;
  const files = await sql`select v.bucket_id, v.name, v.state from file_search.file_version v
    where v.state <> 'retired' and v.object_id is not null and v.bucket_id in ('reference', 'general', ${sessions}) order by 1, 2`;
  check("the worker takes the guide's, the ten updates' and the session's text",
    files.length === 12 && files.every((f) => f.state === "extracted"), files);

  // How far down the keyword ranking the reference guide's passage sits, among every passage naming "chain".
  const [{ rank, of }] = await sql`select (select n from (select c.chunk_id, v.bucket_id,
      row_number() over (order by ts_rank_cd(c.words, q) desc, c.chunk_id) as n
      from file_search.chunk c join file_search.file_version v using (version_id), websearch_to_tsquery('english', 'chain') q
      where c.words @@ q and v.state = 'extracted' and v.object_id is not null) x where x.bucket_id = 'reference') as rank,
    (select count(*)::int from file_search.chunk c, websearch_to_tsquery('english', 'chain') q where c.words @@ q and c.object_id is not null) as of`;
  console.log(`  the reference guide's passage ranks ${rank} of ${of} passages naming "chain" under the keyword ranking`);

  const asked = await ask(reader, { query: "chain" });
  console.log(`  {"query": "chain"} returned reference_hits ${JSON.stringify(listed(asked.reference_hits))}`);
  console.log(`  and hits ${JSON.stringify(listed(asked.hits))}`);
  console.log(`  and sections ${JSON.stringify((asked.sections ?? []).map((s: { bucket: string; file: string }) => `${s.bucket}/${s.file}`))}`);
  check("the reference guide comes back in reference_hits, and its section is numbered first",
    asked.reference_hits?.length === 1 && asked.reference_hits[0].file === "guides/sales-progression.md" && asked.reference_hits[0].section === 0
      && asked.sections?.[0]?.file === "guides/sales-progression.md", asked.reference_hits);
  check("hits are the ten general updates, their sections numbered after the reference hits'",
    asked.hits?.length === 10 && asked.hits.every((h: Hit) => h.bucket === "general" && h.section >= 1), asked.hits);
  check("no hit is in a sessions scope",
    ![...(asked.hits ?? []), ...(asked.reference_hits ?? [])].some((h: Hit) => h.bucket.startsWith("sessions_")), asked);

  // The glossary term is a record of kind model in the reference scope. The administrator, who reads every record, finds
  // it among reference_hits beside the guide; the reader, whose grant there covers activities only, does not.
  users.add(first.auth_user_id);
  const asAdmin = await ask(first.auth_user_id, { query: "chain" });
  console.log(`  {"query": "chain"} as the administrator returned reference_hits ${JSON.stringify(listed(asAdmin.reference_hits))}`);
  const termHit = (asAdmin.reference_hits ?? []).find((h: Hit & { record_id?: string }) => h.file === "Glossary: chain");
  check("the administrator finds the glossary term's record in reference_hits, with its record_id and version, beside the guide",
    typeof termHit?.record_id === "string" && (termHit.version_number ?? 0) >= 1 && termHit.found.includes("words")
      && (asAdmin.reference_hits ?? []).some((h: Hit) => h.file === "guides/sales-progression.md"), asAdmin.reference_hits);
  check("the reader, whose grant in the reference scope covers activities only, does not find the term's record",
    ![...(asked.hits ?? []), ...(asked.reference_hits ?? [])].some((h: Hit & { record_id?: string }) => h.record_id), asked);

  const named = await ask(reader, { query: "chain", bucket: "general" });
  check("a search naming one scope returns hits only, and an empty reference_hits",
    Array.isArray(named.reference_hits) && named.reference_hits.length === 0 && named.hits?.length > 0
      && named.hits.every((h: Hit) => h.bucket === "general"), named);
  const earlier = await ask(reader, { query: "chain", bucket: sessions });
  console.log(`  {"query": "chain", "bucket": "${sessions}"} returned hits ${JSON.stringify(listed(earlier.hits))}`);
  check("a search naming the sessions scope returns the session",
    Array.isArray(earlier.reference_hits) && earlier.reference_hits.length === 0 && earlier.hits?.[0]?.file === "2026-10-15-chain.md", earlier);

  const glossary = await asUser(reader, (tx) => tx`select fabrik.fabrik_get_reference('glossary') as g`) as { g: { rows: { term: string; definition: string }[] } }[];
  const term = glossary[0].g.rows.find((t) => t.term === "chain");
  console.log(`  fabrik_get_reference('glossary') returned ${JSON.stringify(term)}`);
  check("fabrik_get_reference('glossary') returns the definition of chain", term?.definition === DEFINITION, glossary[0].g);
} finally {
  await sql.end();
  await supabase.shutdown();
}
Deno.exit(failed ? 1 : 0);
