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
// mail-send.ts holds the mail tools that draft, send over SMTP and move to Trash, taken after mail.ts's. logins.ts holds
// show_logins, which shows the Login card, and the four app-only tools that card calls for shared logins.
//
// The guide tool answers how to do anything in fabrik from guides.ts, which setup/build.mjs guides writes from the
// Markdown guides in docs/guides/. INSTRUCTIONS is what Claude reads about fabrik when it connects, and points to it.
//
// A person can connect two fabrik connectors, one for each business, whose tools have the same names. So each request
// reads the business's name from the business profile in General, as the person, and the server names it with the project's
// reference: first in the instructions, at the start of each tool's description, and as fabrik in each tool's result.
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
import { allScopes, answer, call, type Ctx, type Fabrik, type Project, refused, type Result, scopeOf, type Tool, tool, VERSION } from "./tool.ts";
import { CARD_TOOLS, registerCards } from "./cards.ts";
import { UPLOAD_LIMIT, uploadFile } from "./ported.ts";
import { MEMORY_TOOLS } from "./memory.ts";
import { WORK_TOOLS } from "./work.ts";
import { WORKFLOW_TOOLS } from "./workflows.ts";
import { CONTACT_TOOLS } from "./contacts.ts";
import { VOICE_TOOLS } from "./voice.ts";
import { MAIL_TOOLS } from "./mail.ts";
import { MAIL_SEND_TOOLS } from "./mail-send.ts";
import { CONNECTIONS_TOOLS } from "./connections.ts";
import { PUBLIC_AGENT_TOOLS } from "./public-agent.ts";
import { LOGIN_TOOLS } from "./logins.ts";
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
    "stages says what search could not cover yet, such as files whose text is still being read (awaiting_text) or files it cannot read (unreadable). " +
    "When parts wait to be read for connections (awaiting_extraction above 0), stages.waiting_for_classes is true while connections are on but the glossary has no class, so none is read.",
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
    // Parts waiting for connections are read only once the glossary has a class, so the search says when that holds
    // them back. fabrik_get_graph_reader is asked only when a part waits.
    let stages = body.stages;
    if (stages && Number(stages.awaiting_extraction) > 0) {
      const { data, error } = await ctx.fabrik.rpc("fabrik_get_graph_reader");
      if (error) console.error(`search: fabrik_get_graph_reader failed: ${error.message}`);
      else stages = { ...stages, waiting_for_classes: data?.waiting_for_classes === true };
    }
    return answer({ ...body, ...(stages ? { stages } : {}), hits: label(body.hits), reference_hits: label(body.reference_hits) });
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

const tagFile = tool({
  name: "tag_file",
  description: "Tag a file in a fabrik scope with glossary terms that each name one thing of a class, such as its topics, as the signed-in person, " +
    "and keep what its parts hold. get_reference's glossary gives such a term's class as instance_of, and the term it comes under as broader. " +
    "Each term is named by its glossary term or one of its other names, and each term it comes under is tagged with it. A tag the file has already is kept as it is. " +
    "Gives tags, the terms tagged, and added_entities, how many were new. Needs create permission in the scope, and the file's first part read for connections.",
  input: z.object({
    scope: z.string().min(1).describe("The file's scope, by its scope_id, code or name. A search hit's bucket is its scope's code."),
    path: z.string().min(1).describe("The file's path in the scope, as a search hit's file gives it."),
    terms: z.array(z.string().min(1).max(100)).min(1).max(20).describe("The terms, 1 to 20, each as the glossary names it."),
  }),
  run: (ctx, a) => call(ctx, "fabrik_tag_file", { p_scope: a.scope, p_file: a.path, p_terms: a.terms }),
});

