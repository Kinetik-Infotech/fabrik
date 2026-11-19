// fabrik's connector: a remote MCP server that Claude calls as one signed-in person, and the only way any Claude client
// reaches fabrik. The person adds it once, in Claude's Connectors, with the address
// https://<project ref>.supabase.co/functions/v1/fabrik-apps, and signs in to fabrik through the project's OAuth 2.1
// server. Each request carries that person's access token, and every call to fabrik uses it, through
// supabase.schema("fabrik"), and through Storage and the file-search function for files and search, so fabrik's
// grants, storage rules, row-level security and refusals hold. No tool uses the service key.
// A request with no token, or a token the project's signing keys do not verify, answers 401 with a WWW-Authenticate
// header naming the protected-resource metadata, which starts the sign-in. The metadata itself is answered at
// .../fabrik-apps/oauth-protected-resource, and names the project's Auth as the authorization server.
//
// Deploy it with verify_jwt off: the token is checked here, against the project's signing keys, which must be
// asymmetric. The project's OAuth 2.1 server must be on, with the authorization path /oauth/consent and dynamic
// client registration on, as fabrik setup --owner sets them.
// A token is checked by its signature and expiry alone, as the Data API checks it. A sign-out or a disconnect ends a
// person's access when their current token expires (Project Settings, JWT Keys, expiry); disable their actor in fabrik
// to end it at once.
//
// Each tool is one entry in TOOLS: its name, its description, its zod input and its run, which takes the request's
// context, Ctx, and the parsed arguments, and gives the tool's result. register() adds every entry to the request's
// McpServer. A new tool is a new entry, kept with the others of its area. A tool's description says enough to use it
// on a client that loads no skills. A database refusal is given back as the tool's error, in fabrik's own words.
// tool.ts holds what every tool is made of: Ctx, Tool, tool(), call() and the rest, and index.ts gives it on.
// The tools ported from maxy-code's plugins are in a file for each area, such as memory.ts, work.ts, workflows.ts, contacts.ts and voice.ts, each giving one list that
// TOOLS takes after index.ts's own tools; ported.ts holds what those areas share. mail.ts holds the mail tools that
// read, taken after them, which reach a mailbox's own server over IMAP with the password kept in Vault. It also holds
// show_mail_setup, which shows the mail setup card, and mail_setup_save, the app-only tool that card's Save calls.
// mail-send.ts holds the mail tools that draft, send over SMTP and move to Trash, taken after mail.ts's.
//
// The guide tool answers how to do anything in fabrik from guides.ts, which setup/build.mjs guides writes from the
// Markdown guides in docs/guides/. INSTRUCTIONS is what Claude reads about fabrik when it connects, and points to it.
//
// The cards, the records card, the board card, the graph card and the mail setup card, are in cards.ts: show_records,
// show_board and show_graph, each card's address, which serves a fixed shell, card_page and card_call, and the app-only
// tools the cards read fabrik through. Their pages are card.ts, which plugins/fabrik/cards/make-card.ts writes.
//
// A change to a tool, its name, description or fields, reaches a person only once they reconnect the connector in
// Claude's Connectors, since Claude keeps the tool list it read when they connected. A change to what a tool does
// inside, or to a card's page that a fixed card shell fetches, reaches them at their next call, with no reconnect.
import { createMcpHandler, McpServer } from "npm:@modelcontextprotocol/server@2.4.0";
import { pipeline } from "npm:@supabase/middleware@1.0.0";
import { withOAuthProtectedResource, withSupabase } from "npm:@supabase/server@1.9.2";
import { z } from "npm:zod@4.3.6";
import { annotationsOf } from "./annotations.ts";
import { answer, call, type Ctx, type Fabrik, type Project, refused, scopeOf, type Tool, tool, VERSION } from "./tool.ts";
import { CARD_TOOLS, registerCards } from "./cards.ts";
import { UPLOAD_LIMIT, uploadFile } from "./ported.ts";
import { MEMORY_TOOLS } from "./memory.ts";
import { WORK_TOOLS } from "./work.ts";
import { WORKFLOW_TOOLS } from "./workflows.ts";
import { CONTACT_TOOLS } from "./contacts.ts";
import { VOICE_TOOLS } from "./voice.ts";
import { MAIL_TOOLS } from "./mail.ts";
import { CONNECTIONS_TOOLS } from "./connections.ts";
import { MAIL_SEND_TOOLS } from "./mail-send.ts";
import { GUIDES } from "./guides.ts";

export * from "./tool.ts";

// ---- Scopes ----

