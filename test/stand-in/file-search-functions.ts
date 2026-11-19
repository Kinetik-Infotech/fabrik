// Both file search hosted functions, run against the stand-in after the SQL steps. A PDF lands
// in a scope's bucket; the dispatcher asks file-search-worker to take its text, then separately
// to make its vectors; an actor searches through file-search with their own sign-in, and an
// actor without read permission, and a forged sign-in, find nothing. An actor's agent saves the
// graph of two pages, its entity types and relation names the glossary's classes and relationships,
// the worker's graph job makes the entities' vectors, and a search finds a page two steps from the
// question through it; asked how, the search is explained and drawn with the fabrik plugin's draw_search. A record's
// versions are found by their owner, by words and by meaning, and by nobody without read on their scope; a new version
// replaces the old, a moved record follows its new scope's grants, and a deleted record is found no more. A fixed model stands in for
// gte-small, which runs only in Supabase's hosted functions; slowed, it shows a run ending on its
// time budget and queuing the next. run.sh runs it.
import postgres from "npm:postgres@3.4.9";
import { PDFDocument, StandardFonts } from "npm:pdf-lib@1.17.1";
// SheetJS 0.20.3, kept in the worker's vendor folder; vendor/sheetjs-0.20.3/SHA256SUMS records its files.
// @deno-types="../../setup/functions/file-search-worker/vendor/sheetjs-0.20.3/types/index.d.ts"
import * as XLSX from "../../setup/functions/file-search-worker/vendor/sheetjs-0.20.3/xlsx.mjs";

const DB = Deno.env.get("STAND_IN_DB")!;
const FUNCTIONS = new URL("../../setup/functions/", import.meta.url);
const SECRET = "worker-secret";
const STORAGE_KEY = "storage-key";

/** Delivery words point one way, supplier words a third, anything else another: enough to tell meaning from words. */
function vectorFor(text: string): number[] {
  const v = new Array(384).fill(0);
  v[/supplier|northfield/i.test(text) ? 2 : /deliver|carriage|postage/i.test(text) ? 1 : 0] = 1;
  return v;
}

let failed = 0;
function check(what: string, ok: boolean, seen: unknown) {
  console.log(`${ok ? "ok" : "FAIL"} - ${what}${ok ? "" : `: ${JSON.stringify(seen)}`}`);
  if (!ok) failed++;
}

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
pdf.addPage().drawText("Wholesale price list for spring bedding.", { x: 50, y: 700, size: 12, font });
pdf.addPage().drawText("Delivery charges apply to orders under fifty pounds.", { x: 50, y: 700, size: 12, font });
const bytes = await pdf.save();
const catalogue = await PDFDocument.create();
const catalogueFont = await catalogue.embedFont(StandardFonts.Helvetica);
for (let page = 1; page <= 6; page++)
  catalogue.addPage().drawText(`Catalogue page ${page}: garden furniture.`, { x: 50, y: 700, size: 12, font: catalogueFont });
const catalogueBytes = await catalogue.save();
// A stock workbook saved as an OpenDocument spreadsheet, with a rare word on its second sheet.
const stockBook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(stockBook, XLSX.utils.aoa_to_sheet([["SKU", "Name"], ["TEMP-P-006", "Himalayan Lime"]]), "Bible");
XLSX.utils.book_append_sheet(stockBook, XLSX.utils.aoa_to_sheet([["SKU", "Note"], ["TEMP-P-006", "Marmalade flavour trial"]]), "Stock");
const stockBytes = new Uint8Array(XLSX.write(stockBook, { type: "array", bookType: "ods" }));
// A guide whose "Seeing rows" section runs over several chunks, with a rare word in its middle,
// and whose last section is longer than a search returns whole.
const steps = Array.from({ length: 8 }, (_, i) =>
  `${i + 1}. Step ${i + 1} of seeing rows${i === 4 ? ", where you choose the zanzibar schema" : ""}. ${"Then carry on reading the table. ".repeat(8)}`);
const guideText = `# Guide\n\nWhat this guide covers.\n\n## Seeing rows\n\n${steps.join("\n\n")}\n\n## Logs\n\nOpen the logs.\n\n## Long\n\n${"Quartermaster notes run on. ".repeat(400)}\n`;

// Supabase's Storage and Auth, as far as the functions use them. A token is a user's id.
// A delete runs as the user, as Storage's does, so the project's own rules decide it.
const users = new Set<string>();
/** The user a token stands for: a user's id, for a password-only sign-in, or a token with a code for one. */
function userOf(token: string): string | null {
  if (users.has(token)) return token;
  try {
    const claims = JSON.parse(atob(token.split(".")[1]));
    return claims.aal === "aal2" && users.has(claims.sub) ? claims.sub : null;
  } catch { return null; }
}
let storageSql: ReturnType<typeof postgres>;
const supabase = Deno.serve({ port: 0, onListen() {} }, async (req) => {
  const path = new URL(req.url).pathname;
  const auth = req.headers.get("Authorization") ?? "";
  if (path === "/storage/v1/object/worker_test/prices.pdf" && req.method === "GET" && auth === `Bearer ${STORAGE_KEY}`)
    return new Response(bytes, { headers: { "Content-Type": "application/pdf" } });
  if (path === "/storage/v1/object/worker_test/catalogue.pdf" && req.method === "GET" && auth === `Bearer ${STORAGE_KEY}`)
    return new Response(catalogueBytes, { headers: { "Content-Type": "application/pdf" } });
  if (path === "/storage/v1/object/worker_test/guide.md" && req.method === "GET" && auth === `Bearer ${STORAGE_KEY}`)
    return new Response(guideText, { headers: { "Content-Type": "text/markdown" } });
  if (path === "/storage/v1/object/worker_test/stock.ods" && req.method === "GET" && auth === `Bearer ${STORAGE_KEY}`)
    return new Response(stockBytes, { headers: { "Content-Type": "application/vnd.oasis.opendocument.spreadsheet" } });
  if (path === "/storage/v1/object/worker_test/notes.pages" && req.method === "GET" && auth === `Bearer ${STORAGE_KEY}`)
    return new Response(new Uint8Array([80, 75, 3, 4]), { headers: { "Content-Type": "application/x-iwork-pages-sffpages" } });
  const token = auth.replace(/^Bearer /, "");
  const object = path.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
  if (object && req.method === "DELETE" && object[2] === "during-an-outage.pdf")
    return Response.json({ message: "Service Unavailable" }, { status: 503 });
  if (object && req.method === "DELETE" && userOf(token)) {
    const removed = await storageSql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userOf(token), role: "authenticated", aal: users.has(token) ? "aal1" : "aal2" })}, true)`;
      await tx`set local role authenticated`;
      // Supabase's Storage API is the delete its storage.protect_delete guard lets through.
      await tx`select set_config('storage.allow_delete_query', 'true', true)`;
      return await tx`delete from storage.objects where bucket_id = ${object[1]} and name = ${decodeURIComponent(object[2])} returning id`;
    });
    return removed.length ? Response.json([{ name: object[2] }]) : Response.json({ statusCode: "404", message: "Object not found" }, { status: 400 });
  }
  if (path === "/auth/v1/user" && userOf(token)) return Response.json({ id: userOf(token) });
  if (path === "/auth/v1/user") return Response.json({ msg: "invalid JWT" }, { status: 403 });
  return new Response("Not found", { status: 404 });
});

Deno.env.set("SUPABASE_URL", `http://127.0.0.1:${supabase.addr.port}`);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", STORAGE_KEY);
Deno.env.set("SUPABASE_ANON_KEY", "publishable-key");
Deno.env.set("SUPABASE_DB_URL", DB);
let modelMs = 0;
(globalThis as Record<string, unknown>).Supabase = { ai: { Session: class {
  async run(text: string) { await new Promise((r) => setTimeout(r, modelMs)); return vectorFor(text); } } } };