const taggedFiles = tool({
  name: "tagged_files",
  description: "List the files tagged with a glossary term that names one thing of a class, such as a topic, or with a term that comes under it, " +
    "in the scopes the signed-in person may read. Each file gives scope, code, file, its path, which read_file reads, and terms, the terms it is tagged with. " +
    "total is how many there are. With no term, gives each such term with its class, broader, the term it comes under, and files, how many files it tags.",
  input: z.object({
    term: z.string().min(1).max(100).optional().describe("The term, as the glossary names it. Leave out to list the terms."),
    scope: z.string().min(1).optional().describe("Only this scope, by its scope_id, code or name. Leave out for every scope."),
    from: z.number().int().min(0).optional().describe("How many files to pass over, 0 when left out."),
    limit: z.number().int().min(1).max(1000).optional().describe("How many files to give, 1 to 1,000. 200 when left out."),
  }),
  run: (ctx, a) => call(ctx, "fabrik_get_tagged_files", { p_term: a.term ?? null, p_scope: a.scope ?? null, p_from: a.from ?? 0, p_limit: a.limit ?? 200 }),
});

// ---- Reference ----

const getReference = tool({
  name: "get_reference",
  description: "Read fabrik's reference: the glossary, the data dictionary, or the link relations. " +
    "glossary: each term with its kind (term, class or relationship), definition and other names, each relationship's from_class and to_class, " +
    "and for a term that names one thing of a class, such as a topic, that class as instance_of and the term it comes under as broader. " +
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
    "both already classes in the glossary. A term that names one thing of a class, such as the topic Masks, gives that class as instance_of, " +
    "and may give the broader term of the same class it comes under as broader. A class at the end of a relationship or of a record kind, or that a term is one of, stays a class. " +
    "Without preview the answer is the saved version of the term's model record.",
  input: z.object({
    term: z.string().min(1).max(100).describe("The term, 1 to 100 characters."),
    kind: z.enum(["term", "class", "relationship"]).describe("term, class or relationship."),
    definition: z.string().min(1).max(1000).describe("What it means, 1 to 1000 characters."),
    reason,
    other_names: z.array(z.string()).max(20).optional().describe("Other names for it, at most 20."),
    from_class: z.string().optional().describe("A relationship's first class. Only for a relationship."),
    to_class: z.string().optional().describe("A relationship's second class. Only for a relationship."),
    instance_of: z.string().optional().describe("For a term that names one thing of a class, such as the topic Masks, that class. Only for a term."),
    broader: z.string().optional().describe("For a term with instance_of, the broader term of the same class it comes under, such as a topic for a subtopic."),
    preview,
  }),
  run: (ctx, a) => call(ctx, "fabrik_save_term", {
    p_term: a.term, p_kind: a.kind, p_definition: a.definition, p_reason: a.reason, p_other_names: a.other_names ?? [],
    p_from_class: a.from_class ?? null, p_to_class: a.to_class ?? null, p_preview: a.preview ?? false,
    p_instance_of: a.instance_of ?? null, p_broader: a.broader ?? null,
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
 * What Claude reads about fabrik when it connects, in every Claude app, after the line instructionsFor puts first, which
 * names the business. Both together stay under 1,500 characters.
 */
export const INSTRUCTIONS = "fabrik is the person's knowledge base in their Supabase project. Its tools act as the signed-in person, " +
  "within their own grants, and save every change as a new version. It holds records, files, projects, tasks, contacts, routines, " +
  "the glossary, a mailbox and the person's writing voice, and draws cards. " +
  "At the start of a conversation, call profile_get before the first reply. When it gives agentName, that is your name: use it when you speak of yourself. " +
  "Before work a routine covers, find that routine's version in force, name it, and do each step with the connector or plugin it names; " +
  "a step assigned to the person stays theirs. " +
  "fabrik schedules nothing: act on what the person asks here, or in a scheduled task they set up in Claude. Before a save, a send, a link or a deletion, show them what will change and wait for their approval. In a scheduled run, where " +
  "no one can approve, do only the reads, drafts and saves its prompt names, and leave anything that sends, pays, books or deletes for the person. " +
  "Never ask for a password: the person types one only on fabrik's own sign-in page or card. " +
  "Answer a question about their records only from what fabrik's tools return. " +
  "For how to do anything in fabrik, call guide with the person's question, and answer from the guide it gives.";

// ---- Which business ----

/** Which business's fabrik this connector is: the name its business profile gives, or null where the person can read
 * none, and the reference of the Supabase project it is in. Claude can have two fabrik connectors at once, one for each
 * business, whose tools have the same names, so each says which it is. */
export type Identity = { business: string | null; project: string };

/** The project's reference, from its address: abcdefghijklmnopqrst for https://abcdefghijklmnopqrst.supabase.co, and the
 * address's host for any other address. */
export function projectRef(url: string | undefined): string {
  let host = "";
  try { host = new URL(url ?? "").host; } catch { return url ?? ""; }
  return host.endsWith(".supabase.co") ? host.split(".")[0] : host;
}

/** The longest business name the connector repeats. */
const NAME_LIMIT = 60;
/** The business's name, from the business profile's title, Business profile: <business name>, among records read from
 * the General scope, saved last first. The name goes into the instructions and every tool's description, so only a
 * plain name is taken: at most NAME_LIMIT characters of letters, digits, spaces and & ' . , - ( ), with no full stop
 * before a space. Anything else is no name, and the connector names the project. */
// deno-lint-ignore no-explicit-any
export function businessIn(items: any[]): string | null {
  for (const r of items ?? []) {
    const name = /^business profile:\s*(.+)$/i.exec(String(r.title ?? "").trim())?.[1]?.trim();
    if (name && name.length <= NAME_LIMIT && /^[\p{L}\p{N}][\p{L}\p{N} &'\u2019.,()-]*$/u.test(name) && !/\.\s/.test(name)) return name;
  }
  return null;
}

/** How long a business's name is kept for a person before it is read again. A person with no profile to read has it
 * read on each request, so a profile saved now names the connector at once. */
const IDENTITY_KEPT_MS = 10 * 60 * 1000;
/** Each person's business name, by their account's id. Only the person's own reads go in their entry. */
const identities = new Map<string, { business: string; at: number }>();
const MAX_PEOPLE = 200;

/** Which business's fabrik this is, as the person may read it: the business profile's name, kept for IDENTITY_KEPT_MS. */
export async function identityOf(ctx: Ctx, project = projectRef(Deno.env.get("SUPABASE_URL"))): Promise<Identity> {
  const kept = ctx.person ? identities.get(ctx.person) : undefined;
  if (kept && Date.now() - kept.at < IDENTITY_KEPT_MS) return { business: kept.business, project };
  let business: string | null = null;
  try {
    // Only the General scope's profile names the business: a profile saved in another scope is ignored.
    const all = await allScopes(ctx);
    const general = typeof all === "string" ? undefined : all.find((x) => x.code === "general")?.scope_id;
    if (general) {
      const { data, error } = await ctx.fabrik.rpc("fabrik_find_records", {
        p_kind: "model", p_scope_id: general, p_title: "Business profile", p_cutoff: null, p_cursor: null, p_limit: 20,
      });
      business = error ? null : businessIn(data?.items ?? []);
    }
  } catch {
    business = null;
  }
  if (business && ctx.person) {
    if (!identities.has(ctx.person) && identities.size >= MAX_PEOPLE) identities.delete(identities.keys().next().value!);
    identities.set(ctx.person, { business, at: Date.now() });
  }
  return { business, project };
}

/** The business as a name, "Kinetik" in quotes, or where no profile names it, the project. */
const nameOf = (id: Identity) => id.business ? `"${id.business}"` : `project ${id.project}`;
/** What each tool's description starts with. */
export const descriptionStart = (id: Identity) => `${nameOf(id)} fabrik: `;
/** Which fabrik this is, as a sentence: the fabrik of "Kinetik", in project abcdefghijklmnopqrst. */
const whose = (id: Identity) => id.business ? `the fabrik of "${id.business}", in project ${id.project}` : `the fabrik in project ${id.project}`;
/** The instructions Claude reads, starting with which business's fabrik this is. */
export function instructionsFor(id: Identity) {
  return `This connector is ${whose(id)}. Save here only ${id.business ? `the work of "${id.business}"` : "this fabrik's work"}, ` +
    "and another business's through its own fabrik connector. " + INSTRUCTIONS;
}

/** A tool's result with the business and project added, as fabrik: {business, project}, to its data and to the JSON
 * text the model reads. A refusal gets a line naming them after its own words, unless a card draws the refusal, since
 * the card shows every line of it. */
export function stamped(r: Result, id: Identity, card = false): Result {
  const fabrik = { business: id.business, project: id.project };
  if (r.isError) {
    return { ...r, ...(card ? {} : { content: [...r.content, { type: "text" as const, text: `This is ${whose(id)}.` }] }), structuredContent: { fabrik } };
  }
  const content = [...r.content];
  // deno-lint-ignore no-explicit-any
  let parsed: any = null;
  try { parsed = content.length === 1 ? JSON.parse(content[0].text) : null; } catch { parsed = null; }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) content[0] = { type: "text", text: JSON.stringify({ ...parsed, fabrik }) };
  else content.push({ type: "text", text: JSON.stringify({ fabrik }) });
  return { ...r, content, structuredContent: { ...(r.structuredContent ?? {}), fabrik } };
}

/** Whether only a card calls the tool, so Claude keeps it from the model, and its result goes to the card as it is. */
// deno-lint-ignore no-explicit-any
const forCardOnly = (t: Tool) => { const v = (t.meta as any)?.ui?.visibility; return Array.isArray(v) && !v.includes("model"); };

/** Every tool, in the order Claude lists them. */
export const TOOLS: Tool[] = [
  search, getRecord, listRecords, saveRecord, linkRecords, unlinkRecords, listScopes,
  getReference, saveTerm, saveRelationType, uploadFileTool, readFile, tagFile, taggedFiles, guide,
  ...MEMORY_TOOLS,
  ...WORK_TOOLS,
  ...WORKFLOW_TOOLS,
  ...CONTACT_TOOLS,
  ...VOICE_TOOLS,
  ...MAIL_TOOLS,
  ...MAIL_SEND_TOOLS,
  ...CONNECTIONS_TOOLS,
  ...PUBLIC_AGENT_TOOLS,
  ...LOGIN_TOOLS,
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
    { src: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiByeD0iMTEiIGZpbGw9IiNFM0E4MkIiLz48cGF0aCBkPSJNMjYuODcgMzUuNDhRMjYuODcgMzYuMDkgMjcuMDcgMzYuNDJRMjcuMjcgMzYuNzUgMjcuNzYgMzYuODFMMjkuODggMzcuMDlRMzAuMzcgMzcuMTQgMzAuNTggMzcuNDFRMzAuNzkgMzcuNjcgMzAuNzkgMzguMDVRMzAuNzkgMzkgMjkuNjQgMzlIMTcuNTlRMTcuMDggMzkgMTYuNzcgMzguNzZRMTYuNDYgMzguNTIgMTYuNDYgMzguMVExNi40NiAzNy43MSAxNi42NyAzNy40NlExNi44OSAzNy4yMiAxNy4zNiAzNy4wOEwxOC4xNSAzNi44N1ExOC43MSAzNi43IDE4LjkzIDM2LjRRMTkuMTQgMzYuMDkgMTkuMTQgMzUuNTVWMjMuNjdRMTkuMTQgMjMuMzMgMTguOTcgMjMuMDhRMTguNzkgMjIuODMgMTguMjkgMjIuNjNMMTcuMiAyMi4yM1ExNi41OCAyMS45NSAxNi4zNSAyMS42OVExNi4xMSAyMS40NCAxNi4xMSAyMS4xUTE2LjExIDIwLjczIDE2LjM5IDIwLjQ4UTE2LjY3IDIwLjI0IDE3LjI1IDIwLjI0SDIwLjU0TDE5LjE3IDIwLjgyVjIwLjNRMTkuMTcgMTkuODMgMTguODMgMTkuMzVRMTguNDggMTguODggMTguMDMgMTguM1ExNy41NyAxNy43MiAxNy4yMiAxNi45NFExNi44OCAxNi4xNSAxNi44OCAxNS4wNlExNi44OCAxMi4zIDE4LjkzIDEwLjY1UTIwLjk3IDkgMjQuNjcgOVEyNy4wNCA5IDI4LjY0IDkuNzRRMzAuMjUgMTAuNDcgMzEuMDcgMTEuNjlRMzEuODkgMTIuOSAzMS44OSAxNC4zM1EzMS44OSAxNS45MiAzMS4wMSAxNi43NFEzMC4xMyAxNy41NiAyOC43NSAxNy41NlEyNy4yMSAxNy41NiAyNi4yOCAxNi42M1EyNS4zNCAxNS43MSAyNS4zNCAxNC4xNVYxMi4zNVEyNS4zNCAxMS41IDI0Ljg5IDExLjFRMjQuNDMgMTAuNjkgMjMuNjcgMTAuNjlRMjIuNzMgMTAuNjkgMjIuMjUgMTEuMjhRMjEuNzYgMTEuODYgMjEuNzYgMTIuOTVRMjEuNzYgMTQuMDIgMjIuMjIgMTQuODhRMjIuNjggMTUuNzQgMjMuMzcgMTYuNDVRMjQuMDYgMTcuMTcgMjQuNzQgMTcuOFEyNS40MyAxOC40NCAyNS44OSAxOS4wN1EyNi4zNSAxOS42OSAyNi4zNSAyMC4zOFYyMS4yN0wyNS42MSAyMC4yNEgzMC4xMVEzMC42MiAyMC4yNCAzMC45MiAyMC40NVEzMS4yMSAyMC42NiAzMS4yMSAyMS4wNlEzMS4yMSAyMS42NyAzMC42MSAyMi4wOFEzMC4wMSAyMi40OSAyOC42NyAyMi40OUgyNi44N1oiIGZpbGw9IiMxQjI0MzMiLz48L3N2Zz4K", mimeType: "image/svg+xml", sizes: ["any"] },
    { src: "data:image/png;base64,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", mimeType: "image/png", sizes: ["180x180"] },
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
export function register(server: McpServer, ctx: Ctx, tools: Tool[] = TOOLS, id?: Identity) {
  for (const t of tools) {
    const hints = annotationsOf(t.name);
    if (!hints) {
      console.error(`${t.name} has no entry in annotations.ts, so it is left out: give it a title and an effect.`);
      continue;
    }
    // A tool the model reads names the business at the start of its description and in each result. A card's own tool
    // gives its card the result as it is. Arguments a tool's input does not allow are refused by the SDK before run, so
    // that refusal names nothing.
    const named = id && !forCardOnly(t) ? id : undefined;
    server.registerTool(t.name, {
      ...hints, description: named ? descriptionStart(named) + t.description : t.description, inputSchema: strictInput(t),
      ...(t.meta ? { _meta: t.meta } : {}),
    }, (async (args: unknown) => {
      const r = await t.run(ctx, args as never);
      // deno-lint-ignore no-explicit-any
      return named ? stamped(r, named, !!(t.meta as any)?.ui?.resourceUri) : r;
    }) as never);
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
      const id = await identityOf(ctx);
      const handler = createMcpHandler(() => {
        const server = new McpServer(SERVER_INFO, { instructions: instructionsFor(id) });
        register(server, ctx, TOOLS, id);
        registerCards(server);
        return server;
      }, { maxRequestBodySize: REQUEST_LIMIT });
      return handler.fetch(req);
    },
  ),
);
