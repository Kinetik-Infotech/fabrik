// fabrik import maxy <folder>: loads one maxy-code account, as scripts/maxy-export.mjs wrote it, into the signed-in
// owner's fabrik. The export's sha256 values are checked first, and an export holding a label the label map does not
// name is refused before anything is saved. Each node becomes a record in General, saved with fabrik_save_version;
// each relationship a link, a record's links saved together with fabrik_link_many; each file a Storage object in General's bucket, sent with
// upload_file. A task, job, event or run that is over is saved as evidence, not as open work. A trashed node is saved,
// then deleted with fabrik_delete_record. The public agent's KNOWLEDGE.md is
// drafted from every non-Person node's compiledTruthPublic. A record whose maxy-code id fabrik already holds is left
// as it is, so a second run loads nothing. The report goes to import-report.json in the folder.
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SYSTEM = "maxy-code";
/** The label map, shipped with the plugin in its import folder; the exporter reads the same file. */
export const LABEL_MAP = fileURLToPath(new URL("../../import/maxy-labels.json", import.meta.url));
export const REPORT_FILE = "import-report.json";
export const KNOWLEDGE_FILE = "KNOWLEDGE.md";
/** The public agent's bucket. */
export const PUBLIC_AGENT_BUCKET = "public-agent";
/** Calls in flight at once. On the stand-in, 12 nodes, 10 relationships and 2 files took 42 calls in 1.5 s, one record per call. */
export const CONCURRENCY = 8;
// fabrik's text limits: a title, a payload's text field, a link's note.
const TITLE_MAX = 500, TEXT_MAX = 4000, NOTE_MAX = 4000;
/** fabrik keeps at most this many links on a record's version. */
export const LINKS_MAX = 200;
export const LINKS_MAX_REASON = `fabrik keeps at most ${LINKS_MAX} links on a record`;
/** fabrik refuses a save request over 256 KiB; a record's links and their notes are part of each one. Kept 10% under it,
 * as the database's own text of a request is a little longer than its JSON. */
const REQUEST_BUDGET = Math.floor(262144 * 0.9);
export const REQUEST_REASON = "the record's links would pass fabrik's 256 KiB limit on one save";
/** How often the import says how far it has got, on stderr. */
export const PROGRESS_EVERY = 500;
// A relation's code, as fabrik.relation_type checks it.
const RELATION_CODE = /^[a-z]+(_[a-z]+)*$/;

// ---- Values ----

/** A property name as the drop list compares it: lower case, without - and _ (apiKey, API_KEY, api-key). */
export const normKey = key => String(key).toLowerCase().replace(/[-_]/g, "");

const TAGS = ["$int", "$float", "$date", "$datetime", "$time", "$duration", "$point"];
/** One exported value as plain JSON: an integer as a number while it is exact, else its digits; a temporal value as its
 * ISO text; a point as {srid, x, y, z}; NaN and the infinities as their names. */
export function decodeValue(v) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(decodeValue);
  const keys = Object.keys(v);
  if (keys.length === 1 && TAGS.includes(keys[0])) {
    const [tag] = keys, inner = v[tag];
    if (tag === "$int") { const n = Number(inner); return Number.isSafeInteger(n) && String(n) === String(inner) ? n : String(inner); }
    if (tag === "$float") return String(inner);
    if (tag === "$point") return Object.fromEntries(Object.entries(inner ?? {}).map(([k, x]) => [k, decodeValue(x)]));
    return String(inner);
  }
  return Object.fromEntries(keys.map(k => [k, decodeValue(v[k])]));
}

// A name that says its value is a secret, whatever the drop list holds: passwordHash, clientSecret, sessionToken,
// stripeApiKey, privateKey. A count of tokens, such as tokenCount or maxTokens, is not one.
const SECRET_NAME = /password|passwd|secret|privatekey|apikey|token(hash|enc|encrypted)?$/;
/** Whether a property's name says it holds a secret. The exporter drops the same names. */
export const looksSecret = key => SECRET_NAME.test(normKey(key));

/** The properties less every name on the drop list, matched as normKey does, and every name that looks secret, each
 * value decoded. `dropped` names what went. */
export function cleanProperties(props, dropList) {
  const drop = new Set((dropList ?? []).map(normKey));
  const properties = {}, dropped = [];
  for (const [k, v] of Object.entries(props ?? {})) {
    if (drop.has(normKey(k)) || looksSecret(k)) { dropped.push(k); continue; }
    properties[k] = decodeValue(v);
  }
  return { properties, dropped };
}

// ---- Labels, titles and relations ----