const listScopes = tool({
  name: "list_scopes",
  description: "List the fabrik scopes the signed-in person may see, 100 at most per call, in a fixed order. A scope is a part of fabrik, " +
    "such as General or Administration, that holds records and files, and each grant a person holds is in one scope. Each item gives " +
    "scope_id, code, display_name, description (only for a scope the person holds a grant in), enabled, is_private, owner_actor_id and owner_name. " +
    "next_cursor is set when there may be more: pass it as cursor to get the next page.",
  input: z.object({
    cursor: z.string().uuid().optional().describe("The next_cursor of the page before, to get the next page."),
    limit: z.number().int().min(1).max(100).optional().describe("How many scopes to give, 1 to 100. 100 when left out."),
  }),
  run: (ctx, { cursor, limit }) => call(ctx, "fabrik_get_scopes", { p_cursor: cursor ?? null, p_limit: limit ?? 100 }),
});


// ---- Records ----

const RECORD = "A record is named by its record_id, or by its exact title in any case among the records the person may read: " +
  "the one not deleted that has the title, or a deleted one only when none not deleted has it; " +
  "a title more than one record could be meant by is refused, with each one's title, scope, last save and id, a deleted one marked.";
const REASON = "Why this change is made, in the person's words. It is kept with the version and shown in the record's history.";
const PREVIEW = "true to save nothing and get back what would be saved: request, the exact version (title, payload, links), " +
  "authorisation_id, the grant it would use, and actions, the permissions it needs. Show it to the person, then call again without preview to save.";
const KINDS = "activity, decision, evidence or model";
const record = z.string().min(1).describe(RECORD);
const reason = z.string().min(1).describe(REASON);
const preview = z.boolean().optional().describe(PREVIEW);

const getRecord = tool({
  name: "get_record",
  description: "Read one fabrik record at its latest version: record_id, scope_id, scope_name, kind, title, version_id, version_number, " +
    "saved_at, reason, payload (the record's fields) and links, each with its relation and its target's title and index. " + RECORD,
  input: z.object({ record }),
  run: (ctx, { record }) => call(ctx, "fabrik_show_record", { p_record: record }),
});

const listRecords = tool({
  name: "list_records",
  description: "Find fabrik records by kind, scope or words of the title. Each record the person may read is listed once, at its latest version, " +
    "newest save first: record_id, kind, scope_id, title, version_id, version_number, change_no, saved_at and saved_by. " +
    "Leave out any filter not needed. Gives at most limit records; while next_cursor is set, call again with cursor set to it and cutoff set to " +
    "the first page's cutoff, so the pages hold still while you read them. Use search to find records by what they say rather than by title.",
  input: z.object({
    kind: z.enum(["activity", "decision", "evidence", "model"]).optional().describe("Only records of this kind."),
    scope_id: z.string().uuid().optional().describe("Only records in this scope, by its scope_id from list_scopes."),
    title: z.string().optional().describe("Words that must all appear in the title, in any case and any order."),
    cutoff: z.number().int().min(0).optional().describe("The cutoff of the first page, when reading the next page."),
    cursor: z.number().int().min(1).optional().describe("The next_cursor of the page before, to get the next page."),
    limit: z.number().int().min(1).max(100).optional().describe("How many records to give, 1 to 100. 100 when left out."),
  }),
  run: (ctx, a) => call(ctx, "fabrik_find_records", {
    p_kind: a.kind ?? null, p_scope_id: a.scope_id ?? null, p_title: a.title ?? null,
    p_cutoff: a.cutoff ?? null, p_cursor: a.cursor ?? null, p_limit: a.limit ?? 100,
  }),
});