/**
 * Load a function and take the handler it gives Deno.serve, instead of listening. Each instance is a fresh
 * load of the module, as Supabase starts an instance of its own.
 */
let instances = 0;
async function load(name: string): Promise<(req: Request) => Promise<Response>> {
  let handler: ((req: Request) => Promise<Response>) | undefined;
  const serve = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (h: typeof handler) => { handler = h; return { finished: Promise.resolve(), shutdown() {} }; };
  await import(new URL(`${name}/index.ts?instance=${++instances}`, FUNCTIONS).href);
  (Deno as unknown as { serve: unknown }).serve = serve;
  return handler!;
}
const search = await load("file-search");
const purge = await load("file-search-purge");

const sql = postgres(DB, { max: 1, prepare: false, onnotice() {} });
storageSql = postgres(DB, { max: 1, prepare: false, onnotice() {} });
// Each call is served by an instance of its own, unless it names one.
const workIn = (worker: (req: Request) => Promise<Response>, secret: string, job: string, call?: number) =>
  worker(new Request("http://function/", { method: "POST", headers: { Authorization: `Bearer ${secret}` }, body: JSON.stringify({ job, call }) }));
const work = async (secret: string, job: string, call?: number) => workIn(await load("file-search-worker"), secret, job, call);
/** A token whose claims hold the user and aal2, as Supabase gives a sign-in that gave a code. */
const coded = (user: string) => `h.${btoa(JSON.stringify({ sub: user, role: "authenticated", aal: "aal2" })).replace(/=+$/, "")}.s`;
const askWith = (token: string, body: Record<string, unknown>) =>
  search(new Request("http://function/", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const ask = (token: string, query: string) => askWith(token, { query });
const purgeAs = (token: string, bucket: string, file: string) =>
  purge(new Request("http://function/", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ bucket, file }) }));