/** The labels a node carries that the map neither maps nor skips, sorted. */
export function unknownLabels(nodes, map) {
  const unknown = new Set();
  for (const n of nodes) for (const l of n.labels ?? []) if (!map.labels[l] && !map.skip[l]) unknown.add(l);
  return [...unknown].sort();
}

/** How one node is taken: { skip: label, reason } for a node carrying a skip label, which is never imported, or
 * { label, type, kind } from its first mapped label. Trashed is a marker, not a label of its own. */
export function classifyNode(node, map) {
  const labels = (node.labels ?? []).filter(l => l !== "Trashed");
  const skipped = labels.find(l => map.skip[l]);
  if (skipped) return { skip: skipped, reason: `${skipped} is not imported: ${map.skip[skipped]}` };
  const label = labels.find(l => map.labels[l]);
  if (!label) return { skip: null, reason: "the node has no label" };
  return { label, type: map.labels[label].type, kind: map.labels[label].kind };
}

// The statuses maxy-code gives work that is over: its work plugin's completed, failed, cancelled and abandoned, and its
// runs' done, finished and skipped. A task keeps its status in status, an event in eventStatus.
const CLOSED = new Set(["completed", "done", "finished", "failed", "cancelled", "abandoned", "skipped"]);
/** Whether a node's work is over. fabrik starts every activity as pending, so such a node is saved as evidence of
 * what was done, with its type, labels and properties, and never as open work. */
export const isClosed = properties => [properties?.status, properties?.eventStatus].some(s => typeof s === "string" && CLOSED.has(s.trim().toLowerCase()));

/** The last part of an element id, such as 12 of 4:2f0c…:12. */
export const shortId = id => String(id).split(":").pop().slice(-12);