const saveRecord = tool({
  name: "save_record",
  description: "Save a fabrik record as a new version, as the signed-in person, under their own grant. Every save is a new version; earlier versions stay in the history. " +
    "Use it for fabrik's own kinds and fields; for a note or a fact use remember, and for a project, a task or a contact use project_create, task_create or contact_create. " +
    `To add a record, give scope, kind (${KINDS}), title, reason and fields, and parent for a task in a plan. ` +
    "To change one, give record, reason, and only the fields to change, and title to rename it; its other fields and its links are kept. " +
    "fields is the record's payload. activity: activity_kind (plan or task, fixed once saved), state (pending, in_progress, paused, completed, cancelled; " +
    "a new activity is pending), owner_actor_id (the owning person's actor id; a new activity is owned by the person the actor answers to), description, " +
    "completion_requirements, completion_note, baseline_start_at, baseline_finish_at, forecast_start_at, forecast_finish_at (each null or a time with its zone, " +
    "such as 2026-11-15T09:00:00Z), index (one line, at most 20 characters, such as 2.1), task_type (work, deliverable, blocker), assignee_actor_id. " +
    "decision: question, alternatives (a list of text), decision (empty while undecided), rationale, decided_on (YYYY-MM-DD or null). " +
    "evidence: summary, source_reference (an https:// link with no ? part, plain words naming the source, or null), source_date (YYYY-MM-DD or null), " +
    "standing (stated, observed or unverified), limitations. model: model_kind (observed_current or proposed_target), description, " +
    "graph {format_version: 1, nodes: [{id, type, label, attributes}], edges: [{id, source, target, type, attributes}]}. " +
    "A field not given on a new record is empty. Without preview the answer is the saved version, with its record_id and version_id. " +
    "fabrik refuses a change the person has no grant for, with its reason.",
  input: z.object({
    record: z.string().min(1).optional().describe("The record to change. " + RECORD + " Leave out to add a new record."),
    scope: z.string().min(1).optional().describe("A new record's scope, by its scope_id, code or name, from list_scopes."),
    kind: z.enum(["activity", "decision", "evidence", "model"]).optional().describe("A new record's kind, which never changes."),
    title: z.string().min(1).optional().describe("A new record's title, or a changed record's new title. A title carries no index number."),
    reason,
    fields: z.record(z.string(), z.unknown()).optional().describe("The record's fields to save, as this tool's description lists them for each kind."),
    parent: z.string().min(1).optional().describe("A new task's plan, named as a record is. It saves a parent link to the plan."),
    preview,
  }),
  run: (ctx, a) => {
    if (a.record !== undefined) {
      const extra = (["scope", "kind", "parent"] as const).filter((k) => a[k] !== undefined);
      if (extra.length) return Promise.resolve(refused(`A change to a record keeps its ${extra.join(", ")}: leave ${extra.length > 1 ? "them" : "it"} out, or leave out record to add a new record.`));
      return call(ctx, "fabrik_change_record", {
        p_record: a.record, p_reason: a.reason, p_fields: a.fields ?? {}, p_title: a.title ?? null, p_preview: a.preview ?? false,
      });
    }
    const missing = (["scope", "kind", "title"] as const).filter((k) => a[k] === undefined);
    if (missing.length) return Promise.resolve(refused(`A new record needs ${missing.join(", ")}. To change a record, give record.`));
    return call(ctx, "fabrik_add_record", {
      p_scope: a.scope, p_kind: a.kind, p_title: a.title, p_reason: a.reason, p_fields: a.fields ?? {}, p_parent: a.parent ?? null,
      p_preview: a.preview ?? false,
    });
  },
});

const RELATION = "The link's relation, one of the relations get_reference with part relations gives, such as supports, describes, parent or depends_on. " +
  "parent and depends_on join activities only, and a parent is a plan.";

const linkRecords = tool({
  name: "link_records",
  description: "Link one fabrik record to one or more others, saved as one new version of the record, as the signed-in person. " +
    "Each link goes to its target's latest version, in the same scope. A link replaces the record's link of the same relation to the same target, " +
    "and a parent link replaces the record's parent. Its other links are kept. At most 200 links; a list that names one link twice is refused. " +
    "get_record shows a record's links.",
  input: z.object({
    record: z.string().min(1).describe("The record the links go from. " + RECORD),
    links: z.array(z.object({
      target: z.string().min(1).describe("The record the link goes to, named as a record is."),
      relation: z.string().min(1).describe(RELATION),
      note: z.string().optional().describe("A note on the link."),
      locator: z.string().optional().describe("Where in the target the link points, such as a page or a section."),
    })).min(1).max(200),
    reason,
    preview,
  }),
  run: (ctx, a) => call(ctx, "fabrik_link_many", { p_record: a.record, p_links: a.links, p_reason: a.reason, p_preview: a.preview ?? false }),
});

const unlinkRecords = tool({
  name: "unlink_records",
  description: "Remove a fabrik record's link of one relation to one target record, saved as a new version of the record, as the signed-in person. " +
    "Its other links are kept. Refused when the record has no such link.",
  input: z.object({
    record: z.string().min(1).describe("The record the link goes from. " + RECORD),
    target: z.string().min(1).describe("The record the link goes to, named as a record is."),
    relation: z.string().min(1).describe("The link's relation, as get_record shows it."),
    reason,
    preview,
  }),
  run: (ctx, a) => call(ctx, "fabrik_unlink", { p_record: a.record, p_target: a.target, p_relation: a.relation, p_reason: a.reason, p_preview: a.preview ?? false }),
});

// ---- Search ----

