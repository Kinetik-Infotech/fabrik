// A routine written down and designed through fabrik's connector, as the business, interview and design skills save
// it, signed in as the owner: the business profile and its evidence, an interview's statements, the current state
// they support, an industry finding from the web, the purpose statement and a proposed design. Then the records
// skill's "The routine in force", run with the calls it names: with no design selected, it finds the confirmed
// current state; an open decision selects nothing; a made decision selects the design; a later change to the design
// stays out of force until it is selected; a switch to another option or a rejection takes effect though old links
// stay; a routine whose name holds the same words never counts; and a routine not done yet has no version in force. The Data API is answered here as fabrik-apps.ts answers it.
// run.sh runs it.
import postgres from "npm:postgres@3.4.9";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "npm:jose@6.2.17";

const DB = Deno.env.get("STAND_IN_DB")!;
const FUNCTION = new URL("../../setup/functions/fabrik-apps/index.ts", import.meta.url);

let failed = 0;
function check(what: string, ok: boolean, seen: unknown) {
  console.log(`${ok ? "ok" : "FAIL"} - ${what}${ok ? "" : `: ${JSON.stringify(seen)}`}`);
  if (!ok) failed++;
}
const sql = postgres(DB, { max: 4, prepare: false, onnotice() {} });

// The project's signing key, and a person's access token from it.
const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "stand-in", alg: "ES256", use: "sig" };
const tokenOf = (user: string) => new SignJWT({ role: "authenticated", aal: "aal1" })
  .setProtectedHeader({ alg: "ES256", kid: "stand-in" }).setSubject(user).setIssuedAt().setExpirationTime("10m").sign(privateKey);

// Supabase's Auth and Data API, as far as the record tools use them: a fabrik function called by name, with its
// arguments cast to the function's own types, as the token's user.
const api = Deno.serve({ port: 0, onListen() {} }, async (req) => {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  const path = new URL(req.url).pathname;
  let claims: { sub?: string; aal?: string };
  try { claims = (await jwtVerify(token, publicKey)).payload; }
  catch { return Response.json({ code: "PGRST301", message: "JWT could not be verified" }, { status: 401 }); }
  if (path === "/auth/v1/user") return Response.json({ id: claims.sub });
  const fn = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(path)?.[1];
  if (!fn || req.headers.get("Content-Profile") !== "fabrik") return Response.json({ code: "PGRST106", message: "The schema must be fabrik" }, { status: 406 });
  const body: Record<string, unknown> = await req.json().catch(() => ({}));
  const procs = await sql`select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes) t) as types
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'fabrik' and p.proname = ${fn}`;
  const matches = procs.filter((p) => Object.keys(body).every((k) => (p.names ?? []).includes(k)));
  if (matches.length !== 1) return Response.json({ code: "PGRST202", message: `No single fabrik.${fn} takes these arguments` }, { status: 404 });
  const proc = matches[0];
  const keys = Object.keys(body);
  const cast = (k: string, i: number) => {
    const type = proc.types[proc.names.indexOf(k)] as string;
    const value = `$${i + 1}::text::jsonb`;
    return type === "jsonb" || type === "json" ? `${value}::${type}`
      : type.endsWith("[]") ? `array(select jsonb_array_elements_text(${value}))::${type}`
      : `(${value} #>> '{}')::${type}`;
  };
  try {
    const [{ v }] = await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: claims.sub, role: "authenticated", aal: claims.aal })}, true)`;
      await tx`set local role authenticated`;
      return await tx.unsafe(`select fabrik.${fn}(${keys.map((k, i) => `${k} => ${cast(k, i)}`).join(", ")}) as v`, keys.map((k) => body[k] == null ? null : JSON.stringify(body[k])));
    });
    return Response.json(v);
  } catch (err) {
    const e = err as { code?: string; message: string; detail?: string; hint?: string };
    return Response.json({ code: e.code, message: e.message, details: e.detail ?? null, hint: e.hint ?? null }, { status: 400 });
  }
});
Deno.env.set("SUPABASE_URL", `http://127.0.0.1:${api.addr.port}`);
Deno.env.set("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
Deno.env.set("SUPABASE_ANON_KEY", "publishable-key");
Deno.env.set("SUPABASE_JWKS", JSON.stringify({ keys: [jwk] }));
Deno.env.set("SUPABASE_FUNCTION_SLUG", "fabrik-apps");
Deno.env.set("SUPABASE_DB_URL", DB);

// The connector's handler, taken in place of serving it.
type Handler = (req: Request) => Promise<Response>;
let handler: Handler | undefined;
const serve = Deno.serve;
(Deno as unknown as { serve: unknown }).serve = (h: Handler) => { handler = h; return { finished: Promise.resolve(), shutdown() {} }; };
await import(FUNCTION.href);
(Deno as unknown as { serve: unknown }).serve = serve;

let rpcId = 1;
// deno-lint-ignore no-explicit-any
type Answer = { content?: { text: string }[]; structuredContent?: any; isError?: boolean } | undefined;
/** One tool call to the connector, as Claude sends it, as the person whose token it carries. */
async function tool(token: string, name: string, args: Record<string, unknown>): Promise<Answer> {
  const res = await handler!(new Request("http://127.0.0.1/fabrik-apps", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      "X-Forwarded-Host": "abcdefghijklmnopqrst.supabase.co", "X-Forwarded-Proto": "https", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  }));
  const text = await res.text();
  const json = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("") || text;
  const answer = JSON.parse(json)?.result as Answer;
  if (answer?.isError) throw new Error(`${name} was refused: ${answer.content?.[0]?.text}`);
  return answer;
}
// deno-lint-ignore no-explicit-any
const v = (r: Answer): any => r?.structuredContent;