const oneLine = (text, max) => { const t = String(text).replace(/\s+/g, " ").trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const text = (value, max = TEXT_MAX) => { const t = String(value).trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const filled = v => (typeof v === "string" && v.trim() !== "") || typeof v === "number";

/** A record's title: the node's name, else its title, else its label and short id. */
export function titleFor(label, elementId, properties) {
  for (const key of ["name", "title"]) if (filled(properties?.[key])) return oneLine(properties[key], TITLE_MAX);
  return `${label} ${shortId(elementId)}`;
}

/** A relation code from a maxy-code relationship type, as fabrik's code rule allows: lower case words joined by
 * underscores, so WORKS_AT is works_at and HAS-2-PARTS is has_parts. Null where nothing is left. */
export function relationCode(type) {
  const code = String(type).toLowerCase().replace(/[^a-z]+/g, "_").replace(/^_+|_+$/g, "");
  return RELATION_CODE.test(code) && code.length <= 100 ? code : null;
}

/** fabrik's own relations, which a derived code never takes unless the map gives them to a type. */
const SEEDED = ["supports", "describes", "parent", "depends_on"];
// A relation code holds no digits, so a second type that derives the same code takes _two, a third _three, and so on.
const SUFFIXES = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** The relation for each relationship type, as { type: { code, description } or { problem } }: from the map, else
 * derived. A derived code never equals the code of another type, mapped or derived, nor one of fabrik's own relations,
 * so two types never merge into one relation. Types are taken in name order, so each run gives each type the same code. */
export function relationsFor(types, map) {
  const out = {}, taken = new Set();
  for (const r of Object.values(map.relations ?? {})) taken.add(r.code);
  for (const code of SEEDED) taken.add(code);
  for (const type of [...types].sort()) {
    const mapped = map.relations?.[type];
    if (mapped) { out[type] = { code: mapped.code, description: mapped.description }; continue; }
    const base = relationCode(type);
    if (!base) { out[type] = { problem: `${type} gives no relation code fabrik allows` }; continue; }
    const code = [base, ...SUFFIXES.map(w => `${base}_${w}`)].find(c => !taken.has(c) && c.length <= 100);
    if (!code) { out[type] = { problem: `${type} gives the relation code ${base}, which ten other types already have` }; continue; }
    taken.add(code);
    out[type] = { code, description: `The ${type} relationship, from maxy-code.` };
  }
  return out;
}
/** The relation for one type alone. */
export const relationFor = (type, map) => relationsFor([type], map)[type];

// ---- Payloads ----

const ACTIVITY_PLANS = new Set(["Project"]);
const firstText = (props, keys) => { for (const k of keys) if (filled(props?.[k])) return String(props[k]); return null; };
const isoDay = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && !Number.isNaN(Date.parse(v.slice(0, 10))) ? v.slice(0, 10) : null;

/** The payload of a node's record: the kind's own fields, filled from the node where it has them, then type, labels,
 * source and every property. ctx holds accountId, exportedAt and ownerId, the actor an activity is owned by. */
export function payloadFor(kind, { type, labels, elementId, properties, title }, ctx) {
  const carried = { type, labels, source: { system: SYSTEM, id: elementId }, properties };
  const about = firstText(properties, ["summary", "description", "compiledTruth", "content", "text", "body"]);
  if (kind === "evidence") return {
    summary: text(about ?? title), source_reference: oneLine(`maxy-code account ${ctx.accountId}, node ${elementId}`, 2000),
    source_date: isoDay(properties.createdAt) ?? isoDay(properties.date), standing: "unverified",
    limitations: "Imported from maxy-code as it was kept there; not checked again in fabrik.", ...carried,
  };
  if (kind === "activity") {
    const plan = ACTIVITY_PLANS.has(type);
    return {
      activity_kind: plan ? "plan" : "task", description: text(about ?? ""), completion_requirements: "", state: "pending",
      baseline_start_at: null, baseline_finish_at: null, forecast_start_at: null, forecast_finish_at: null, blockers: [],
      external_references: [], completion_note: "", owner_actor_id: ctx.ownerId, ...(plan ? {} : { task_type: "work" }), ...carried,
    };
  }
  if (kind === "decision") return {
    question: text(firstText(properties, ["question"]) ?? title), alternatives: [], decision: text(firstText(properties, ["decision", "outcome"]) ?? ""),
    rationale: text(firstText(properties, ["rationale", "reason"]) ?? about ?? ""), decided_on: null, ...carried,
  };
  if (kind === "model") return {
    model_kind: "observed_current", source_version: `maxy-code export of ${ctx.exportedAt ?? "an unknown time"}`, source_status: "imported",
    description: text(about ?? ""), graph: { format_version: 1, nodes: [], edges: [] }, ...carried,
  };
  throw new Error(`Unknown record kind ${kind}`);
}

/** A record id made from the account and the node's id, so a node is the same record however often it is imported. */
export function recordIdFor(accountId, elementId) {
  const h = createHash("sha256").update(`${SYSTEM}:${accountId}:${elementId}`).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** The KNOWLEDGE.md draft: each non-Person node's compiledTruthPublic, as ## <name> then the text, in name order. Null when none has one. */
export function knowledgeDraft(nodes) {
  const parts = nodes.filter(n => !n.labels.includes("Person") && !n.trashed && filled(n.properties.compiledTruthPublic))
    .map(n => ({ name: titleFor(n.label, n.elementId, n.properties), body: String(n.properties.compiledTruthPublic).trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return parts.length ? parts.map(p => `## ${p.name}\n\n${p.body}\n`).join("\n") : null;
}

// ---- The export ----

function filesUnder(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p, base));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out.sort();
}
/** A file the operating system writes beside a person's files: .DS_Store, Thumbs.db, desktop.ini, or an AppleDouble ._ file.
 * The exporter leaves out the same names. */
export const isSystemFile = path => { const l = String(path).split("/").pop().toLowerCase(); return l === ".ds_store" || l === "thumbs.db" || l === "desktop.ini" || l.startsWith("._"); };
export const SYSTEM_FILE_REASON = "a system file, not the person's data";
/** A file or folder whose name starts with a dot, such as .claude/ or .mcp.json, is the install's own configuration. The exporter leaves out the same names. */
export const isDotPath = path => String(path).split("/").some(part => part.startsWith("."));
export const DOT_REASON = "the install's own configuration, not the person's data";
/** Where a file the project's size limit refused is said to go. */
export const SIZE_LIMIT_HELP = "Raise the limit in the Supabase dashboard, under Storage, Settings, Upload file size limit (the Free plan allows at most 50 MB), then run the import again: it loads only what is missing.";
// Read a megabyte at a time, so a file of any size is checked without being held in memory.
function sha256File(file) {
  const hash = createHash("sha256"), buffer = Buffer.alloc(1 << 20), fd = openSync(file, "r");
  try { for (let n; (n = readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, n)); } finally { closeSync(fd); }
  return hash.digest("hex");
}

/** The export's manifest, once every file it lists has its sha256 and files/ holds nothing it does not list. */
export function verifyExport(folder) {
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(folder, "manifest.json"), "utf8")); }
  catch (err) { return { ok: false, problem: `${folder} holds no readable manifest.json: ${err instanceof Error ? err.message : err}` }; }
  const listed = manifest?.sha256;
  if (!listed || typeof listed !== "object" || !listed["nodes.jsonl"] || !listed["relationships.jsonl"])
    return { ok: false, problem: "manifest.json lists no sha256 for nodes.jsonl and relationships.jsonl." };
  const problems = [];
  for (const [file, want] of Object.entries(listed)) {
    const path = join(folder, ...file.split("/"));
    if (file.split("/").some(p => p === ".." || p === "") || !existsSync(path)) { problems.push(`${file} is missing`); continue; }
    if (lstatSync(path).isSymbolicLink()) { problems.push(`${file} is a link`); continue; }
    if (sha256File(path) !== want) problems.push(`${file} does not match its sha256`);
  }
  for (const file of filesUnder(join(folder, "files"))) if (!(`files/${file}` in listed) && !isSystemFile(file) && !isDotPath(file)) problems.push(`files/${file} is not in the manifest`);
  if (problems.length) return { ok: false, problem: `The export was changed after it was written, so nothing was imported: ${problems.join("; ")}.` };
  return { ok: true, manifest };
}

const lines = file => readFileSync(file, "utf8").split("\n").filter(l => l.trim() !== "").map((l, i) => {
  try { return JSON.parse(l); } catch { throw new Error(`${file} line ${i + 1} is not JSON`); }
});

// ---- Running ----

/** Runs fn over items, at most `limit` at a time, in order of start. */
async function each(items, limit, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}

const tally = () => ({ exported: 0, loaded: 0, alreadyPresent: 0, leftOut: [] });
/** Adds one left-out item under its reason. expected is true for what the import leaves out by design, such as a skipped
 * label or a missing end, which does not fail it. A link past one of fabrik's limits is lost data, and fails it. */
function leaveOut(row, reason, expected, n = 1) {
  const held = row.leftOut.find(l => l.reason === reason);
  if (held) held.count += n; else row.leftOut.push({ reason, count: n, expected });
}

/**
 * Imports the export in folder. call(fn, args) calls one fabrik function as the signed-in owner and answers { ok, result }
 * or { ok: false, problem }; upload(bucket, path, file) sends one file with upload_file and answers the same way.
 * Returns { ok, report } or { ok: false, problem } when the import was refused before anything was saved.
 */
export async function importMaxy(folder, { call, upload, map, log = () => {}, now = () => new Date() }) {
  const began = now();
  const checked = verifyExport(folder);
  if (!checked.ok) return checked;
  const manifest = checked.manifest;
  let nodeLines, relLines;
  try { nodeLines = lines(join(folder, "nodes.jsonl")); relLines = lines(join(folder, "relationships.jsonl")); }
  catch (err) { return { ok: false, problem: err.message }; }
  const unknown = unknownLabels(nodeLines, map);
  if (unknown.length) return { ok: false, problem: `The export holds labels the label map does not name, so nothing was imported: ${unknown.join(", ")}. Add each to labels or skip in the fabrik plugin's import/maxy-labels.json.` };

  log(`Checked the export: ${nodeLines.length} nodes, ${relLines.length} relationships.`);
  const must = async (fn, args) => {
    const out = await call(fn, args);
    if (!out.ok) throw new Error(`${fn}: ${out.problem}`);
    return out.result;
  };
  const me = await must("fabrik_get_actor", {});
  if (me.authority_class !== "administrator" || me.actor_kind !== "human") return { ok: false, problem: "The import runs as the owner, a person who is an administrator. Sign in as the owner." };
  const scopes = await must("fabrik_get_scopes", {});
  const general = (scopes.items ?? []).find(s => s.code === "general");
  if (!general) return { ok: false, problem: "This fabrik has no General scope, where the import puts its records." };

  const report = {
    folder, accountId: manifest.accountId, exportedAt: manifest.exportedAt, startedAt: began.toISOString(),
    labels: {}, relationships: {}, files: tally(), relationTypesSaved: [], droppedProperties: {}, knowledge: null, problems: [],
  };
  const labelRow = l => (report.labels[l] ??= tally());
  const relRow = t => (report.relationships[t] ??= tally());
  const problem = (what, id, reason) => report.problems.push({ what, id, reason });

  // What the exporter itself left out, from its manifest.
  for (const [l, s] of Object.entries(manifest.skipped ?? {})) { const r = labelRow(l); r.exported += s.count; leaveOut(r, `${l} is not imported: ${s.reason}`, true, s.count); }
  for (const [t, n] of Object.entries(manifest.relationships?.leftOut?.skippedEnd ?? {})) { const r = relRow(t); r.exported += n; leaveOut(r, "an end is a node that is not imported", true, n); }
  const outside = manifest.relationships?.leftOut?.outsideAccount ?? {};
  if (Object.keys(outside).length) report.outsideAccount = outside;

  // The nodes, each classed, its properties cleaned.
  const nodes = new Map();
  for (const line of nodeLines) {
    const real = (line.labels ?? []).filter(l => l !== "Trashed");
    const labels = real.length ? real : ["(no label)"];
    const trashed = line.trashed === true || (line.labels ?? []).includes("Trashed");
    for (const l of labels) labelRow(l).exported++;
    const how = classifyNode(line, map);
    const { properties, dropped } = cleanProperties(line.properties, map.dropProperties);
    for (const k of dropped) report.droppedProperties[k] = (report.droppedProperties[k] ?? 0) + 1;
    if (how.kind === "activity" && isClosed(properties)) how.kind = "evidence";
    if (how.skip === null) problem("node", line.elementId, how.reason);
    nodes.set(line.elementId, { elementId: line.elementId, labels: real, rows: labels, trashed, properties, ...how, state: how.skip !== undefined ? "skipped" : "pending" });
    if (how.skip !== undefined) for (const l of labels) leaveOut(labelRow(l), how.reason, how.skip !== null);
  }

  // The relation types, saved before any link.
  const types = [...new Set(relLines.map(r => r.type))].sort();
  const relations = relationsFor(types, map);
  const held = new Set((await must("fabrik_list_relation_types", {})).map(t => t.code));
  for (const type of types) {
    const rel = relations[type];
    if (rel.problem) continue;
    if (!held.has(rel.code)) {
      const saved = await call("fabrik_save_relation_type", { p_code: rel.code, p_description: rel.description, p_reason: `Relationship type ${type}, imported from maxy-code` });
      if (!saved.ok) { relations[type] = { problem: `the relation ${rel.code} could not be saved: ${saved.problem}` }; continue; }
      held.add(rel.code);
      report.relationTypesSaved.push(rel.code);
    }
  }

  // The records. A node fabrik already holds is left as it is.
  const ctx = { accountId: manifest.accountId, exportedAt: manifest.exportedAt, ownerId: me.accountable_human_id };
  const work = [...nodes.values()].filter(n => n.state === "pending");
  const deleteRecord = async (recordId) => {
    const preview = await must("fabrik_preview_deletion", { p_record_id: recordId });
    if (preview?.deleted) return;
    const request = { ...preview.request, reason: "Trashed in maxy-code" };
    const approval = await must("fabrik_approve_change", { p_issuance_request_id: crypto.randomUUID(), p_executor_id: me.actor_id, p_request: request,
      p_expires_at: new Date(Date.now() + 3600_000).toISOString(), p_reason: "The node was trashed in maxy-code, so its record is imported as deleted." });
    await must("fabrik_delete_record", { p_request: request, p_authorisation_id: approval.authorisation_id });
  };
  // A trashed node's record, saved, is deleted. One whose deletion fails stays saved, is reported as saved, not yet
  // deleted, fails the import, and is deleted by the next run.
  const deleteOrSay = async (n, rows) => {
    try { await deleteRecord(n.recordId); return true; }
    catch (err) {
      rows.forEach(r => { r.savedNotYetDeleted = (r.savedNotYetDeleted ?? 0) + 1; });
      problem("node", n.elementId, `saved, not yet deleted: ${err.message}. Run the import again to delete it.`);
      return false;
    }
  };
  const savingStarted = Date.now();
  let saves = 0, recordsDone = 0;
  log(`Records: ${work.length} nodes to load into General.`);
  await each(work, CONCURRENCY, async (n) => {
    const rows = n.rows.map(labelRow);
    try { await saveNode(n, rows); }
    finally { if (++recordsDone % PROGRESS_EVERY === 0) log(`Records: ${recordsDone} of ${work.length}.`); }
  });
  async function saveNode(n, rows) {
    try {
      const found = await must("fabrik_find_by_source", { p_system: SYSTEM, p_id: n.elementId });
      if (found) {
        n.recordId = found; n.state = "present";
        rows.forEach(r => r.alreadyPresent++);
        if (n.trashed) await deleteOrSay(n, rows);
        return;
      }
      // A record fabrik holds under the node's id is the node's, though its source no longer finds it: one deleted in
      // fabrik, or saved again without its source. It is left as it is, and a deleted one takes no link.
      const recordId = recordIdFor(manifest.accountId, n.elementId);
      const held = await must("fabrik_preview_deletion", { p_record_id: recordId });
      if (held) {
        n.recordId = recordId; n.state = "present"; n.deleted = Boolean(held.deleted);
        rows.forEach(r => r.alreadyPresent++);
        if (n.trashed && !n.deleted) await deleteOrSay(n, rows);
        return;
      }
      const title = titleFor(n.label, n.elementId, n.properties);
      const request = { request_id: crypto.randomUUID(), record_id: recordId, scope_id: general.scope_id, kind: n.kind, expected_previous_version_id: null,
        title, reason: "Imported from maxy-code", links: [], payload: payloadFor(n.kind, { ...n, title }, ctx) };
      n.requestBytes = Buffer.byteLength(JSON.stringify(request));
      const saved = await call("fabrik_save_version", { p_request: request });
      saves++;
      if (!saved.ok) throw new Error(`the save was refused: ${saved.problem}`);
      n.recordId = saved.result.record_id ?? recordId;
      n.state = "loaded";
      rows.forEach(r => r.loaded++);
      if (n.trashed && await deleteOrSay(n, rows)) rows.forEach(r => { r.loadedAsDeleted = (r.loadedAsDeleted ?? 0) + 1; });
    } catch (err) {
      n.state = "failed"; n.problem = err.message;
      rows.forEach(r => leaveOut(r, "the record could not be saved", false));
      problem("node", n.elementId, err.message);
    }
  }
  report.timing = { records: work.length, saves, recordsMs: Date.now() - savingStarted };
  log(`Records: ${work.length} done in ${Math.round(report.timing.recordsMs / 1000)} s.`);

  // The links, each start record's in turn so its versions follow one another; different records side by side.
  const byStart = new Map();
  for (const r of relLines) {
    const row = relRow(r.type);
    row.exported++;
    const rel = relations[r.type];
    if (rel.problem) { leaveOut(row, rel.problem, false); problem("relationship", r.elementId, rel.problem); continue; }
    const ends = [nodes.get(r.start), nodes.get(r.end)];
    if (ends.some(e => !e)) { leaveOut(row, "an end is not in the export", true); continue; }
    const skipped = ends.find(e => e.state === "skipped");
    if (skipped) { leaveOut(row, skipped.skip ? `an end is ${skipped.skip}, which is not imported` : "an end has no label", skipped.skip !== null); continue; }
    if (ends.some(e => e.trashed)) { leaveOut(row, "an end was trashed in maxy-code and is imported as deleted", true); continue; }
    if (ends.some(e => e.deleted)) { leaveOut(row, "an end's record was deleted in fabrik", true); continue; }
    if (ends.some(e => e.state === "failed")) { leaveOut(row, "an end's record could not be saved", false); continue; }
    const list = byStart.get(r.start) ?? [];
    list.push({ ...r, code: rel.code });
    byStart.set(r.start, list);
  }
  // Each link's note is JSON: the relationship's source and properties, and under merged, each other relationship of
  // the same type between the same two nodes, with its properties, while the note stays within fabrik's 4,000 characters.
  const noteIds = note => { try { const v = JSON.parse(note); return [v?.source?.id, ...(v?.merged ?? []).map(m => m?.id)].filter(Boolean); } catch { return []; } };
  const withMerged = (note, entry) => {
    let v;
    try { v = JSON.parse(note); } catch { v = null; }
    if (v === null || typeof v !== "object" || Array.isArray(v)) v = note ? { note } : {};
    return JSON.stringify({ ...v, merged: [...(v.merged ?? []), entry] });
  };
  // A link's share of a save request: its target, relation and note, as the request carries it.
  const linkBytes = (code, note) => Buffer.byteLength(JSON.stringify({ target_version_id: "00000000-0000-0000-0000-000000000000", relation: code, note }));
  const linkTotal = [...byStart.values()].reduce((s, l) => s + l.length, 0);
  let linksDone = 0;
  log(`Links: ${linkTotal} relationships to link.`);
  await each([...byStart.entries()], CONCURRENCY, async ([start, rels]) => {
    const from = nodes.get(start);
    // The note of each link the start record has now, by relation and target, and the bytes its save request takes.
    const notes = new Map();
    let used = from.requestBytes ?? 0;
    try {
      if (from.state === "present") {
        const shown = await must("fabrik_show_record", { p_record: from.recordId });
        for (const l of shown.links ?? []) notes.set(`${l.relation} ${l.target_record_id}`, l.note ?? "");
        used = Buffer.byteLength(JSON.stringify({ title: shown.title, payload: shown.payload })) + 1000;
      }
    } catch (err) {
      for (const r of rels) { leaveOut(relRow(r.type), "the start record's links could not be read", false); problem("relationship", r.elementId, err.message); }
      return;
    }
    for (const [key, note] of notes) used += linkBytes(key.split(" ")[0], note);
    // The links to save, by relation and target, each with the relationships it carries. They go in one call, so the
    // record gains one version however many links it has.
    const pending = new Map();
    // In elementId order, so each run keeps the same 200 when a record has more.
    for (const r of [...rels].sort((a, b) => (a.elementId < b.elementId ? -1 : a.elementId > b.elementId ? 1 : 0))) {
      try { await linkOne(r); }
      finally { if (++linksDone % PROGRESS_EVERY === 0) log(`Links: ${linksDone} of ${linkTotal}.`); }
    }
    async function linkOne(r) {
      const to = nodes.get(r.end), row = relRow(r.type), key = `${r.code} ${to.recordId}`;
      const held = notes.get(key);
      if (held !== undefined && noteIds(held).includes(r.elementId)) { row.alreadyPresent++; return; }
      const merging = held !== undefined;
      if (!merging && notes.size >= LINKS_MAX) { leaveOut(row, LINKS_MAX_REASON, false); return; }
      const { properties } = cleanProperties(r.properties, map.dropProperties);
      const kept = Object.keys(properties).length ? { properties } : {};
      const before = merging ? linkBytes(r.code, held) : 0;
      let note;
      if (merging) {
        note = withMerged(held, { id: r.elementId, ...kept });
        if (note.length > NOTE_MAX || used - before + linkBytes(r.code, note) > REQUEST_BUDGET) { leaveOut(row, "duplicate link, note full", true); return; }
      } else {
        note = JSON.stringify({ source: { system: SYSTEM, id: r.elementId }, ...kept });
        const bare = JSON.stringify({ source: { system: SYSTEM, id: r.elementId } });
        if (note.length > NOTE_MAX || used + linkBytes(r.code, note) > REQUEST_BUDGET) { note = bare; row.propertiesNotKept = (row.propertiesNotKept ?? 0) + 1; }
        if (used + linkBytes(r.code, note) > REQUEST_BUDGET) { leaveOut(row, REQUEST_REASON, false); return; }
      }
      used += linkBytes(r.code, note) - before;
      notes.set(key, note);
      const entry = pending.get(key) ?? { link: { target: to.recordId, relation: r.code }, carried: [] };
      entry.link.note = note;
      entry.carried.push({ r, row, merging });
      pending.set(key, entry);
    }
    if (!pending.size) return;
    const count = ({ carried }) => carried.forEach(c => { if (c.merging) c.row.merged = (c.row.merged ?? 0) + 1; else c.row.loaded++; });
    const refuse = ({ carried }, why) => carried.forEach(c => { leaveOut(c.row, "the link was refused", false); problem("relationship", c.r.elementId, why); });
    const entries = [...pending.values()];
    const all = await call("fabrik_link_many", { p_record: from.recordId, p_links: entries.map(e => e.link), p_reason: "Relationships imported from maxy-code" });
    if (all.ok) { entries.forEach(count); return; }
    // fabrik refused the list, so each link is tried on its own, and only the one it refuses is left out.
    for (const entry of entries) {
      const one = await call("fabrik_link", { p_record: from.recordId, p_target: entry.link.target, p_relation: entry.link.relation,
        p_reason: `Relationship ${entry.carried[0].r.type}, imported from maxy-code`, p_note: entry.link.note });
      if (one.ok) count(entry); else refuse(entry, one.problem);
    }
  });
  log(`Links: ${linkTotal} done.`);

  // The files, to General's bucket under their path in the export.
  // What the exporter left out, then each file here; a system file, there or here, is left out as not the person's data.
  for (const f of manifest.filesLeftOut ?? []) {
    report.files.exported++;
    leaveOut(report.files, [SYSTEM_FILE_REASON, DOT_REASON].includes(f.reason) ? f.reason : `left out by the exporter: ${f.reason}`, true);
  }
  const files = filesUnder(join(folder, "files"));
  let filesDone = 0;
  log(`Files: ${files.length} to upload to General's bucket.`);
  await each(files, CONCURRENCY, async (path) => {
    report.files.exported++;
    try {
      if (isSystemFile(path)) { leaveOut(report.files, SYSTEM_FILE_REASON, true); return; }
      if (isDotPath(path)) { leaveOut(report.files, DOT_REASON, true); return; }
      const file = join(folder, "files", ...path.split("/"));
      // An upload that throws, such as a dropped connection, is one file not loaded, and the import goes on.
      const sent = await upload(general.code, path, file).catch(err => ({ ok: false, problem: err instanceof Error ? err.message : String(err) }));
      if (sent.ok) report.files.loaded++;
      // A resumable upload stopped partway wrote nothing, so the file is not loaded, and a re-run loads it.
      else if (sent.partFailed) { leaveOut(report.files, "the upload stopped partway; a re-run loads it", false); problem("file", path, sent.problem); }
      else if (/already exists|duplicate/i.test(sent.problem ?? "")) report.files.alreadyPresent++;
      else if (sent.status === 413 || /maximum allowed size|too large/i.test(sent.problem ?? "")) {
        const mb = (statSync(file).size / (1024 * 1024)).toFixed(1);
        leaveOut(report.files, `larger than the project's file size limit (${mb} MB)`, false);
        problem("file", path, `${mb} MB is larger than the project's file size limit. ${SIZE_LIMIT_HELP}`);
      }
      else { leaveOut(report.files, "the upload was refused", false); problem("file", path, sent.problem); }
    } finally { if (++filesDone % PROGRESS_EVERY === 0) log(`Files: ${filesDone} of ${files.length}.`); }
  });
  log(`Files: ${files.length} done.`);

  // The public agent's KNOWLEDGE.md draft.
  log("KNOWLEDGE.md: drafting it.");
  const draft = knowledgeDraft([...nodes.values()].filter(n => n.state === "loaded" || n.state === "present"));
  if (!draft) report.knowledge = { sections: 0, written: "nowhere: no node outside Person has a compiledTruthPublic" };
  else {
    const sections = draft.split("\n").filter(l => l.startsWith("## ")).length;
    const place = mkdtempSync(join(tmpdir(), "fabrik-knowledge-"));
    try {
      writeFileSync(join(place, KNOWLEDGE_FILE), draft);
      const sent = await upload(PUBLIC_AGENT_BUCKET, KNOWLEDGE_FILE, join(place, KNOWLEDGE_FILE)).catch(err => ({ ok: false, problem: err instanceof Error ? err.message : String(err) }));
      if (sent.ok) report.knowledge = { sections, written: `the ${PUBLIC_AGENT_BUCKET} bucket` };
      else if (/already exists|duplicate/i.test(sent.problem ?? "")) report.knowledge = { sections, written: `nowhere: the ${PUBLIC_AGENT_BUCKET} bucket already holds a ${KNOWLEDGE_FILE}, which was left as it is` };
      else {
        writeFileSync(join(folder, KNOWLEDGE_FILE), draft);
        report.knowledge = { sections, written: join(folder, KNOWLEDGE_FILE),
          why: /bucket not found/i.test(sent.problem ?? "") ? `fabrik has no ${PUBLIC_AGENT_BUCKET} bucket yet` : `the ${PUBLIC_AGENT_BUCKET} bucket refused it: ${sent.problem}` };
      }
    } finally { rmSync(place, { recursive: true, force: true }); }
  }

  report.finishedAt = now().toISOString();
  const rows = [...Object.values(report.labels), ...Object.values(report.relationships), report.files];
  report.ok = !rows.some(r => r.leftOut.some(l => !l.expected) || r.savedNotYetDeleted);
  writeFileSync(join(folder, REPORT_FILE), JSON.stringify(report, null, 2) + "\n");
  return { ok: true, report };
}

/** The report as lines for a terminal: one line per label, relationship type and the files. */
export function reportLines(report) {
  const row = (name, r) => {
    const out = r.leftOut.map(l => `${l.count} left out: ${l.reason}`).join("; ");
    return `  ${name}: ${r.exported} exported, ${r.loaded} loaded${r.loadedAsDeleted ? ` (${r.loadedAsDeleted} as deleted)` : ""}${r.savedNotYetDeleted ? `, ${r.savedNotYetDeleted} saved, not yet deleted` : ""}`
      + `${r.merged ? `, ${r.merged} merged into a link of the same type between the same records` : ""}, ${r.alreadyPresent} already present${out ? `, ${out}` : ""}`
      + `${r.propertiesNotKept ? `, ${r.propertiesNotKept} with properties too long to keep` : ""}`;
  };
  const sorted = o => Object.keys(o).sort().map(k => row(k, o[k]));
  return [
    `Labels:`, ...sorted(report.labels),
    `Relationship types:`, ...sorted(report.relationships),
    row("Files", report.files).replace(/^  /, ""),
    ...(report.outsideAccount ? [`Relationships to nodes outside this account, not exported: ${Object.entries(report.outsideAccount).map(([t, n]) => `${t} ${n}`).join(", ")}`] : []),
    ...(report.relationTypesSaved.length ? [`Relations saved: ${report.relationTypesSaved.join(", ")}`] : []),
    ...(Object.keys(report.droppedProperties).length ? [`Properties dropped: ${Object.entries(report.droppedProperties).map(([k, n]) => `${k} (${n})`).join(", ")}`] : []),
    `KNOWLEDGE.md: ${report.knowledge.sections} sections, written to ${report.knowledge.written}${report.knowledge.why ? `, because ${report.knowledge.why}` : ""}`,
    ...report.problems.map(p => `Left out ${p.what} ${p.id}: ${p.reason}`),
    report.ok ? "Nothing was left out but skipped labels, links with a missing, trashed or deleted end, system files and full duplicate notes." : "Some of the export was left out for another reason: see above.",
  ];
}