const search = tool({
  name: "search",
  description: "Search fabrik's records and files together by what they say, as the signed-in person: only what they may read is searched. " +
    "It matches the question's words and its meaning, and follows the graph of what the files name. Each hit has found_as, record or file. " +
    "A record hit gives record_id, version_number and file, the record's title; a file hit gives bucket, the scope's code, and file, its path there, " +
    "which read_file reads. Each hit gives place, snippet, found (words, meaning, graph) and section, the index into sections, which gives the text around it. " +
    "hits are ranked first; reference_hits are the reference scope's own, the glossary and data dictionary, ranked apart when no scope is named. " +
    "stages says what search could not cover yet, such as files whose text is still being read (awaiting_text) or files it cannot read (unreadable).",
  input: z.object({
    query: z.string().min(1).max(1000).describe("The question or words to search for."),
    scope: z.string().min(1).optional().describe("Search only this scope, by its scope_id, code or name. Leave out to search every scope."),
    limit: z.number().int().min(1).max(50).optional().describe("How many hits to give, 1 to 50. 10 when left out."),
  }),
  run: async (ctx, a) => {
    let bucket: string | null = null;
    if (a.scope !== undefined) {
      const found = await scopeOf(ctx, a.scope);
      if (typeof found === "string") return refused(found);
      bucket = found.code;
    }
    const res = await ctx.project("/functions/v1/file-search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: a.query, ...(bucket ? { bucket } : {}), limit: a.limit ?? 10 }),
    });
    // deno-lint-ignore no-explicit-any
    const body: any = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok === false) return refused(String(body?.problem ?? `File search answered ${res.status}.`));
    // deno-lint-ignore no-explicit-any
    const label = (hits: any[]) => (hits ?? []).map((h) => ({ found_as: h.record_id ? "record" : "file", ...h }));
    return answer({ ...body, hits: label(body.hits), reference_hits: label(body.reference_hits) });
  },
});

// ---- Files ----

/** The largest request the connector reads: a file at UPLOAD_LIMIT, in base64, with the rest of the call. The MCP
 * handler's own bound, 4 MiB, would refuse a file of 3 MiB in base64 before upload_file sees it. */
export const REQUEST_LIMIT = 9 * 1024 * 1024;
export { UPLOAD_LIMIT };

const uploadFileTool = tool({
  name: "upload_file",
  description: `Upload one file, up to ${UPLOAD_LIMIT / 1024 / 1024} MB, into a fabrik scope's files, as the signed-in person. ` +
    "The file's bytes are given here, as text or as base64. The person needs create permission in the scope, and edit permission to replace a file. " +
    "File search reads the text of PDF, .xlsx, .xls, .ods, .docx, Markdown and plain text files soon after; search then finds it, and read_file reads it. " +
    "Gives scope, the scope's code, which is its bucket, path, size and content_type.",
  input: z.object({
    scope: z.string().min(1).describe("The scope, by its scope_id, code or name, from list_scopes."),
    path: z.string().min(1).max(1024).describe("Where the file goes in the scope, such as notes.md or reports/2026/q3.pdf. No leading /, and no . or .. parts."),
    content: z.string().describe("The file's content: its text, or with encoding base64, its bytes in base64."),
    encoding: z.enum(["text", "base64"]).optional().describe("text (UTF-8) when left out, or base64 for a binary file such as a PDF."),
    content_type: z.string().min(1).optional().describe("The file's type, such as text/markdown. Taken from the path's extension when left out."),
    overwrite: z.boolean().optional().describe("true to replace a file already at that path. A file there is kept, and the upload refused, when left out."),
  }),
  run: (ctx, a) => uploadFile(ctx, a),
});

const readFile = tool({
  name: "read_file",
  description: "Read a file's text in a fabrik scope, in parts, as file search took it from the file: file, state, parts (how many there are) " +
    "and chunks, each with ordinal, chunk_id, place (such as a page or a section), text, and graph, whether its entities and relations are read. " +
    "state is extracted once the text is read; waiting while it is still being read, with no chunks yet; and no_text, unsupported or failed when it cannot be. " +
    "Gives limit parts from the part numbered from; call again with from set past the last ordinal to read on. Needs read permission in the scope.",
  input: z.object({
    scope: z.string().min(1).describe("The file's scope, by its scope_id, code or name. A search hit's bucket is its scope's code."),
    path: z.string().min(1).describe("The file's path in the scope, as a search hit's file gives it, such as reports/q3.pdf."),
    from: z.number().int().min(0).optional().describe("The ordinal of the first part to give, 0 when left out."),
    limit: z.number().int().min(1).max(50).optional().describe("How many parts to give, 1 to 50. 20 when left out."),
  }),
  run: (ctx, a) => call(ctx, "fabrik_get_file_parts", { p_scope: a.scope, p_file: a.path, p_from: a.from ?? 0, p_limit: a.limit ?? 20 }),
});

// ---- Reference ----

const getReference = tool({
  name: "get_reference",
  description: "Read fabrik's reference: the glossary, the data dictionary, or the link relations. " +
    "glossary: each term with its kind (term, class or relationship), definition and other names, and each relationship's from_class and to_class. " +
    "dictionary: each record kind (tables) with its glossary class and meaning, its fields (columns) with type, required, term and meaning, " +
    "and where each field comes from (sources). relations: each relation a link may use, with its description, and single_parent, " +
    "whether a record may have only one link of it. The glossary and dictionary need read permission in the Reference scope.",
  input: z.object({
    part: z.enum(["glossary", "dictionary", "relations"]).describe("Which part to read."),
  }),
  run: async (ctx, { part }) => {
    if (part !== "relations") return call(ctx, "fabrik_get_reference", { p_part: part });
    // The relations, in the glossary's shape, as get_reference gives its other parts.
    const { data, error } = await ctx.fabrik.rpc("fabrik_list_relation_types");
    return error ? refused(error.message) : answer({ part: "relations", rows: data ?? [] });
  },
});