try {
  const admin = crypto.randomUUID(), reader = crypto.randomUUID(), outsider = crypto.randomUUID();
  await sql`insert into auth.users(id) values (${admin}), (${reader}), (${outsider})`;
  users.add(reader); users.add(outsider); users.add(admin);
  const [{ actor }] = await sql`select fabrik_private.provision_first_administrator(${admin}::uuid, 'Worker test administrator') as actor`;
  const [{ scope }] = await sql`insert into fabrik.scope(code, display_name, description, created_by) values ('worker_test', 'Worker test', 'Stand-in fixture', ${actor}) returning scope_id as scope`;
  const [{ agent }] = await sql`select fabrik_private.provision_actor(${actor}::uuid, ${reader}::uuid, 'Worker test reader', 'agent', ${actor}::uuid, 'restricted', false) as agent`;
  await sql`select fabrik_private.provision_actor(${actor}::uuid, ${outsider}::uuid, 'Worker test outsider', 'agent', ${actor}::uuid, 'restricted', false)`;
  await sql`select fabrik_private.provision_grant(${actor}::uuid, gen_random_uuid(), ${agent}::uuid, ${scope}::uuid, array['activity'], null::uuid, array['read'], null::timestamptz, 'Worker test read')`;
  await sql`select vault.create_secret(${SECRET}, 'file_search_worker_secret'), vault.create_secret(${Deno.env.get("SUPABASE_URL")!}, 'file_search_project_url')`;

  await sql`insert into storage.objects(bucket_id, name, owner_id, metadata) values ('worker_test', 'prices.pdf', ${admin}, '{"eTag":"w1"}')`;
  await sql`select file_search.dispatch()`;
  const [first] = await sql`select body, headers from net.calls order by id desc limit 1`;
  const [firstCall] = await sql`select call_id from file_search.worker_call order by call_id desc limit 1`;
  check("while a file waits, the dispatcher asks the worker to take text, with the worker secret and its call's id",
    first?.body?.job === "extract" && first?.headers.Authorization === `Bearer ${SECRET}` && first?.body?.call == firstCall?.call_id, { first, firstCall });

  // The database's connections before the worker first runs. A moment after a run ends, they are as many again,
  // and none is the worker's.
  const connections = async () => (await sql`select count(*)::int as n from pg_stat_activity where datname = current_database()`)[0].n as number;
  const connectionsBefore = await connections();
  const settled = async () => {
    let n = 0;
    for (let tries = 0; tries < 50; tries++) {
      n = await connections();
      if (n === connectionsBefore) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    return n;
  };
  const wrong = await work("not-the-secret", "extract");
  check("a call without the worker secret is refused", wrong.status === 401, await wrong.text());

  const extracted = await (await work(SECRET, "extract", first.body.call)).json();
  check("the worker takes the PDF's text as two chunks", extracted.files?.[0]?.outcome === "extracted" && extracted.files[0].chunks === 2, extracted);
  const claimed = await sql`select v.name, k.recorded_at is not null as recorded from file_search.worker_claim k
    join file_search.file_version v on v.version_id = k.version_id where k.call_id = ${first.body.call}`;
  check("the worker records the file it takes against its call, and closes the claim with its outcome",
    claimed.length === 1 && claimed[0].name === "prices.pdf" && claimed[0].recorded, claimed);

  await sql`select file_search.dispatch()`;
  const [second] = await sql`select body from net.calls order by id desc limit 1`;
  check("with chunks waiting, the dispatcher asks the worker, separately, to make vectors", second?.body?.job === "embed", second);
  const [{ again }] = await sql`select file_search.dispatch() as again`;
  check("while its calls are unanswered and recent, the dispatcher starts no second run of either job", again === 0, again);
  const embedded = await (await work(SECRET, "embed")).json();
  check("the worker makes both vectors, recording each as it goes", embedded.chunks?.embedded === 2 && embedded.chunks.failed === 0, embedded);
  const after = await settled();
  check("each worker run closes its database connection when it ends", after === connectionsBefore, { connectionsBefore, after });
  const [{ calls }] = await sql`select file_search.dispatch() as calls`;
  check("with no work left, the dispatcher calls nobody", calls === 0, calls);

  const byWords = await (await ask(reader, "bedding")).json();
  check("the reader finds the bedding page by its words", byWords.hits?.[0]?.place === "page 1" && byWords.hits[0].found.includes("words"), byWords);
  const byMeaning = await (await ask(reader, "carriage fees")).json();
  check("the reader finds the delivery page by its meaning alone",
    byMeaning.hits?.[0]?.place === "page 2" && JSON.stringify(byMeaning.hits[0].found) === '["meaning"]' && byMeaning.degraded === null, byMeaning);
  const outside = await (await ask(outsider, "bedding")).json();
  check("an actor without read permission finds nothing", Array.isArray(outside.hits) && outside.hits.length === 0, outside);
  const forged = await ask("not-a-user", "bedding");
  check("a sign-in Supabase Auth does not confirm is refused", forged.status === 401, await forged.text());

  const asText = await askWith(reader, { query: "bedding", limit: "1" });
  const asTextBody = await asText.json();
  check("a limit sent as text is read as its number", asText.status === 200 && asTextBody.hits?.length === 1, asTextBody);
  const fraction = await askWith(reader, { query: "bedding", limit: 2.5 });
  check("a limit that is not a whole number from 1 to 50 is refused before searching", fraction.status === 400, await fraction.text());
  const tooLong = await askWith(reader, { query: "x".repeat(1001) });
  const tooLongBody = await tooLong.json();
  check("the database's refusal of a question comes back as a bad request, with its reason",
    tooLong.status === 400 && /1 through 1000 characters/.test(tooLongBody.problem), tooLongBody);

  await sql`insert into storage.objects(bucket_id, name, owner_id, metadata) values ('worker_test', 'guide.md', ${admin}, '{"eTag":"g1"}')`;
  const guideTaken = await (await work(SECRET, "extract")).json();
  await work(SECRET, "embed");
  const middle = await (await ask(reader, "zanzibar")).json();
  const long = await (await ask(reader, "quartermaster")).json();
  const outsiderGuide = await (await ask(outsider, "zanzibar")).json();
  check("the worker takes a Markdown guide's text, split at its headings", guideTaken.files?.[0]?.outcome === "extracted", guideTaken);
  const [{ sections: guideSections }] = await sql`select count(*)::int as sections from file_search.section x join file_search.file_version v on v.version_id = x.version_id where v.name = 'guide.md'`;
  const [{ crossing }] = await sql`select count(*)::int as crossing from file_search.chunk c join file_search.file_version v on v.version_id = c.version_id
    where v.name = 'guide.md' and (c.section_ordinal is null or not exists(select 1 from file_search.section x where x.version_id = c.version_id and x.ordinal = c.section_ordinal))`;
  check("the guide is kept as its four sections, and every chunk names one of them", guideSections === 4 && crossing === 0, { guideSections, crossing });
  const seeing = middle.sections?.[middle.hits?.[0]?.section];
  check("a hit in the middle of a long section brings the whole section, from its first step to its last",
    middle.hits?.[0]?.place === "Guide › Seeing rows" && seeing?.place === "Guide › Seeing rows" && seeing.truncated === false
      && seeing.text.startsWith("## Seeing rows") && seeing.text.includes("1. Step 1") && seeing.text.includes("zanzibar") && seeing.text.includes("8. Step 8"),
    { hits: middle.hits, seeing });
  const places = (middle.sections ?? []).map((x: { file: string; place: string }) => `${x.file} ${x.place}`);
  check("each section comes back once, however many of its chunks are hits, and every hit names its section",
    places.length === new Set(places).size && middle.hits.every((h: { section: number; file: string; place: string }) =>
      middle.sections[h.section]?.file === h.file && middle.sections[h.section]?.place === h.place), { hits: middle.hits, places });
  // The embed job makes each sentence's vector once the guide's chunks have theirs, and an explained
  // search gives every hit's sentences, each placed in its section's text, with its similarity.
  type Sentence = { start: number; end: number; similarity: number };
  type Hit = { file: string; place: string; section: number; chunk: { start: number; end: number } | null; sentences?: Sentence[] };
  let sentenceRuns = 0, sentencesEmbedded = 0;
  for (; sentenceRuns < 200; sentenceRuns++) {
    const run = await (await work(SECRET, "embed")).json();
    sentencesEmbedded += run.sentences?.embedded ?? 0;
    const [{ more }] = await sql`select file_search.has_work('embed') as more`;
    if (!more) break;
  }
  const [{ sentencesWaiting }] = await sql`select count(*)::int as "sentencesWaiting" from file_search.chunk_sentence s join file_search.file_version v on v.object_id = s.object_id where v.name = 'guide.md' and s.state <> 'embedded'`;
  check("the embed job makes the guide's sentence vectors after its chunks', and leaves none waiting", sentencesEmbedded > 0 && sentencesWaiting === 0, { sentencesEmbedded, sentencesWaiting, sentenceRuns });
  const explained = await (await askWith(reader, { query: "zanzibar", explain: true })).json();
  const allHits: Hit[] = [...explained.reference_hits, ...explained.hits];
  const sentenceText = (h: Hit, x: Sentence) => Array.from(explained.sections[h.section].text as string).slice(x.start, x.end).join("");
  const zanzibar = allHits.find((h) => h.sentences?.some((x) => sentenceText(h, x).includes("zanzibar")));
  check("an explained search gives every placed hit's sentences, within its chunk, each with its similarity",
    typeof explained.explain_ms === "number" && explained.stages.awaiting_sentence_vector === 0 && zanzibar !== undefined
      && allHits.every((h) => !h.chunk || (h.sentences!.length > 0 && h.sentences!.every((x) =>
        x.start >= h.chunk!.start && x.end <= h.chunk!.end && x.similarity >= 0 && x.similarity <= 1 && sentenceText(h, x).trim() === sentenceText(h, x)))),
    { explain_ms: explained.explain_ms, hits: allHits.map((h) => ({ chunk: h.chunk, sentences: (h.sentences ?? []).map((x) => [sentenceText(h, x), x.similarity]) })) });
  check("an explained search's hits are the plain search's, in the same order, and a plain search gives no sentences",
    JSON.stringify(explained.hits.map((h: Hit) => h.place)) === JSON.stringify(middle.hits.map((h: Hit) => h.place))
      && !("explain_ms" in middle) && middle.hits.every((h: Hit) => !("sentences" in h)), { explained: explained.hits, plain: middle.hits });
  const notBoolean = await askWith(reader, { query: "zanzibar", explain: "yes" });
  check("explain that is not true or false is refused before searching", notBoolean.status === 400, await notBoolean.text());
  const longest = long.sections?.find((x: { place: string }) => x.place === "Guide › Long");
  check("a section longer than a search returns whole comes back cut, and says so", longest?.truncated === true && longest.text.length < guideText.length, longest && { length: longest.text.length, truncated: longest.truncated });
  check("an actor without read permission gets neither the hits nor the sections",
    Array.isArray(outsiderGuide.hits) && outsiderGuide.hits.length === 0 && Array.isArray(outsiderGuide.sections) && outsiderGuide.sections.length === 0, outsiderGuide);
  const guideGone = await purgeAs(admin, "worker_test", "guide.md");
  const [{ sectionsLeft }] = await sql`select count(*)::int as "sectionsLeft" from file_search.section x join file_search.file_version v on v.version_id = x.version_id where v.name = 'guide.md'`;
  check("deleting the guide for good takes its sections with its chunks", guideGone.status === 200 && sectionsLeft === 0, { status: guideGone.status, sectionsLeft });

  // The graph: an actor's agent lists the chunks waiting, saves each one's entities and relations,
  // and the worker's graph job makes the entities' vectors. A question near the supplier then
  // reaches the delivery page, two steps away, through the bedding.
  const asUser = <T>(user: string, run: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: "authenticated" })}, true)`;
    await tx`set local role authenticated`;
    return run(tx);
  });
  // The glossary's classes and relationships, which the agent extracts with.
  await sql`insert into fabrik.scope(code, display_name, description, created_by) values ('reference', 'Reference', 'Stand-in fixture', ${actor})`;
  await asUser(admin, async (tx) => {
    for (const [term, definition] of [["Supplier", "A business the business buys from."], ["Product", "A thing the business sells."], ["Charge", "A sum added to an order."]])
      await tx`select fabrik.fabrik_save_term(${term}, 'class', ${definition}, 'Stand-in fixture')`;
    await tx`select fabrik.fabrik_save_term('packs', 'relationship', 'Puts into its packaging.', 'Stand-in fixture', '{}', 'Supplier', 'Product')`;
    await tx`select fabrik.fabrik_save_term('applies to', 'relationship', 'Is added to the price of.', 'Stand-in fixture', '{}', 'Charge', 'Product')`;
  });
  const waiting = await asUser(admin, async (tx) => (await tx`select fabrik.fabrik_get_unextracted('Worker test', 50) as r`)[0].r);
  check("the chunks waiting for their graph come with the glossary's classes and relationships",
    JSON.stringify(waiting.classes) === JSON.stringify(["Charge", "Product", "Supplier"]) && waiting.relationships?.length === 2, waiting);
  const pricePages = (waiting.chunks ?? []).filter((c: Record<string, string>) => c.file === "prices.pdf");
  check("an actor's agent lists the price list's two pages as waiting for their graph", pricePages.length === 2, waiting);
  const page = (place: string) => pricePages.find((c: Record<string, string>) => c.place === place)?.chunk_id;
  const saved = await asUser(admin, async (tx) => [
    (await tx`select fabrik.fabrik_save_extraction(${page("page 1")}::uuid, ${JSON.stringify([
      { name: "Northfield Packaging", type: "Supplier", description: "Northfield Packaging makes the bags." },
      { name: "Spring bedding", type: "Product", description: "Bedding on the wholesale price list." }])}::text::jsonb, ${JSON.stringify([
      { source: "Northfield Packaging", target: "Spring bedding", relationship: "packs", description: "Northfield Packaging packs the spring bedding." }])}::text::jsonb) as r`)[0].r,
    (await tx`select fabrik.fabrik_save_extraction(${page("page 2")}::uuid, ${JSON.stringify([
      { name: "spring  bedding", type: "product", description: "Ordered in small amounts." },
      { name: "Delivery charge", type: "Charge", description: "Applies to small orders." }])}::text::jsonb, ${JSON.stringify([
      { source: "Delivery charge", target: "Spring bedding", relationship: "applies to", description: "A delivery charge applies to small bedding orders." }])}::text::jsonb) as r`)[0].r]);
  const [{ bedding }] = await sql`select count(*)::int as bedding from file_search.entity where name_key = 'spring bedding'`;
  check("each page's entities and relations are saved, and the bedding named on both merges into one entity",
    saved[0].saved && saved[1].saved && bedding === 1 && !("merged" in saved[1]), { saved, bedding });
  const [{ graphCalls }] = await sql`select file_search.dispatch() as "graphCalls"`;
  const [graphCall] = await sql`select body from net.calls where body::jsonb->>'job' = 'graph' order by id desc limit 1`;
  check("with entities waiting for their vectors, the dispatcher asks the worker for its graph job", graphCalls >= 1 && graphCall?.body?.job === "graph", { graphCalls, graphCall });
  const graphed = await (await work(SECRET, "graph")).json();
  check("the worker makes the three entities' vectors", graphed.entities?.embedded === 3 && graphed.entities.failed === 0, graphed);
  const byGraph = await (await ask(reader, "which supplier")).json();
  const deliveryHit = byGraph.hits?.find((h: Record<string, unknown>) => h.place === "page 2");
  check("a reader's question near the supplier finds the delivery page by the graph, naming the charge two steps away",
    (deliveryHit?.found ?? []).includes("graph") && deliveryHit.entities?.some((e: Record<string, unknown>) => e.name === "Delivery charge" && e.steps === 2), byGraph);
  const outsideGraph = await (await ask(outsider, "which supplier")).json();
  check("an actor without read permission finds nothing by the graph", outsideGraph.hits?.length === 0 && outsideGraph.stages?.graph === 0, outsideGraph);

  // Asked how the search found its answer, the agent searches again with explain, into a result
  // file, and draws it with the fabrik plugin's draw_search, run here as the fabrik command runs it in an agent folder.
  for (let runs = 0; runs < 50; runs++) {
    await work(SECRET, "embed");
    const [{ more }] = await sql`select file_search.has_work('embed') as more`;
    if (!more) break;
  }
  const whyGraph = await (await askWith(reader, { query: "which supplier", explain: true })).json();
  const agentFolder = await Deno.makeTempDir({ prefix: "fabrik-search-page-" });
  await Deno.writeTextFile(`${agentFolder}/search.json`, JSON.stringify(whyGraph, null, 1));
  const drew = await new Deno.Command("node", { args: [new URL("../../plugins/fabrik/cli/fabrik.mjs", import.meta.url).pathname, "draw_search", "search_file=search.json", "question=which supplier"],
    cwd: agentFolder, stdout: "piped", stderr: "piped" }).output();
  const drawn = drew.code === 0 ? JSON.parse(new TextDecoder().decode(drew.stdout)) : { problem: new TextDecoder().decode(drew.stderr) };
  console.log(`  fabrik draw_search printed: ${drawn.output ?? drawn.problem}`);
  const searchOutline = drawn.outline_file ? await Deno.readTextFile(drawn.outline_file) : "";
  for (const line of searchOutline.split("\n").filter((l) => /^(# Search|Words found|## \d|Fusion score|Sentences shaded|Entities|- Start|- Step)/.test(l))) console.log(`    | ${line}`);
  const searchPage = drawn.file ? await Deno.readTextFile(drawn.file) : "";
  const searchData = JSON.parse(searchPage.match(/<script[^>]*id="search-data"[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? "{}");
  const deliveryCard = (searchData.cards ?? []).find((c: { place: string }) => c.place === "page 2");
  check("draw_search draws the explained search as a page: the question, each hit's card with its ranks and similarity, its shaded sentences, and the graph walk to the delivery charge",
    drew.code === 0 && drawn.findings === 0 && searchData.question === "which supplier" && searchData.explained === true
      && (searchData.cards ?? []).length === (whyGraph.hits.length + whyGraph.reference_hits.length)
      && deliveryCard?.found.includes("graph") && typeof deliveryCard?.ranks?.graph === "number" && deliveryCard?.sentences.length > 0
      && searchData.graph.nodes.some((n: { name: string; seed: boolean }) => n.seed) && searchData.graph.nodes.some((n: { name: string }) => n.name === "Delivery charge")
      && searchData.graph.edges.length === whyGraph.stages.graph_walk.length && /^Findings: none$/m.test(searchOutline),
    { drawn, cards: searchData.cards, graph: searchData.graph });
  await Deno.remove(agentFolder, { recursive: true });

  await sql`insert into storage.objects(bucket_id, name, owner_id, metadata) values ('worker_test', 'during-an-outage.pdf', ${admin}, '{"eTag":"o1"}')`;
  const outage = await purgeAs(admin, "worker_test", "during-an-outage.pdf");
  const outageBody = await outage.json();
  const [{ still }] = await sql`select count(*)::int as still from storage.objects where name = 'during-an-outage.pdf'`;
  check("a Storage outage during a purge is a fault, not a refusal, and nothing is deleted",
    outage.status === 502 && still === 1 && !/did not delete|refus/i.test(outageBody.problem ?? ""), { status: outage.status, outageBody, still });
  const notTheirs = await purgeAs(reader, "worker_test", "prices.pdf");
  const [{ kept }] = await sql`select count(*)::int as kept from file_search.chunk c join storage.objects o on o.id = c.object_id where o.name = 'prices.pdf'`;
  check("an actor who may only read a file cannot purge it, and its text is kept", notTheirs.status === 403 && kept === 2, { status: notTheirs.status, kept });
  const theirs = await purgeAs(admin, "worker_test", "prices.pdf");
  const theirsBody = await theirs.json();
  const [{ left }] = await sql`select count(*)::int as left from storage.objects where name = 'prices.pdf'`;
  const [{ states }] = await sql`select string_agg(distinct v.state, ',') as states from file_search.file_version v
    where v.bucket_id = 'worker_test' and v.name = 'prices.pdf'`;
  check("an administrator, who may delete in every scope, purges it: the file, its text and its embeddings go, and its record stays",
    theirs.status === 200 && theirsBody.chunks_deleted === 2 && left === 0 && states === "purged", { theirsBody, left, states });
  const gone = await (await ask(reader, "bedding")).json();
  check("a purged file is found no more", Array.isArray(gone.hits) && gone.hits.length === 0, gone);
  const [{ entitiesLeft }] = await sql`select count(*)::int as "entitiesLeft" from file_search.entity where name_key in ('northfield packaging', 'spring bedding', 'delivery charge')`;
  check("purging the price list deletes the entities and relations only it supported", entitiesLeft === 0, entitiesLeft);
  const missing = await purgeAs(admin, "worker_test", "no-such-file.pdf");
  check("purging a file that is not there says so", missing.status === 404, await missing.text());

  // The glossary terms saved above are records, queued for their text and vectors. The worker takes them first, run by
  // run until neither job has work, so the catalogue's runs below are the catalogue's alone.
  const drain = async (job: string) => {
    for (let run = 0; run < 50; run++) {
      await work(SECRET, job);
      const [{ more }] = await sql`select file_search.has_work(${job}) as more`;
      if (!more) return true;
    }
    return false;
  };
  const drained = await drain("extract") && await drain("embed");
  check("before the catalogue lands, the worker has taken every waiting text and vector", drained, drained);
  await sql`insert into storage.objects(bucket_id, name, owner_id, metadata) values ('worker_test', 'catalogue.pdf', ${admin}, '{"eTag":"c1"}')`;
  // The worker runs until the catalogue's chunks are there, at most 10 runs.
  const pages: { files?: { file: string; chunks?: number }[]; continued?: boolean }[] = [];
  let catalogueChunks = 0;
  for (let run = 0; run < 10 && catalogueChunks === 0; run++) {
    pages.push(await (await work(SECRET, "extract")).json());
    [{ n: catalogueChunks }] = await sql`select count(*)::int as n from file_search.chunk c join storage.objects o on o.id = c.object_id
      where o.bucket_id = 'worker_test' and o.name = 'catalogue.pdf'`;
  }
  const catalogueText = pages.flatMap((p) => p.files ?? []).find((f) => f.file === "worker_test/catalogue.pdf");
  check("the worker takes the catalogue's text as six chunks, in one run", catalogueText?.chunks === 6 && catalogueChunks === 6 && pages.length === 1, pages);
  modelMs = 400;
  // Two embed requests served by one instance: the first uses the instance's budget, and the second takes no row.
  const instance = await load("file-search-worker");
  const firstOfTwo = await (await workIn(instance, SECRET, "embed")).json();
  const [{ attempts: triedBefore }] = await sql`select sum(attempts)::int as attempts from file_search.chunk`;
  const [{ calls: callsBefore }] = await sql`select count(*)::int as calls from net.calls`;
  const secondOfTwo = await (await workIn(instance, SECRET, "embed")).json();
  const [{ attempts: triedAfter }] = await sql`select sum(attempts)::int as attempts from file_search.chunk`;
  const [{ calls: callsAfter }] = await sql`select count(*)::int as calls from net.calls`;
  check("an instance whose rows have used its budget takes no row on its next request, answers continued false and queues no run",
    firstOfTwo.chunks?.embedded + firstOfTwo.sentences?.embedded >= 1 && secondOfTwo.chunks?.embedded === 0 && secondOfTwo.sentences?.embedded === 0
      && secondOfTwo.continued === false && triedAfter === triedBefore && callsAfter === callsBefore, { firstOfTwo, secondOfTwo });
  const [{ before }] = await sql`select count(*)::int as before from net.calls`;
  const runs = [];
  for (let run = 0; run < 10; run++) {
    const got = await (await work(SECRET, "embed")).json();
    runs.push(got);
    if (!got.continued) break;
  }
  const queued = await sql`select body, headers from net.calls order by id offset ${before}`;
  check("with a slow model, a run stops on its time budget with passages or sentences waiting",
    runs[0]?.continued === true && runs[0].chunks.embedded + runs[0].sentences.embedded > 0, runs[0]);
  check("an instance starts no row after its rows have taken 900 ms: with a 400 ms model, no run embeds more than three passages, or two batches of two sentences",
    runs.length > 1 && runs.every((r) => r.chunks.embedded <= 3 && r.sentences.embedded <= 4), runs);
  check("each run that stops on its budget queues one more run of the same job, with the worker secret",
    queued.length === runs.filter((r) => r.continued).length && queued.length > 0
      && queued.every((q) => q.body?.job === "embed" && q.headers?.Authorization === `Bearer ${SECRET}`), { runs, queued });
  const tried = await sql`select c.state, c.attempts from file_search.chunk c join file_search.file_version v on v.version_id = c.version_id
    where v.name = 'catalogue.pdf'`;
  const triedSentences = await sql`select s.state, s.attempts from file_search.chunk_sentence s join file_search.file_version v on v.object_id = s.object_id
    where v.name = 'catalogue.pdf'`;
  check("the chain ends with every passage embedded, then each of their sentences, each after a single attempt",
    tried.length === 6 && tried.every((c) => c.state === "embedded" && c.attempts === 1) && triedSentences.length === 6
      && triedSentences.every((c) => c.state === "embedded" && c.attempts === 1) && runs.at(-1)?.continued === false, { runs, tried, triedSentences });
  check("the run that makes the last vector, a sentence's, queues no further run, even when it ends on its budget",
    runs.at(-1)?.continued === false && runs.at(-1)?.sentences.embedded > 0 && queued.length === runs.length - 1, { runs, queued });

  // pg_net's answers, as fabrik's project recorded a run Supabase stopped.
  const stopped = '{"code":"WORKER_RESOURCE_LIMIT","message":"Function failed due to not having enough compute resources (please check logs)"}';
  const pending = await sql`select request_id, job from file_search.worker_call where answered_at is null order by call_id`;
  const { request_id: failing } = pending.find((c) => c.job === "embed")!;
  // The failing run was at a catalogue passage when Supabase stopped it: claimed, with no vector.
  const [{ call_id: failingCall }] = await sql`select call_id from file_search.worker_call where request_id = ${failing}`;
  const [atStop] = await sql`update file_search.chunk c set state = 'waiting', attempts = 0, last_attempt_at = null, embedding = null
    from file_search.file_version v where v.version_id = c.version_id and v.name = 'catalogue.pdf' and c.ordinal = 1 returning c.chunk_id`;
  check("the catalogue's second passage is there, for the stopped run to be at", atStop !== undefined, atStop);
  await sql`select * from file_search.claim_chunks(1, ${failingCall})`;
  for (const { request_id } of pending)
    await sql`insert into net._http_response(id, status_code, content) values (${request_id},
      ${request_id === failing ? 546 : 200}, ${request_id === failing ? stopped : '{"ok":true}'})`;
  await sql`insert into file_search.worker_call(request_id, job, called_at) values (-1, 'extract', clock_timestamp() - interval '2 hours')`;
  await sql`select file_search.dispatch()`;
  const wentWrong = await sql`select request_id, job, status, problem from file_search.worker_call where answered_at is not null order by request_id`;
  check("the timer keeps each worker run that went wrong, with its status and reason, and forgets the rest",
    pending.length > 1 && wentWrong.length === 2
      && wentWrong[0].request_id == -1 && wentWrong[0].problem === "No answer was recorded"
      && wentWrong[1].request_id == failing && wentWrong[1].status === 546 && wentWrong[1].problem.includes("WORKER_RESOURCE_LIMIT"), { pending, wentWrong });
  const reported = await (await ask(reader, "garden furniture")).json();
  // The run with no answer claimed nothing, and a later extract run answered 200, so it no longer counts.
  const [succeeded] = await sql`select called_at > clock_timestamp() - interval '1 hour' as later from file_search.worker_success where job = 'extract'`;
  check("the timer records each job's latest success, and a failed run that claimed nothing drops out once a later run of its job succeeds",
    succeeded?.later === true && !(reported.stages?.worker_problems ?? []).some((p: { problem: string }) => p.problem === "No answer was recorded"), { succeeded, stages: reported.stages });
  check("every search reports how many worker runs went wrong in the last day", reported.stages?.failed_worker_runs === 1, reported.stages);
  const listed = (who: typeof reported) => (who.stages?.worker_problems ?? []).find((p: { status: number }) => p.status === 546);
  const adminSees = await (await ask(admin, "garden furniture")).json();
  check("every search lists each run that went wrong, with the file it was at when it stopped",
    adminSees.stages?.worker_problems?.length === 1 && listed(adminSees)?.job === "embed" && listed(adminSees)?.problem.includes("WORKER_RESOURCE_LIMIT")
      && listed(adminSees)?.files.length === 1 && listed(adminSees).files[0].bucket === "worker_test"
      && listed(adminSees).files[0].file === "catalogue.pdf" && listed(adminSees).files[0].in_flight === true, adminSees.stages);
  const outsiderSees = await (await ask(outsider, "garden furniture")).json();
  check("a user who cannot open the file sees the run, and not the file",
    listed(outsiderSees) !== undefined && listed(outsiderSees).files.length === 0, outsiderSees.stages);
  if (atStop) {
    await sql`select file_search.record_chunk_vector(${atStop.chunk_id}, ${`[${Array(384).fill(0.05).join(",")}]`}, null)`;
    const healed = await (await ask(admin, "garden furniture")).json();
    check("a stopped run whose passage was embedded drops out of every search",
      healed.stages?.failed_worker_runs === 0 && healed.stages?.worker_problems?.length === 0, healed.stages);
    await sql`update file_search.chunk set state = 'waiting', embedding = null where chunk_id = ${atStop.chunk_id}`;
    await sql`update file_search.chunk set attempts = 5, last_attempt_at = clock_timestamp() - interval '10 minutes' where chunk_id = ${atStop.chunk_id}`;
    await sql`select file_search.dispatch()`;
    const [named] = await sql`select state, error from file_search.chunk where chunk_id = ${atStop.chunk_id}`;
    check("a passage that fails after five attempts names the run that took it and went wrong",
      named?.state === "failed" && named.error.startsWith("No answer after five attempts. The last run that took it and went wrong")
        && named.error.includes("546") && named.error.includes("WORKER_RESOURCE_LIMIT"), named);
    const [exhausted] = await sql`update file_search.chunk c set state = 'waiting', attempts = 5, last_attempt_at = clock_timestamp() - interval '10 minutes', embedding = null
      from file_search.file_version v where v.version_id = c.version_id and v.name = 'catalogue.pdf' and c.ordinal = 0 returning c.chunk_id`;
    await sql`select file_search.dispatch()`;
    const [given] = await sql`select state, error from file_search.chunk where chunk_id = ${exhausted.chunk_id}`;
    check("a passage no run claimed that fails after five attempts carries the reason its job's last failed run gave",
      given?.state === "failed" && given.error.startsWith("No answer after five attempts. The last embed run that went wrong")
        && given.error.includes("546") && given.error.includes("WORKER_RESOURCE_LIMIT"), given);
  }

  // An OpenDocument spreadsheet is read sheet by sheet; a type fabrik does not read says why.
  modelMs = 0;
  await sql`insert into storage.objects(bucket_id, name, owner_id, metadata) values ('worker_test', 'stock.ods', ${admin}, '{"eTag":"o1"}'), ('worker_test', 'notes.pages', ${admin}, '{"eTag":"p1"}')`;
  const taken = [];
  for (let run = 0; run < 5; run++) {
    const got = await (await work(SECRET, "extract")).json();
    taken.push(...(got.files ?? []));
    if (!got.continued) break;
  }
  const outcome = (name: string) => taken.find((f: { file: string }) => f.file === `worker_test/${name}`)?.outcome;
  check("the worker reads an OpenDocument spreadsheet, and finds a Pages file unsupported",
    outcome("stock.ods") === "extracted" && outcome("notes.pages") === "unsupported", taken);
  const marmalade = await (await ask(reader, "marmalade")).json();
  check("a word on an OpenDocument spreadsheet's second sheet finds it, placed at that sheet",
    (marmalade.hits ?? []).some((h: { file: string; place: string; found: string[] }) =>
      h.file === "stock.ods" && h.place === "sheet Stock" && h.found.includes("words")), marmalade.hits);
  const unread = (marmalade.stages?.unreadable ?? []).find((u: { file: string }) => u.file === "notes.pages");
  check("every search lists the file it cannot read, with the reason, to a reader who can open it",
    marmalade.stages?.unsupported === 1 && unread?.state === "unsupported" && unread.error.startsWith("fabrik reads PDF, .xlsx, .xls, .ods"), marmalade.stages);
  const outsiderList = await (await ask(outsider, "marmalade")).json();
  check("an actor without read permission is not told of the file", outsiderList.stages?.unreadable?.length === 0, outsiderList.stages);

  // The second factor, set to administrators: the administrator's password-only sign-in finds nothing and purges
  // nothing, and the same administrator's sign-in with a code finds and purges. file-search and file-search-purge pass
  // the sign-in's level to fabrik.
  await sql`update fabrik_private.sign_in_setting set second_factor = 'administrators'`;
  try {
    const passwordSearch = await (await ask(admin, "marmalade")).json();
    const codeSearch = await (await askWith(coded(admin), { query: "marmalade" })).json();
    check("with the second factor set, file-search finds nothing for the administrator's password-only sign-in",
      Array.isArray(passwordSearch.hits) && passwordSearch.hits.length === 0, passwordSearch.hits);
    check("and file-search finds the file for the same administrator's sign-in with a code",
      (codeSearch.hits ?? []).some((h: { file: string }) => h.file === "stock.ods"), codeSearch.hits);
    const passwordPurge = await purgeAs(admin, "worker_test", "stock.ods");
    const passwordBody = await passwordPurge.json();
    const codePurge = await purgeAs(coded(admin), "worker_test", "stock.ods");
    const codeBody = await codePurge.json();
    check("file-search-purge turns away the administrator's password-only sign-in, and the file stays",
      passwordPurge.status === 404 && passwordBody.problem === "No file stock.ods in worker_test that this user may open.", { status: passwordPurge.status, body: passwordBody });
    check("and file-search-purge purges it for the same administrator's sign-in with a code",
      codePurge.status === 200 && codeBody.chunks_deleted > 0, { status: codePurge.status, body: codeBody });
  } finally {
    await sql`update fabrik_private.sign_in_setting set second_factor = 'off'`;
  }

  // Records. The owner saves a note in a scope of its own; the worker takes its version's text, its title and each
  // payload value on its own line, and makes its vector, as for a file. The owner finds it by a word of its payload and,
  // through the fixed model, by a question that shares no word with it but its meaning; the reader, with read only in
  // worker_test, and the outsider find nothing. A second version is found, and the first no more; a deleted record is
  // found no more.
  await sql`insert into fabrik.scope(code, display_name, description, created_by) values ('record_test', 'Record test', 'Stand-in fixture', ${actor})`;
  const [{ recordScope }] = await sql`select scope_id as "recordScope" from fabrik.scope where code = 'record_test'`;
  const note = crypto.randomUUID();
  const saveNote = (previous: string | null, payload: Record<string, unknown>) => asUser(admin, async (tx) => (await tx`select fabrik.fabrik_save_version(${JSON.stringify({
    request_id: crypto.randomUUID(), record_id: note, scope_id: recordScope, kind: "evidence", expected_previous_version_id: previous,
    title: "Courier notes", reason: "Record search check", links: [], payload })}::text::jsonb) as v`)[0].v);
  const firstNote = await saveNote(null, { summary: "Parcels for the zephyrine range leave on Tuesdays", source_reference: null, source_date: "2026-11-01",
    standing: "observed", limitations: "Delivery to the islands takes two days more" });
  const [queuedNote] = await sql`select state, body from file_search.file_version where record_version_id = ${firstNote.version_id}`;
  check("a saved version is queued with its title, then each payload value on its own line",
    queuedNote?.state === "waiting" && queuedNote.body === "Courier notes\nsummary: Parcels for the zephyrine range leave on Tuesdays\nstanding: observed\nlimitations: Delivery to the islands takes two days more\nsource_date: 2026-11-01",
    { firstNote, queuedNote });
  /** Runs the extract job, then the embed job, until neither has work, each run with its call as the schedule makes it.
   * Gives each run that did not answer 200, with its answer or its error. */
  const settle = async () => {
    const wrong: string[] = [];
    for (const job of ["extract", "embed"]) for (let runs = 0; runs < 50; runs++) {
      const [{ request }] = await sql`select file_search.call_worker(${job}) as request`;
      const [{ call_id }] = await sql`select call_id from file_search.worker_call where request_id = ${request}`;
      try {
        const answer = await work(SECRET, job, Number(call_id));
        if (answer.status !== 200) wrong.push(`${job} ${answer.status}: ${await answer.text()}`);
      } catch (err) {
        wrong.push(`${job}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      const [{ more }] = await sql`select file_search.has_work(${job}) as more`;
      if (!more) break;
    }
    return wrong;
  };
  const firstRuns = await settle();
  const noteClaims = await sql`select k.record_id, k.object_id, k.recorded_at is not null as recorded from file_search.worker_claim k
    join file_search.chunk c on c.chunk_id = k.chunk_id where c.record_id = ${note}`;
  check("each run of the record's text and vector, with its call, answers 200, and its chunk's claim names the record and is closed",
    firstRuns.length === 0 && noteClaims.length === 1 && noteClaims[0].record_id === note && noteClaims[0].object_id === null && noteClaims[0].recorded,
    { firstRuns, noteClaims });
  const [readNote] = await sql`select v.state, v.body, count(c.*)::int as chunks, count(c.embedding)::int as vectors
    from file_search.file_version v left join file_search.chunk c on c.version_id = v.version_id where v.record_version_id = ${firstNote.version_id} group by v.state, v.body`;
  check("the worker takes the version's text from the database as one chunk, makes its vector, and keeps no copy of the text on the queue",
    readNote?.state === "extracted" && readNote.chunks === 1 && readNote.vectors === 1 && readNote.body === null, readNote);
  type RecordHit = { bucket: string; file: string; found: string[]; record_id?: string; version_number?: number };
  const noteHits = (r: { hits?: RecordHit[] }) => (r.hits ?? []).filter((h) => h.record_id === note);
  const byPayloadWord = await (await ask(admin, "zephyrine")).json();
  const wordHit = noteHits(byPayloadWord)[0];
  console.log(`  {"query": "zephyrine"} as the owner returned ${JSON.stringify(noteHits(byPayloadWord))}`);
  check("the owner finds the record's version by a word of its payload, with its record_id and version_number beside its scope and title",
    wordHit?.found.includes("words") && wordHit.version_number === 1 && wordHit.bucket === "record_test" && wordHit.file === "Courier notes", byPayloadWord.hits);
  const byParaphrase = await (await ask(admin, "postage times")).json();
  const meaningHit = noteHits(byParaphrase)[0];
  console.log(`  {"query": "postage times"} as the owner returned ${JSON.stringify(noteHits(byParaphrase))}`);
  check("the owner finds it by a question sharing no word with it, by meaning alone (the stand-in's fixed model puts delivery and postage together)",
    JSON.stringify(meaningHit?.found) === '["meaning"]' && meaningHit.version_number === 1, byParaphrase.hits);
  const readerNote = await (await ask(reader, "zephyrine")).json();
  const outsiderNote = await (await ask(outsider, "zephyrine")).json();
  const readerMeaning = await (await ask(reader, "postage times")).json();
  check("an actor without read on the record's scope finds it neither by its words nor by its meaning, and gets none of its text",
    noteHits(readerNote).length === 0 && noteHits(outsiderNote).length === 0 && noteHits(readerMeaning).length === 0
      && !JSON.stringify([readerNote.sections, outsiderNote.sections, readerMeaning.sections]).includes("zephyrine"), { readerNote, outsiderNote });

  const secondNote = await saveNote(firstNote.version_id, { summary: "Parcels for the quokka range leave on Thursdays", source_reference: null, source_date: "2026-11-08",
    standing: "observed", limitations: "None" });
  const beforeRead = await (await ask(admin, "zephyrine")).json();
  check("once a second version is saved, the first is found no more, even before the worker reads the second",
    noteHits(beforeRead).length === 0, beforeRead.hits);
  const secondRuns = await settle();
  check("each run of the second version's text and vector, with its call, answers 200", secondRuns.length === 0, { secondRuns });
  const oldWord = await (await ask(admin, "zephyrine")).json();
  const newWord = await (await ask(admin, "quokka")).json();
  console.log(`  after version 2, {"query": "quokka"} returned ${JSON.stringify(noteHits(newWord))}, and {"query": "zephyrine"} ${JSON.stringify(noteHits(oldWord))}`);
  // The fixed model ranks every chunk by meaning, so the first version's word may still bring version 2 by meaning.
  check("the second version is found by its own words, as version 2, and the first version's words find no hit in version 1 and no hit by words",
    noteHits(newWord)[0]?.version_number === 2 && noteHits(newWord)[0].found.includes("words") && secondNote.version_number === 2
      && noteHits(oldWord).every((h) => h.version_number === 2 && !h.found.includes("words"))
      && !JSON.stringify([...(oldWord.hits ?? []), ...(oldWord.sections ?? [])]).includes("zephyrine"), { newWord: newWord.hits, oldWord: oldWord.hits });

  // A move: the reader is given read on record_test, and finds the note; once the owner moves it to record_moved, where
  // the reader has no grant, the reader finds it no more, and the owner finds it in its new scope.
  await sql`insert into fabrik.scope(code, display_name, description, created_by) values ('record_moved', 'Record moved', 'Stand-in fixture', ${actor})`;
  await sql`select fabrik_private.provision_grant(${actor}::uuid, gen_random_uuid(), ${agent}::uuid, ${recordScope}::uuid, array['evidence'], null::uuid, array['read'], null::timestamptz, 'Record search check')`;
  const readerBefore = await (await ask(reader, "quokka")).json();
  const moved = await asUser(admin, async (tx) => {
    const [{ preview }] = await tx`select fabrik.fabrik_preview_move(array[${note}::text], 'record_moved', 'Record search check') as preview`;
    return (await tx`select fabrik.fabrik_move_records(${JSON.stringify(preview)}::text::jsonb) as m`)[0].m;
  });
  const readerAfter = await (await ask(reader, "quokka")).json();
  const ownerAfter = await (await ask(admin, "quokka")).json();
  console.log(`  after the move, {"query": "quokka"} as the reader returned ${JSON.stringify(noteHits(readerAfter))}, and as the owner ${JSON.stringify(noteHits(ownerAfter).map((h) => [h.bucket, h.version_number]))}`);
  check("an actor with read on the record's scope finds it; once it moves to a scope it has no read on, it finds it no more, and the owner finds it in the new scope",
    noteHits(readerBefore)[0]?.bucket === "record_test" && !moved?.refused && noteHits(readerAfter).length === 0
      && noteHits(ownerAfter)[0]?.bucket === "record_moved" && noteHits(ownerAfter)[0].version_number === 2,
    { readerBefore: noteHits(readerBefore), moved, readerAfter: noteHits(readerAfter), ownerAfter: noteHits(ownerAfter) });

  const deletion = await asUser(admin, async (tx) => {
    const [{ preview }] = await tx`select fabrik.fabrik_preview_deletion(${note}::uuid) as preview`;
    const request = { ...preview.request, reason: "Record search check" };
    const [{ approval }] = await tx`select fabrik.fabrik_approve_change(gen_random_uuid(), ${actor}::uuid, ${JSON.stringify(request)}::text::jsonb,
      clock_timestamp() + interval '1 hour', 'Record search check') as approval`;
    return (await tx`select fabrik.fabrik_delete_record(${JSON.stringify(request)}::text::jsonb, ${approval.authorisation_id}::uuid) as d`)[0].d;
  });
  const deletedWord = await (await ask(admin, "quokka")).json();
  const [{ noteChunks }] = await sql`select count(*)::int as "noteChunks" from file_search.chunk where record_id = ${note}`;
  // No file_search row keeps the record's title or a word of its payload.
  const [{ kept: keptText }] = await sql`select (select count(*) from file_search.file_version where record_id = ${note} and (name <> 'Deleted' or body is not null))
    + (select count(*) from file_search.file_version where name ~* 'courier notes|quokka|zephyrine' or body ~* 'courier notes|quokka|zephyrine')
    + (select count(*) from file_search.chunk where record_id = ${note} or body ~* 'courier notes|quokka|zephyrine')
    + (select count(*) from file_search.section where record_id = ${note} or body ~* 'courier notes|quokka|zephyrine') as kept`;
  check("a deleted record is found no more, its text and vectors are deleted with it, and no file_search row keeps its title",
    typeof deletion?.deletion_id === "string" && noteHits(deletedWord).length === 0 && noteChunks === 0 && Number(keptText) === 0,
    { deletion, hits: deletedWord.hits, noteChunks, keptText });
} finally {
  await sql.end();
  await storageSql.end();
  await supabase.shutdown();
}
Deno.exit(failed ? 1 : 0);