try {
  const owner = crypto.randomUUID();
  await sql`insert into auth.users(id) values (${owner})`;
  const [{ actor }] = await sql`select fabrik_private.provision_first_administrator(${owner}::uuid, 'Sam Smith') as actor`;
  await sql`insert into fabrik.scope(code, display_name, description, created_by) select 'general', 'General', 'Stand-in fixture', ${actor}
    where not exists (select 1 from fabrik.scope where code = 'general')`;
  const token = await tokenOf(owner);
  const save = async (kind: string, title: string, fields: Record<string, unknown>, scope = "general") =>
    v(await tool(token, "save_record", { scope, kind, title, reason: "Routines stand-in", fields }));
  const change = async (record: string, fields: Record<string, unknown>) =>
    v(await tool(token, "save_record", { record, reason: "Routines stand-in", fields }));
  const link = async (record: string, links: { target: string; relation: string }[]) =>
    v(await tool(token, "link_records", { record, links, reason: "Routines stand-in" }));
  const get = async (record: string) => v(await tool(token, "get_record", { record }));
  const list = async (kind: string, title: string) => v(await tool(token, "list_records", { kind, title }))?.items ?? [];
  const evidence = (summary: string, standing: string, source_reference: string) =>
    ({ summary, standing, source_reference, source_date: "2026-11-17", limitations: "none" });

  // ---- The business skill: one answer, and the profile it supports ----
  await save("evidence", "Business profile: Smith Joinery: customers", evidence("Homeowners in Leeds who want fitted kitchens.", "stated", "Sam Smith, business profile"));
  await save("model", "Business profile: Smith Joinery", { model_kind: "observed_current", source_status: "stated, confirmed by Sam Smith",
    description: "A joinery business of three people in Leeds.", graph: { format_version: 1,
      nodes: [{ id: "b", type: "business", label: "Smith Joinery", attributes: { industry: "joinery", country: "United Kingdom", people: 3, stage: "established" } },
        { id: "c", type: "customer", label: "Homeowners in Leeds", attributes: {} }],
      edges: [{ id: "e1", source: "b", target: "c", type: "serves", attributes: {} }] } });
  await link("Business profile: Smith Joinery", [{ target: "Business profile: Smith Joinery: customers", relation: "supports" }]);
  const profiles = await list("model", "Business profile");
  const profile = await get("Business profile: Smith Joinery");
  check("the business skill's list_records finds the one profile, and get_record gives its business node's attributes and the answer it rests on",
    profiles.length === 1 && profile?.payload?.graph?.nodes?.find((n: { type: string }) => n.type === "business")?.attributes?.industry === "joinery"
      && profile.links.some((l: { relation: string; target_title: string }) => l.relation === "supports" && l.target_title === "Business profile: Smith Joinery: customers"),
    { profiles, profile });

  // ---- The business skill: an objective as its own decision, its scope, routine, outcome and measure in properties ----
  const objective = { question: "What does Smith Joinery want from invoicing?", alternatives: [], decision: "Be paid for every job within a month.",
    rationale: "\"I spend Fridays on the phone chasing money.\"", decided_on: "2026-11-17" };
  let refused = "";
  try { await save("decision", "Objective: paid within a month", { ...objective, outcome: "Paid within a month", measure: "Days from invoice to payment" }); }
  catch (err) { refused = (err as Error).message; }
  check("a decision with outcome and measure as fields of their own is refused, so the business skill puts them in properties",
    /unknown JSON fields/.test(refused), refused);
  const paid = { scope: "business", routine: "invoicing", outcome: "Every job paid within a month", measure: "Days from invoice to payment, under 30" };
  const kitchens = { scope: "business", routine: "quoting", outcome: "Half the jobs are kitchens", measure: "Kitchen jobs as a share of all jobs" };
  await save("decision", "Objective: paid within a month", { ...objective, properties: paid });
  await save("decision", "Objective: more kitchen work", { ...objective, decision: "Win more fitted-kitchen jobs.", properties: kitchens });
  await save("decision", "objective-review: purpose", { question: "Why does objective-review exist, and for whom?", alternatives: [],
    decision: "So Sam checks each objective every quarter.", rationale: "\"I forget what I set.\"", decided_on: "2026-11-17" });
  const found = await list("decision", "Objective");
  const objectives = found.filter((o: { title: string }) => o.title.startsWith("Objective: "));
  check("list_records with title Objective also finds another decision with the word in its title, and the business skill's filter keeps only the objectives",
    found.some((o: { title: string }) => o.title === "objective-review: purpose") && objectives.length === 2, found);

  // ---- The business skill's section 4: a new version replaces properties whole ----
  await change("Objective: more kitchen work", { properties: { measure: "Kitchen jobs as a share of all jobs, over half" } });
  const bare = await get("Objective: more kitchen work");
  check("a new version that sends properties with a new measure alone loses scope, routine and outcome, so the skill sends them again",
    bare.payload.properties?.measure?.endsWith("over half") && bare.payload.properties?.routine === undefined && bare.payload.properties?.scope === undefined, bare.payload);
  await change("Objective: paid within a month", { properties: { ...paid, measure: "Days from invoice to payment, under 21" } });

  // ---- The interview skill: two statements and the current state they support ----
  await save("evidence", "invoicing: sending the invoice", evidence("Sam types each invoice into a spreadsheet on Friday.", "stated", "Sam Smith, interview, invoicing"));
  await save("evidence", "invoicing: chasing a late payment", evidence("Sam phones a customer two weeks after the due date.", "stated", "Sam Smith, interview, invoicing"));
  const ROUTINE_GRAPH = (steps: string[], basis = "performed", label = "invoicing") => ({ format_version: 1,
    nodes: [{ id: "r", type: "routine", label, attributes: { basis } },
      ...steps.map((label, i) => ({ id: `s${i + 1}`, type: "activity", label, attributes: { reference: String(i + 1) } }))],
    edges: steps.map((_, i) => ({ id: `p${i + 1}`, source: `s${i + 1}`, target: "r", type: "part_of", attributes: {} })) });
  await save("model", "invoicing: current state", { model_kind: "observed_current", source_status: "stated, confirmed by Sam Smith",
    description: "Basis: performed. A finished job starts it.", graph: ROUTINE_GRAPH(["Type the invoice", "Chase a late payment"]) });
  await link("invoicing: current state", [{ target: "invoicing: sending the invoice", relation: "supports" },
    { target: "invoicing: chasing a late payment", relation: "supports" }]);

  // ---- The design skill: an industry finding, the purpose statement and the proposed design ----
  await save("evidence", "Industry knowledge: invoices sent on completion are paid sooner", evidence(
    "Industry knowledge, not your evidence: small trades firms that invoice on the day a job ends are paid sooner. https://www.gov.uk/invoicing-and-taking-payment-from-customers, read 2026-11-17.",
    "unverified", "https://www.gov.uk/invoicing-and-taking-payment-from-customers"));
  await link("Industry knowledge: invoices sent on completion are paid sooner", [{ target: "invoicing: current state", relation: "describes" }]);
  await save("decision", "invoicing: purpose", { question: "Why does invoicing exist, and for whom?", alternatives: [],
    decision: "Sam is paid for each job within a month, without chasing on the phone.", rationale: "Late payments leave Sam short of cash.", decided_on: "2026-11-17" });
  await save("model", "invoicing: proposed state", { model_kind: "proposed_target", source_status: "proposed",
    description: "Basis: from the current state. Claude drafts the invoice when a job ends, and Sam sends it.",
    graph: ROUTINE_GRAPH(["Claude drafts the invoice", "Sam sends it", "Claude drafts a reminder"]) });
  await link("invoicing: proposed state", [{ target: "invoicing: current state", relation: "describes" },
    { target: "invoicing: purpose", relation: "supports" },
    { target: "Industry knowledge: invoices sent on completion are paid sooner", relation: "supports" }]);

  const currentRead = await get("invoicing: current state");
  const standings = await Promise.all(currentRead.links.filter((l: { relation: string }) => l.relation === "supports")
    .map(async (l: { target_record_id: string }) => (await get(l.target_record_id))?.payload?.standing));
  check("the current state rests on the interview's two statements, each stated, and on no unverified evidence",
    standings.length === 2 && standings.every((s) => s === "stated"), { links: currentRead.links, standings });
  const designRead = await get("invoicing: proposed state");
  check("the design describes the current state, and rests on the purpose statement and the finding",
    designRead.links.some((l: { relation: string; target_title: string; target_version_id: string }) => l.relation === "describes"
      && l.target_title === "invoicing: current state" && l.target_version_id === currentRead.version_id)
      && ["invoicing: purpose", "Industry knowledge: invoices sent on completion are paid sooner"].every((t) =>
        designRead.links.some((l: { relation: string; target_title: string }) => l.relation === "supports" && l.target_title === t)),
    designRead.links);
  const finding = await get("Industry knowledge: invoices sent on completion are paid sooner");
  check("the industry finding is unverified, says so first, names its link, and describes the current state",
    finding.payload.standing === "unverified" && finding.payload.summary.startsWith("Industry knowledge, not your evidence:")
      && finding.payload.source_reference.startsWith("https://")
      && finding.links.some((l: { relation: string; target_title: string }) => l.relation === "describes" && l.target_title === "invoicing: current state"),
    finding);

  // ---- The purpose skill's section 4: the statement names its objective, and links to it in General ----
  await change("invoicing: purpose", { properties: { objective: "Objective: paid within a month" } });
  await link("invoicing: purpose", [{ target: "Objective: paid within a month", relation: "supports" }]);
  const purposeRead = await get("invoicing: purpose");
  const objectiveRead = await get("Objective: paid within a month");
  check("a purpose statement in General names its objective and supports it, and the objective keeps its scope and routine beside its new measure",
    purposeRead.payload.properties?.objective === "Objective: paid within a month"
      && purposeRead.links.some((l: { relation: string; target_title: string; target_kind: string }) => l.relation === "supports"
        && l.target_title === "Objective: paid within a month" && l.target_kind === "decision")
      && objectiveRead.payload.properties?.measure === "Days from invoice to payment, under 21"
      && objectiveRead.payload.properties?.routine === "invoicing" && objectiveRead.payload.properties?.scope === "business",
    { purpose: purposeRead, objective: objectiveRead.payload });

  await sql`insert into fabrik.scope(code, display_name, description, created_by) values ('jobs', 'Jobs', 'Stand-in fixture', ${actor})`;
  await save("decision", "quoting: purpose", { question: "Why does quoting exist, and for whom?", alternatives: [],
    decision: "So a homeowner knows the price before Sam starts.", rationale: "\"They won't book without one.\"", decided_on: "2026-11-17",
    properties: { objective: "Objective: more kitchen work" } }, "jobs");
  let crossScope = "";
  try { await link("quoting: purpose", [{ target: "Objective: more kitchen work", relation: "supports" }]); }
  catch (err) { crossScope = (err as Error).message; }
  const quoting = await get("quoting: purpose");
  check("a purpose statement outside General can't link to its objective in General, so it names the objective in properties",
    /Link target unavailable/.test(crossScope) && quoting.payload.properties?.objective === "Objective: more kitchen work", { crossScope, quoting: quoting.payload });

  // ---- The records skill's "The routine in force", with the calls it names ----
  // deno-lint-ignore no-explicit-any
  type Link = { relation: string; target_kind: string; target_title: string; target_version_id: string; [k: string]: any };
  const titled = async (kind: string, title: string) =>
    (await list(kind, title.replace(":", ""))).filter((r: { title: string }) => r.title.toLowerCase() === title.toLowerCase());
  async function inForce(routine: string) {
    const choices = await titled("decision", `${routine}: design choice`);
    if (choices.length > 1) throw new Error(`two records are titled ${routine}: design choice`);
    for (const d of choices) {
      const r = await get(d.record_id);
      const chosen = (r.links as Link[]).find((l) => l.relation === "supports" && l.target_kind === "model" && l.target_title === r.payload.decision);
      if (chosen) return { from: "selected design", version_id: chosen.target_version_id };
    }
    for (const m of await titled("model", `${routine}: current state`)) {
      const r = await get(m.record_id);
      const node = (r.payload.graph?.nodes ?? []).find((n: { type: string }) => n.type === "routine");
      if (r.payload.model_kind === "observed_current" && String(r.payload.source_status).startsWith("stated, confirmed by")
        && node?.attributes?.basis === "performed") {
        return { from: "confirmed current state", version_id: r.version_id };
      }
    }
    return null;
  }

  // A neighbouring routine whose name holds the same words, saved later, with a design selected on a later day.
  await save("model", "invoicing reminders: current state", { model_kind: "observed_current", source_status: "stated, confirmed by Sam Smith",
    description: "Basis: performed.", graph: ROUTINE_GRAPH(["Phone the customer"], "performed", "invoicing reminders") });
  await save("model", "invoicing reminders: proposed state", { model_kind: "proposed_target", source_status: "proposed",
    description: "Basis: from the current state.", graph: ROUTINE_GRAPH(["Claude drafts a reminder"], "performed", "invoicing reminders") });
  await save("decision", "invoicing reminders: design choice", { question: "How should invoicing reminders run?",
    alternatives: ["invoicing reminders: proposed state"], decision: "invoicing reminders: proposed state", rationale: "Fewer calls.", decided_on: "2026-11-18" });
  await link("invoicing reminders: design choice", [{ target: "invoicing reminders: proposed state", relation: "supports" }]);

  const before = await inForce("invoicing");
  check("with no design selected, the routine in force is the confirmed current state",
    before?.from === "confirmed current state" && before.version_id === currentRead.version_id, before);

  await save("decision", "invoicing: design choice", { question: "How should invoicing run?", alternatives: ["invoicing: proposed state"],
    decision: "", rationale: "", decided_on: null });
  const open = await inForce("invoicing");
  check("an open design choice selects nothing, and the current state stays in force",
    open?.from === "confirmed current state" && open.version_id === currentRead.version_id, open);

  await tool(token, "save_record", { record: "invoicing: design choice", reason: "Sam selected the design",
    fields: { decision: "invoicing: proposed state", rationale: "Invoices go out the day a job ends.", decided_on: "2026-11-17" } });
  await link("invoicing: design choice", [{ target: "invoicing: proposed state", relation: "supports" }]);
  const selected = await inForce("invoicing");
  check("once Sam selects the design, the routine in force is that design's version",
    selected?.from === "selected design" && selected.version_id === designRead.version_id, { selected, design: designRead.version_id });

  const changed = v(await tool(token, "save_record", { record: "invoicing: proposed state", reason: "A second reminder",
    fields: { graph: ROUTINE_GRAPH(["Claude drafts the invoice", "Sam sends it", "Claude drafts a reminder", "Claude drafts a second reminder"]) } }));
  const after = await inForce("invoicing");
  check("a later version of the design stays out of force until it is selected",
    changed?.version_id && changed.version_id !== designRead.version_id && after?.version_id === designRead.version_id, { after, changed: changed?.version_id });

  // Switching to another option: the decision names option B, and still links to the first design until it is unlinked.
  const optionB = v(await tool(token, "save_record", { scope: "general", kind: "model", title: "invoicing: proposed state, B", reason: "Routines stand-in",
    fields: { model_kind: "proposed_target", source_status: "proposed", description: "Basis: from the current state.", graph: ROUTINE_GRAPH(["Sam sends it from the job"]) } }));
  await tool(token, "save_record", { record: "invoicing: design choice", reason: "Sam switched to option B",
    fields: { decision: "invoicing: proposed state, B", rationale: "Invoices go out from the job.", decided_on: "2026-11-17" } });
  await link("invoicing: design choice", [{ target: "invoicing: proposed state, B", relation: "supports" }]);
  const switched = await inForce("invoicing");
  check("once Sam switches to option B, option B is in force, though the decision still links the first design",
    switched?.from === "selected design" && switched.version_id === optionB?.version_id, { switched, optionB: optionB?.version_id });

  // Rejecting after a selection, before the design skill's unlinks: the old links stay, and still select nothing.
  await tool(token, "save_record", { record: "invoicing: design choice", reason: "Sam rejected the designs",
    fields: { decision: "Rejected: invoicing: proposed state, B", rationale: "Sam sends each invoice by hand.", decided_on: "2026-11-17" } });
  const rejected = await inForce("invoicing");
  check("a rejected design choice selects nothing, though its old links stay, and the current state is in force again",
    rejected?.from === "confirmed current state" && rejected.version_id === currentRead.version_id, rejected);

  // A routine the person does not do yet has no version in force until a design is selected.
  await save("model", "quoting: current state", { model_kind: "observed_current", source_status: "stated, confirmed by Sam Smith",
    description: "Basis: intended.", graph: ROUTINE_GRAPH(["Measure the kitchen", "Send the quote"], "intended", "quoting") });
  const intended = await inForce("quoting");
  check("a routine Sam does not do yet has no version in force", intended === null, intended);
} finally {
  await sql.end();
  await api.shutdown();
}
if (failed) { console.log(`FAIL ${failed} routines check(s)`); Deno.exit(1); }