const saveTerm = tool({
  name: "save_term",
  description: "Save one glossary term, class or relationship in fabrik's Reference scope, as the signed-in person, under their grant there. " +
    "A term named in any case that is already in the glossary gets a new version; its name keeps the glossary's spelling, and a new name is a new term. " +
    "A class is a kind of thing records and files name, such as property or vendor. A relationship joins two classes, from_class to to_class, " +
    "both already classes in the glossary. A class at the end of a relationship or of a record kind stays a class. " +
    "Without preview the answer is the saved version of the term's model record.",
  input: z.object({
    term: z.string().min(1).max(100).describe("The term, 1 to 100 characters."),
    kind: z.enum(["term", "class", "relationship"]).describe("term, class or relationship."),
    definition: z.string().min(1).max(1000).describe("What it means, 1 to 1000 characters."),
    reason,
    other_names: z.array(z.string()).max(20).optional().describe("Other names for it, at most 20."),
    from_class: z.string().optional().describe("A relationship's first class. Only for a relationship."),
    to_class: z.string().optional().describe("A relationship's second class. Only for a relationship."),
    preview,
  }),
  run: (ctx, a) => call(ctx, "fabrik_save_term", {
    p_term: a.term, p_kind: a.kind, p_definition: a.definition, p_reason: a.reason, p_other_names: a.other_names ?? [],
    p_from_class: a.from_class ?? null, p_to_class: a.to_class ?? null, p_preview: a.preview ?? false,
  }),
});

const saveRelationType = tool({
  name: "save_relation_type",
  description: "Add a relation that links between records may use, or change an existing relation's description, in fabrik's Reference scope. " +
    "Administrators only. get_reference with part relations lists the relations. Without preview the answer is the saved version of the relation's model record.",
  input: z.object({
    code: z.string().min(1).max(100).describe("The relation: lower-case words joined by underscores, such as depends_on."),
    description: z.string().min(1).max(1000).describe("What a link of this relation means, 1 to 1000 characters."),
    reason: z.string().min(1).optional().describe(REASON + " Relation type <code> when left out."),
    preview,
  }),
  run: (ctx, a) => call(ctx, "fabrik_save_relation_type", { p_code: a.code, p_description: a.description, p_reason: a.reason ?? null, p_preview: a.preview ?? false }),
});

// ---- Guides ----

// Words a question shares with every guide, which say nothing about which guide it asks for.
const COMMON = new Set(("a an and are as at be by can could do does for from get how i in is it its me my of on or our so " +
  "that the their them then there this to use using we what when where which who why will with would you your fabrik claude").split(" "));
/**
 * A word's stem, so that its singular and plural, and its -ing and -ed forms, meet: file and files are fil, note and notes
 * not, address and addresses address, company and companies company, print, printing and printed print.
 */
export const stem = (word: string) => {
  if (word.length <= 3) return word;
  let w = word.replace(/sses$/, "ss").replace(/ies$/, "y").replace(/([^s])s$/, "$1");
  if (w.length > 5) w = w.replace(/(ing|ed)$/, "");
  return w.replace(/e$/, "");
};
/** A text's words, each in lower case and stemmed, leaving out the common ones. */
const wordsOf = (text: string) => new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
  .filter((w) => !COMMON.has(w)).map(stem).filter((w) => w.length > 2));
/** Each guide's words: those of its title, topic and section headings, which weigh more, and those of its text. */
const GUIDE_WORDS = GUIDES.map((g) => ({
  guide: g,
  title: wordsOf(`${g.title} ${g.topic.replaceAll("-", " ")} ${(g.text.match(/^## .+$/gm) ?? []).join(" ")}`),
  text: wordsOf(g.text),
}));
/** How many guides use each word. A word few guides use says more about which one a question asks for. */
const SPREAD = new Map<string, number>();
for (const g of GUIDE_WORDS) for (const w of g.text) SPREAD.set(w, (SPREAD.get(w) ?? 0) + 1);
/** The least score a guide needs to answer a question: a word of its title that few guides use, or two rarer words of its text. */
const ENOUGH = 2.5;
const topicsList = () => GUIDES.map((g) => ({ topic: g.topic, title: g.title }));

/** The guide a topic or a question asks for, with the next closest, or none. */
export function findGuide(about: string) {
  const asked = about.trim().toLowerCase();
  const named = GUIDES.find((g) => g.topic === asked || g.title.toLowerCase() === asked);
  if (named) return { guide: named, also: [] as typeof GUIDES };
  const words = wordsOf(about);
  // A question made only of common words, such as "What can fabrik do?" or "How do I use fabrik with Claude?", is the
  // guide whose title holds most of them, the first guide on a tie, and none when no title holds fabrik or Claude.
  if (words.size === 0) {
    const raw = new Set(asked.match(/[a-z0-9]+/g) ?? []);
    if (!raw.has("fabrik") && !raw.has("claude")) return null;
    const shared = (g: typeof GUIDES[number]) => (g.title.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => raw.has(w)).length;
    const best = GUIDES.reduce((a, g) => shared(g) > shared(a) ? g : a);
    return shared(best) > 0 ? { guide: best, also: [] as typeof GUIDES } : null;
  }
  const scored = GUIDE_WORDS.map(({ guide, title, text }) => {
    let score = 0;
    for (const w of words) {
      if (!text.has(w) && !title.has(w)) continue;
      score += Math.log(1 + GUIDES.length / (SPREAD.get(w) ?? 1)) * (title.has(w) ? 3 : 1);
    }
    return { guide, score };
  }).sort((a, b) => b.score - a.score);
  if (scored[0].score < ENOUGH) return null;
  return { guide: scored[0].guide, also: scored.slice(1, 3).filter((s) => s.score >= ENOUGH).map((s) => s.guide) };
}

const guide = tool({
  name: "guide",
  description: "Read fabrik's guide to how to do something in fabrik, such as add a connector, upload a file, set up a mailbox, design a routine, " +
    "print a PDF, run setup again or get help. Give about, a guide's topic or the person's question in their own words. " +
    "It gives the closest guide's topic, title and text, in Markdown, and also, other guides that may help. With about left out, or when no guide matches, " +
    "it gives topics, every guide's topic and title. Answer from the guide's text. It reads no records.",
  input: z.object({
    about: z.string().max(500).optional().describe("A guide's topic, such as other-connectors, or a question, such as How do I add my calendar?"),
  }),
  run: (_ctx, { about }) => {
    const found = about?.trim() ? findGuide(about) : null;
    if (!found) {
      return Promise.resolve(answer({
        ...(about?.trim() ? { matched: false, note: `No guide answers "${about.trim()}". These are fabrik's guides.` } : {}),
        topics: topicsList(),
      }));
    }
    const { topic, title, text } = found.guide;
    return Promise.resolve(answer({ topic, title, text, also: found.also.map((g) => ({ topic: g.topic, title: g.title })) }));
  },
});

/**
 * What Claude reads about fabrik when it connects, in every Claude app. It stays under 1,500 characters.
 */
export const INSTRUCTIONS = "fabrik is the person's own knowledge base, kept in their Supabase project. Its tools act as the signed-in person, " +
  "within their own grants, and save every change as a new version. It holds records (notes, decisions, evidence, plans, tasks and models), " +
  "files with search across both, projects and tasks, contacts and groups, routines and their designs, the glossary, a mailbox it reads and, on the person's approval, drafts in and sends from, " +
  "and the person's writing voice. It draws records, boards and graphs as cards. " +
  "fabrik holds the routines the person does their work by. Before work a routine covers, find that routine's version in force, " +
  "name it, and do each step with the connector or plugin it names; a step assigned to the person stays theirs. " +
  "Nothing in fabrik runs unattended: act only on what the person asks in this conversation, and before a save, a send, a link or a deletion, show them " +
  "what will change and wait for their approval. Never ask for a password: the person types one only on fabrik's own sign-in page or card. " +
  "Answer a question about their records only from what fabrik's tools return. " +
  "For how to do anything in fabrik, or in Claude with fabrik, such as adding another connector, call guide with the person's question, " +
  "and answer from the guide it gives.";

/** Every tool, in the order Claude lists them. */
export const TOOLS: Tool[] = [
  search, getRecord, listRecords, saveRecord, linkRecords, unlinkRecords, listScopes,
  getReference, saveTerm, saveRelationType, uploadFileTool, readFile, guide,
  ...MEMORY_TOOLS,
  ...WORK_TOOLS,
  ...WORKFLOW_TOOLS,
  ...CONTACT_TOOLS,
  ...VOICE_TOOLS,
  ...MAIL_TOOLS,
  ...CONNECTIONS_TOOLS,
  ...MAIL_SEND_TOOLS,
  ...CARD_TOOLS,
];

/**
 * What the connector tells Claude about itself when Claude connects, beside INSTRUCTIONS: its name, the title a person reads, fabrik's icon
 * and its website. The icon is the fabrik site's, as data: addresses, so it does not depend on any one project's address.
 */
export const SERVER_INFO = {
  name: "fabrik-apps",
  title: "fabrik",
  version: VERSION,
  websiteUrl: "https://github.com/Kinetik-Infotech/fabrik",
  icons: [
    { src: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiBmaWxsPSIjMGIwYjBiIi8+PGcgc3Ryb2tlPSIjZmZmZmZmIiBzdHJva2Utb3BhY2l0eT0iLjU1IiBzdHJva2Utd2lkdGg9IjIiPjxsaW5lIHgxPSIyNCIgeTE9IjI0IiB4Mj0iMTEiIHkyPSIxMiIvPjxsaW5lIHgxPSIyNCIgeTE9IjI0IiB4Mj0iMzciIHkyPSIxMiIvPjxsaW5lIHgxPSIyNCIgeTE9IjI0IiB4Mj0iMTEiIHkyPSIzNiIvPjxsaW5lIHgxPSIyNCIgeTE9IjI0IiB4Mj0iMzciIHkyPSIzNiIvPjwvZz48ZyBmaWxsPSIjZmZmZmZmIj48cmVjdCB4PSI3IiB5PSI4IiB3aWR0aD0iOCIgaGVpZ2h0PSI4Ii8+PHJlY3QgeD0iMzMiIHk9IjgiIHdpZHRoPSI4IiBoZWlnaHQ9IjgiLz48cmVjdCB4PSI3IiB5PSIzMiIgd2lkdGg9IjgiIGhlaWdodD0iOCIvPjxyZWN0IHg9IjMzIiB5PSIzMiIgd2lkdGg9IjgiIGhlaWdodD0iOCIvPjwvZz48cmVjdCB4PSIxOSIgeT0iMTkiIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCIgZmlsbD0iIzJmZTI4YSIvPjwvc3ZnPgo=", mimeType: "image/svg+xml", sizes: ["any"] },
    { src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAHFElEQVR4nOzdWWsUWRyG8ZMYtzFgDBFD1DgISsT1RubGvjegILgxiqK4fCnFDWGEKChetPcGZPBCjLuojEEkglvcUKNxXiYzjsR+o8Z09/kXz+9qcApSXf2k6tSpdJ+mGTNmJKCSxgQYxAGLOGARByzigEUcsIgDFnHAIg5YxAGLOGARByzigEUcsIgDFnHAIg5YxAGLOGARByzigEUcsIgDFnHAIg5YxAGLOGARByzigNWUJlS5XC6VSqkKuru7z58/n+LT8dFRSlWg46OjlCYOZw5YxAGLOGARByzigEUcsIgDFnHAIg5YxAGLOGARByzigEUcsIgDFnHAIg5YxAGLOGARByzigEUcsCb4ownVU5iFCgO9kDBnjvXr17e3t6fg9BL0QlIQYeJobm7et2/fvHnzUljaeb0EvZAURKQxx7Rp0/bu3btw4cIUkHZbO6+XkOIINiCdPHnyrl27VqxYkULRDmu3tfMplDAD0s8mTZq0devWqVOnXrx4MUWwevXqDRs2pIDixTFCh1un6Pw/Wl0qldauXZtiasj5zuqbR7a3t/fcuXOfPn1K+WloaNDOr1mzZoxttPM59z1pypQpKVf9/f0vX77s6upyG3R2dra1td24cSO3PhobG7ds2aILyhjbnD59+sKFCyljWcchDx8+fPz48ZIlS3S4K24wZ86cuXPnXrt2bXh4OOWhqalp+/btS5cudRt8/Pixp6fn0qVLKW+5xyGPHj26f//+8uXLNRStuIFOHgsWLND548OHD6neNBLasWPHokWL3AZDQ0NHjx69efNmyl6AOOTZs2d37txRH/qlrLjBrFmzdPXR+eP9+/epfjTBpcmM+fPnuw3evn176NAhtZ4iiBGHvHjx4vbt2yrAzSPpjdGZ/Pr16+/evUv1MHPmzP3798+ePdttMDg4ePjwYV0oUxBh4pBXr15dvXpV44/p06dX3ED/vmzZsrt372rLVFt6aLJnzx6dwNwGT58+PXDgwJMnT1IckeIQnRWuXLmyePFi94RC55WVK1feu3dPZ5pUK3poojLGeGiiYdPBgwd155VCCRaHaFRx+fJlXdfdr6nGJatWrdJtsEYqqfr00GT37t2asXUbqNQjR468efMmRRMvDtFdic4fHR0duk+puIHua3T+0Dlcv7KpmvTQZNu2bW6YLLdu3Tp+/Hh9h8njFjIO0ayG+lAcmueouIHmRTT+0Jm8egNAzXFt2rTJTcBIX1/fiRMnNKuRYsp6+vyb3BT1nys/Pp3575ypRoLPnz9PE62lpaW1tXXkv1sHG367PHoOJuep/e8U9cHbCB36crmse5NRj2BUxkDbfxOmbS2/pJY00XSdGEif52RHnzwyf2jynWLHMUJvgyaX8nksrocmUf6cYGxFiEP0ZuguVyMAN8VeGxpenDx5UkONVAgFiSP9M/rT9WXnzp31+oMrPTQ5duyYblxTURTqcyt6YzTXpEtMqjn9UP3oIpWRot+tVKSZ7F//2Pe4vXbdtw0M//X7gYGBgVQsBfzEm96kGj/c0o8rXhmpqB+HrPEfduTwdyTVwGdlYREHLOKARRywiAMWccAiDljEAYs4YBEHLOKARRywiAMWccAiDljEAYs4YBEHLOKARRywiANWcT7x9qUxvjCjAD+uZgp45mhvb+/o6Eg1pB9XgLVgvla0OEbWNKn9mSP6WjAVFSqOOq5pEnotGKc4cdR9TZOga8GMoSAjqUzWNAm3FszYon5h3JdKpdK6deu+/Jc7C4Zf/VK7L+NqftOw6P7/5+Curq6hoaH+/v4UXOwzh/vCuNbBhs9XzNp8Ydyo/6u9am5ujv6FcYG/n6OxsXHz5s1jX+Or+vVc37yW9fX19fT05LPWx4+KelnJYU2TiGvB/JCQceSzpkmstWB+VLw4clvTJMpaMOMQLI481zTJfy2Y8YkUR85rmuS8Fsy4hYkj/zVN8lwL5mfEiCPKmia5rQXzkwLEEWtNk3zWgvl5uccRcU2THNaCmRBZx/H1Q5NRent7z5w5k+EUtXZJ9yY6tp2dnW6b/B/BTPD0eblc1juaquDUqVMPHjz48l9CrGmiozFqLRiNrDdu3JiqQEeju7s7TZyoD96irGmS21owPyReHOHWNMlkLZhxCBZH0DVN6r4WzPhE+jPB0Gua1HEtmHELE4d+8zQ1PmpMGot2Xi8h0PR5mDjOnj1bgDVN9BL0QlIQYcYcr1+/ToUQ6IXwWVlYxAGLOGARByzigEUcsIgDFnHAIg5YxAGLOGARByzigEUcsIgDFnHAIg5YxAGLOGARByzigEUcsAJ/SS2qjTMHLOKARRywiAMWccAiDljEAYs4YBEHLOKARRywiAMWccAiDljEAYs4YBEHLOKARRywiAMWccAiDljEAYs4YBEHLOKARRywiAMWccD6GwAA///m3cfZAAAABklEQVQDAMil8SGb5vKuAAAAAElFTkSuQmCC", mimeType: "image/png", sizes: ["180x180"] },
  ],
};

/** A tool's input that refuses an argument it does not name, saying which it takes. Without it the argument is dropped,
 * and a call with a guessed name, such as guide with topic for about, answers as if nothing were asked. */
export function strictInput(t: Tool) {
  const takes = Object.keys(t.input.shape);
  return z.strictObject(t.input.shape, {
    error: (issue) => issue.code === "unrecognized_keys"
      ? `${t.name} does not take ${issue.keys.join(", ")}. It takes ${takes.length ? takes.join(", ") : "no arguments"}.`
      : undefined,
  });
}

/** Adds each tool to the server, each run with the request's context. The SDK types its callback by the inputSchema
 * of each call to registerTool, which a loop over tools of different inputs cannot give, so the callback is cast.
 * The SDK still validates the arguments against the tool's strict input before calling it. */
export function register(server: McpServer, ctx: Ctx, tools: Tool[] = TOOLS) {
  for (const t of tools) {
    const hints = annotationsOf(t.name);
    if (!hints) {
      console.error(`${t.name} has no entry in annotations.ts, so it is left out: give it a title and an effect.`);
      continue;
    }
    server.registerTool(t.name, { ...hints, description: t.description, inputSchema: strictInput(t), ...(t.meta ? { _meta: t.meta } : {}) },
      ((args: unknown) => t.run(ctx, args as never)) as never);
  }
}

/** The account's id in a bearer token that withSupabase has already verified, or nothing. */
function personOf(authorization: string | null): string | undefined {
  const part = (authorization ?? "").replace(/^Bearer\s+/i, "").split(".")[1];
  if (!part) return undefined;
  try {
    const sub = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))).sub;
    return typeof sub === "string" && sub ? sub : undefined;
  } catch {
    return undefined;
  }
}

Deno.serve(
  pipeline(
    [withOAuthProtectedResource(), withSupabase({ auth: "user" })],
    async (req, { supabase }) => {
      // Storage and file search are called as the person, with the token this request carries.
      const project: Project = (path, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("Authorization", req.headers.get("Authorization") ?? "");
        headers.set("apikey", Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "");
        return fetch(`${Deno.env.get("SUPABASE_URL")}${path}`, { ...init, headers });
      };
      const ctx: Ctx = { fabrik: supabase.schema("fabrik") as unknown as Fabrik, project, person: personOf(req.headers.get("Authorization")) };
      const handler = createMcpHandler(() => {
        const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
        register(server, ctx);
        registerCards(server);
        return server;
      }, { maxRequestBodySize: REQUEST_LIMIT });
      return handler.fetch(req);
    },
  ),
);
