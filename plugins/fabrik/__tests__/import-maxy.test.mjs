// The import's own rules, beside the stand-in step that drives `fabrik import maxy` end to end: values decoded, the
// drop list, labels refused, titles, relation codes, where the KNOWLEDGE.md draft goes, and when the import fails.
// Run with: node scripts/test.mjs plugins/fabrik/__tests__/import-maxy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanProperties, classifyNode, decodeValue, importMaxy, knowledgeDraft, LABEL_MAP, payloadFor, recordIdFor, relationCode, relationFor, relationsFor,
  titleFor, unknownLabels, verifyExport, isSystemFile, isDotPath } from "../cli/lib/import-maxy.mjs";

const map = JSON.parse(readFileSync(LABEL_MAP, "utf8"));

test("each encoded value decodes to plain JSON", () => {
  assert.equal(decodeValue({ $int: "41" }), 41);
  assert.equal(decodeValue({ $int: "9007199254740993" }), "9007199254740993");
  assert.equal(decodeValue({ $date: "2026-05-06" }), "2026-05-06");
  assert.equal(decodeValue({ $datetime: "2026-05-06T09:00:00+01:00" }), "2026-05-06T09:00:00+01:00");
  assert.equal(decodeValue({ $time: "09:30:00" }), "09:30:00");
  assert.equal(decodeValue({ $duration: "P1DT2H" }), "P1DT2H");
  assert.equal(decodeValue({ $float: "NaN" }), "NaN");
  assert.equal(decodeValue({ $float: "-Infinity" }), "-Infinity");
  assert.deepEqual(decodeValue({ $point: { srid: { $int: "4326" }, x: 1.5, y: 2 } }), { srid: 4326, x: 1.5, y: 2 });
  assert.deepEqual(decodeValue([{ $int: "1" }, "a", 2.5, null]), [1, "a", 2.5, null]);
});

test("every drop-list name goes, matched ignoring case, - and _, and nothing else does", () => {
  const { properties, dropped } = cleanProperties({ name: "Ben", magicToken: "m", slice_token: "s", "API-KEY": "k", Password: "p", tokenCount: { $int: "3" } }, map.dropProperties);
  assert.deepEqual(properties, { name: "Ben", tokenCount: 3 });
  assert.deepEqual(dropped.sort(), ["API-KEY", "Password", "magicToken", "slice_token"]);
});

test("a node carrying magicToken and sliceToken is saved with neither", () => {
  const { properties } = cleanProperties({ name: "Gate", magicToken: "mt-1", sliceToken: "st-1" }, map.dropProperties);
  const payload = payloadFor("evidence", { type: "Person", labels: ["Person"], elementId: "4:a:1", properties, title: "Gate" }, { accountId: "a" });
  assert.doesNotMatch(JSON.stringify(payload), /magicToken|sliceToken|mt-1|st-1/);
});

test("a label in neither labels nor skip is found; a skip label is never imported", () => {
  assert.deepEqual(unknownLabels([{ labels: ["Person"] }, { labels: ["Mystery", "Trashed"] }, { labels: ["AdminUser"] }], map), ["Mystery"]);
  assert.equal(classifyNode({ labels: ["AdminUser"] }, map).skip, "AdminUser");
  assert.equal(classifyNode({ labels: ["Person", "AccessGrant"] }, map).skip, "AccessGrant");
  assert.deepEqual(classifyNode({ labels: ["Trashed", "Task"] }, map), { label: "Task", type: "Task", kind: "activity" });
});

test("a title is the name, else the title, else the label and short id", () => {
  assert.equal(titleFor("Person", "4:x:7", { name: "  Ann\nArcher ", title: "Dr" }), "Ann Archer");
  assert.equal(titleFor("Project", "4:x:7", { name: "", title: "Refit" }), "Refit");
  assert.equal(titleFor("Task", "4:abc:12", {}), "Task 12");
  assert.equal(titleFor("Note", "4:x:1", { name: "x".repeat(600) }).length, 500);
});

test("a relation code is lower-case words joined by underscores, as fabrik's code rule allows", () => {
  assert.equal(relationCode("WORKS_AT"), "works_at");
  assert.equal(relationCode("HAS-2-OWNERS"), "has_owners");
  assert.equal(relationCode("__Odd__Type__"), "odd_type");
  assert.equal(relationCode("123"), null);
  assert.deepEqual(relationFor("WORKS_AT", map), { code: "works_at", description: map.relations.WORKS_AT.description });
  assert.equal(relationFor("HAS-2-OWNERS", map).code, "has_owners");
  assert.match(relationFor("123", map).problem, /no relation code/);
});

test("a record id is the same for the same node and account, and a valid uuid", () => {
  assert.equal(recordIdFor("a", "4:x:1"), recordIdFor("a", "4:x:1"));
  assert.notEqual(recordIdFor("a", "4:x:1"), recordIdFor("b", "4:x:1"));
  assert.match(recordIdFor("a", "4:x:1"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("the KNOWLEDGE.md draft holds every non-Person node with compiledTruthPublic, in name order", () => {
  const n = (labels, properties, trashed = false) => ({ labels, label: labels[0], elementId: "4:x:1", properties, trashed });
  assert.equal(knowledgeDraft([n(["Person"], { name: "Ann", compiledTruthPublic: "No" }), n(["Organization"], { name: "Zed", compiledTruthPublic: "Z." }),
    n(["Project"], { name: "Alpha", compiledTruthPublic: " A. " }), n(["Note"], { name: "Gone", compiledTruthPublic: "G." }, true), n(["Note"], { name: "Empty" })]),
  "## Alpha\n\nA.\n\n## Zed\n\nZ.\n");
  assert.equal(knowledgeDraft([n(["Person"], { name: "Ann", compiledTruthPublic: "No" })]), null);
});

// ---- importMaxy with its calls answered here ----

function writeExport(nodes, rels = [], files = {}, filesLeftOut = []) {
  const dir = mkdtempSync(join(tmpdir(), "maxy-export-test-"));
  mkdirSync(join(dir, "files"));
  writeFileSync(join(dir, "nodes.jsonl"), nodes.map(x => JSON.stringify(x)).join("\n") + "\n");
  writeFileSync(join(dir, "relationships.jsonl"), rels.map(x => JSON.stringify(x)).join("\n"));
  const sha256 = {};
  for (const [name, text] of Object.entries(files)) { writeFileSync(join(dir, "files", name), text); sha256[`files/${name}`] = createHash("sha256").update(text).digest("hex"); }
  for (const f of ["nodes.jsonl", "relationships.jsonl"]) sha256[f] = createHash("sha256").update(readFileSync(join(dir, f))).digest("hex");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ accountId: "acct", exportedAt: "2026-11-15T00:00:00Z", sha256, filesLeftOut }));
  return dir;
}
function fabrik({ refuse = new Set(), upload = () => ({ ok: true }), answers: more = {} } = {}) {
  const calls = [];
  return {
    calls,
    upload: async (bucket, path) => { calls.push(["upload", bucket, path]); return upload(bucket, path); },
    call: async (fn, args) => {
      calls.push([fn, args]);
      if (refuse.has(fn)) return { ok: false, problem: `${fn} refused` };
      const answers = {
        fabrik_get_actor: { actor_id: "me", accountable_human_id: "me", authority_class: "administrator", actor_kind: "human" },
        fabrik_get_scopes: { items: [{ scope_id: "s", code: "general" }] }, fabrik_list_relation_types: [], fabrik_find_by_source: null,
        fabrik_save_version: { record_id: args.p_request?.record_id }, fabrik_save_relation_type: {}, fabrik_link: {},
      };
      if (fn in more) return more[fn](args);
      return { ok: true, result: answers[fn] ?? null };
    },
  };
}

test("an export with an unknown label is refused before any call", async () => {
  const f = fabrik();
  const out = await importMaxy(writeExport([{ elementId: "4:x:1", labels: ["Mystery"], properties: {} }]), { ...f, map });
  assert.equal(out.ok, false);
  assert.match(out.problem, /Mystery/);
  assert.deepEqual(f.calls, []);
});

test("an export whose files changed, or gained a file, is refused before any call", async () => {
  const dir = writeExport([{ elementId: "4:x:1", labels: ["Person"], properties: {} }], [], { "a.txt": "a" });
  writeFileSync(join(dir, "files", "extra.txt"), "x");
  const f = fabrik();
  const out = await importMaxy(dir, { ...f, map });
  assert.match(out.problem, /files\/extra.txt is not in the manifest/);
  assert.deepEqual(f.calls, []);
  assert.equal(verifyExport(writeExport([])).ok, true);
});

test("a refused save fails the import; a skipped label and a missing end do not", async () => {
  const nodes = [{ elementId: "4:x:1", labels: ["Person"], properties: { name: "Ann" } }, { elementId: "4:x:2", labels: ["AdminUser"], properties: {} }];
  const rels = [{ elementId: "5:x:1", type: "ADMIN_OF", start: "4:x:2", end: "4:x:1", properties: {} }, { elementId: "5:x:2", type: "KNOWS", start: "4:x:1", end: "4:x:9", properties: {} }];
  let out = await importMaxy(writeExport(nodes, rels), { ...fabrik(), map });
  assert.equal(out.report.ok, true);
  assert.equal(out.report.relationships.KNOWS.leftOut[0].reason, "an end is not in the export");
  out = await importMaxy(writeExport(nodes, rels), { ...fabrik({ refuse: new Set(["fabrik_save_version"]) }), map });
  assert.equal(out.report.ok, false);
  assert.match(out.report.problems[0].reason, /fabrik_save_version refused/);
});

test("the draft goes to the public agent's bucket when it holds none, is left when it holds one, and goes to the folder when there is no bucket", async () => {
  const nodes = [{ elementId: "4:x:1", labels: ["Organization"], properties: { name: "Acme", compiledTruthPublic: "Bread." } }];
  const run = async (answer) => {
    const dir = writeExport(nodes);
    const out = await importMaxy(dir, { ...fabrik({ upload: (bucket) => bucket === "public-agent" ? answer : { ok: true } }), map });
    return { knowledge: out.report.knowledge, inFolder: existsSync(join(dir, "KNOWLEDGE.md")) };
  };
  let r = await run({ ok: true });
  assert.deepEqual(r, { knowledge: { sections: 1, written: "the public-agent bucket" }, inFolder: false });
  r = await run({ ok: false, problem: "The resource already exists" });
  assert.match(r.knowledge.written, /already holds a KNOWLEDGE.md, which was left as it is/);
  assert.equal(r.inFolder, false);
  r = await run({ ok: false, problem: "Bucket not found" });
  assert.equal(r.knowledge.why, "fabrik has no public-agent bucket yet");
  assert.equal(r.inFolder, true);
});

test("system files are left out, as not the person's data, wherever they are, and do not fail the import", async () => {
  for (const p of [".DS_Store", "a/Thumbs.db", "a/b/._report.pdf", "Desktop.ini"]) assert.equal(isSystemFile(p), true, p);
  for (const p of ["a/DS_Store.txt", "thumbs.dbx", "a._b", ".env"]) assert.equal(isSystemFile(p), false, p);
  const dir = writeExport([{ elementId: "4:x:1", labels: ["Person"], properties: {} }], [], { "a.txt": "a", "._a.txt": "apple" },
    [{ path: "Thumbs.db", reason: "a system file, not the person's data" }, { path: "secrets", reason: "secrets folder" }]);
  writeFileSync(join(dir, "files", ".DS_Store"), "finder");
  const f = fabrik();
  const out = await importMaxy(dir, { ...f, map });
  assert.equal(out.report.ok, true);
  assert.deepEqual(f.calls.filter(c => c[0] === "upload").map(c => c[2]), ["a.txt"]);
  assert.deepEqual(out.report.files.leftOut, [{ reason: "a system file, not the person's data", count: 3, expected: true }, { reason: "left out by the exporter: secrets folder", count: 1, expected: true }]);
  assert.equal(out.report.files.exported, 5);
});

test("a derived code never takes another type's code, so two types never merge into one relation", () => {
  const r = relationsFor(["HAS_TASK", "HAS-TASK", "HAS--TASK", "Supports", "WORKS_AT"], map);
  assert.equal(r.HAS_TASK.code, "has_task");
  assert.equal(r["HAS--TASK"].code, "has_task_two");
  assert.equal(r["HAS-TASK"].code, "has_task_three");
  assert.equal(r.Supports.code, "supports_two");
  assert.equal(r.WORKS_AT.code, "works_at");
  // The same codes whatever order the export gives the types in, so a second run takes the same relations.
  assert.deepEqual(relationsFor(["HAS-TASK", "HAS--TASK", "HAS_TASK"], map), relationsFor(["HAS_TASK", "HAS--TASK", "HAS-TASK"], map));
});

test("a second relationship between the same nodes is merged into the link's note, once, and one that does not fit is left out as expected", async () => {
  const nodes = [{ elementId: "4:x:1", labels: ["Person"], properties: {} }, { elementId: "4:x:2", labels: ["Organization"], properties: {} }];
  const rels = [{ elementId: "5:x:1", type: "WORKS_AT", start: "4:x:1", end: "4:x:2", properties: { since: { $int: "1" } } },
    { elementId: "5:x:2", type: "WORKS_AT", start: "4:x:1", end: "4:x:2", properties: { role: "baker", apiKey: "secret" } },
    { elementId: "5:x:3", type: "WORKS_AT", start: "4:x:1", end: "4:x:2", properties: { long: "x".repeat(4000) } }];
  const dir = writeExport(nodes, rels);
  const f = fabrik();
  let out = await importMaxy(dir, { ...f, map });
  // Both relationships go as one link, in one call.
  const sent = f.calls.filter(c => c[0] === "fabrik_link_many");
  assert.deepEqual([sent.length, sent[0][1].p_links.length, f.calls.filter(c => c[0] === "fabrik_link").length], [1, 1, 0]);
  const notes = sent[0][1].p_links.map(l => JSON.parse(l.note));
  assert.deepEqual(notes.at(-1), { source: { system: "maxy-code", id: "5:x:1" }, properties: { since: 1 }, merged: [{ id: "5:x:2", properties: { role: "baker" } }] });
  const w = out.report.relationships.WORKS_AT;
  assert.deepEqual([w.exported, w.loaded, w.merged, w.alreadyPresent, w.leftOut], [3, 1, 1, 0, [{ reason: "duplicate link, note full", count: 1, expected: true }]]);
  assert.equal(out.report.ok, true);
  // Run again, with fabrik holding the records and that link: nothing is linked again.
  const again = fabrik({ answers: {
    fabrik_find_by_source: ({ p_id }) => ({ ok: true, result: `rec-${p_id}` }),
    fabrik_show_record: () => ({ ok: true, result: { links: [{ relation: "works_at", target_record_id: "rec-4:x:2", note: JSON.stringify(notes.at(-1)) }] } }),
  } });
  out = await importMaxy(dir, { ...again, map });
  const w2 = out.report.relationships.WORKS_AT;
  assert.deepEqual([w2.loaded, w2.merged ?? 0, w2.alreadyPresent], [0, 0, 2]);
  assert.equal(again.calls.filter(c => c[0].startsWith("fabrik_link")).length, 0);
});

test("a trashed node saved but not deleted is reported, fails the import, and is deleted by the next run", async () => {
  const nodes = [{ elementId: "4:x:1", labels: ["Project"], trashed: true, properties: { name: "Gone" } }];
  const dir = writeExport(nodes);
  const first = fabrik({ answers: { fabrik_preview_deletion: () => ({ ok: true, result: null }) } });
  let out = await importMaxy(dir, { ...first, map });
  assert.equal(out.report.labels.Project.loaded, 1);
  assert.equal(out.report.labels.Project.savedNotYetDeleted, 1);
  assert.match(out.report.problems[0].reason, /^saved, not yet deleted/);
  assert.equal(out.report.ok, false);
  const second = fabrik({ answers: {
    fabrik_find_by_source: () => ({ ok: true, result: "rec-1" }),
    fabrik_preview_deletion: () => ({ ok: true, result: { request: { operation: "delete" } } }),
    fabrik_approve_change: () => ({ ok: true, result: { authorisation_id: "auth-1" } }),
  } });
  out = await importMaxy(dir, { ...second, map });
  assert.ok(second.calls.some(c => c[0] === "fabrik_delete_record" && c[1].p_authorisation_id === "auth-1"));
  assert.equal(out.report.labels.Project.alreadyPresent, 1);
  assert.equal(out.report.ok, true);
});

test("a node whose save failed has no KNOWLEDGE.md section", async () => {
  const nodes = [{ elementId: "4:x:1", labels: ["Organization"], properties: { name: "Acme", compiledTruthPublic: "Bread." } },
    { elementId: "4:x:2", labels: ["Organization"], properties: { name: "Failed", compiledTruthPublic: "Not saved." } }];
  const dir = writeExport(nodes);
  const f = fabrik({ upload: () => ({ ok: false, problem: "Bucket not found" }), answers: {
    fabrik_save_version: ({ p_request }) => p_request.title === "Failed" ? { ok: false, problem: "refused" } : { ok: true, result: { record_id: p_request.record_id } },
  } });
  await importMaxy(dir, { ...f, map });
  assert.equal(readFileSync(join(dir, "KNOWLEDGE.md"), "utf8"), "## Acme\n\nBread.\n");
});

test("files and folders named with a dot are left out as the install's own configuration, and do not fail the import", async () => {
  for (const p of [".gitkeep", ".claude/settings.json", "a/.mcp.json"]) assert.equal(isDotPath(p), true, p);
  assert.equal(isDotPath("a/b.txt"), false);
  const dir = writeExport([{ elementId: "4:x:1", labels: ["Person"], properties: {} }], [], { "a.txt": "a", ".gitkeep": "" },
    [{ path: ".claude", reason: "the install's own configuration, not the person's data" }]);
  mkdirSync(join(dir, "files", ".claude"));
  writeFileSync(join(dir, "files", ".claude", "settings.local.json"), "{}");
  const f = fabrik();
  const out = await importMaxy(dir, { ...f, map });
  assert.equal(out.report.ok, true);
  assert.deepEqual(f.calls.filter(c => c[0] === "upload").map(c => c[2]), ["a.txt"]);
  assert.deepEqual(out.report.files.leftOut, [{ reason: "the install's own configuration, not the person's data", count: 3, expected: true }]);
});

test("a file over the project's size limit is left out with its size and how to raise the limit, and fails the import", async () => {
  const dir = writeExport([{ elementId: "4:x:1", labels: ["Person"], properties: {} }], [], { "big.bin": "x".repeat(3 * 1024 * 1024) });
  const out = await importMaxy(dir, { ...fabrik({ upload: (bucket) => bucket === "general" ? { ok: false, status: 413, problem: "The object exceeded the maximum allowed size" } : { ok: true } }), map });
  assert.deepEqual(out.report.files.leftOut, [{ reason: "larger than the project's file size limit (3.0 MB)", count: 1, expected: false }]);
  assert.match(out.report.problems[0].reason, /Upload file size limit/);
  assert.equal(out.report.ok, false);
});

test("a record keeps at most 200 links, the first 200 by elementId, and the rest are left out in one line", async () => {
  const nodes = [{ elementId: "4:x:000", labels: ["Person"], properties: {} }];
  const rels = [];
  for (let i = 1; i <= 203; i++) {
    nodes.push({ elementId: `4:x:${String(i).padStart(3, "0")}`, labels: ["Organization"], properties: {} });
    rels.push({ elementId: `5:x:${String(204 - i).padStart(3, "0")}`, type: "WORKS_AT", start: "4:x:000", end: `4:x:${String(i).padStart(3, "0")}`, properties: {} });
  }
  const f = fabrik();
  const out = await importMaxy(writeExport(nodes, rels), { ...f, map });
  const w = out.report.relationships.WORKS_AT;
  assert.deepEqual([w.exported, w.loaded, w.leftOut], [203, 200, [{ reason: "fabrik keeps at most 200 links on a record", count: 3, expected: false }]]);
  // The 200 links go in one call, so the record gains one version.
  const many = f.calls.filter(c => c[0] === "fabrik_link_many");
  assert.equal(many.length, 1);
  const linked = many[0][1].p_links.map(l => JSON.parse(l.note).source.id);
  assert.equal(linked[0], "5:x:001");
  assert.equal(linked.at(-1), "5:x:200");
  // Links past the limit are lost, so the import fails.
  assert.equal(out.report.ok, false);
});

test("a record's links stop before its save request passes 256 KiB: properties are dropped from the note first, then links are left out", async () => {
  const nodes = [{ elementId: "4:x:000", labels: ["Person"], properties: {} }];
  const rels = [];
  for (let i = 1; i <= 120; i++) {
    nodes.push({ elementId: `4:x:${String(i).padStart(3, "0")}`, labels: ["Organization"], properties: {} });
    rels.push({ elementId: `5:x:${String(i).padStart(3, "0")}`, type: "WORKS_AT", start: "4:x:000", end: `4:x:${String(i).padStart(3, "0")}`, properties: { history: "h".repeat(3800) } });
  }
  const f = fabrik();
  const out = await importMaxy(writeExport(nodes, rels), { ...f, map });
  const w = out.report.relationships.WORKS_AT;
  const notes = f.calls.filter(c => c[0] === "fabrik_link_many").flatMap(c => c[1].p_links.map(l => l.note));
  // The one request carries every link's note, so its bytes are the sum.
  const total = notes.reduce((s, n) => s + Buffer.byteLength(n) + 100, 0);
  assert.ok(total < 262144 * 0.9, `${total}`);
  assert.ok(w.propertiesNotKept > 0);
  assert.equal(w.loaded + w.leftOut.reduce((s, l) => s + l.count, 0), 120);
  assert.deepEqual(w.leftOut.map(l => [l.reason, l.expected]), [["the record's links would pass fabrik's 256 KiB limit on one save", false]]);
  assert.equal(out.report.ok, false);
});

test("a resumable upload sends a file over 6 MB in parts of exactly 6 MB, and gives Supabase's status for a refusal", async () => {
  const { resumableUpload, RESUMABLE_PART } = await import("../cli/lib/session.mjs");
  const { createServer } = await import("node:http");
  const parts = [];
  let made = null, refuse = null;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST") {
        if (refuse) { res.writeHead(refuse.status, { "content-type": "application/json" }); return res.end(JSON.stringify(refuse.body)); }
        made = { length: Number(req.headers["upload-length"]), meta: Object.fromEntries(req.headers["upload-metadata"].split(",").map(p => { const [k, v] = p.split(" "); return [k, Buffer.from(v, "base64").toString()]; })) };
        res.writeHead(201, { location: "/storage/v1/upload/resumable/u1" }); return res.end();
      }
      const body = Buffer.concat(chunks);
      parts.push({ offset: Number(req.headers["upload-offset"]), length: body.length, type: req.headers["content-type"] });
      res.writeHead(204, { "upload-offset": String(Number(req.headers["upload-offset"]) + body.length) }); res.end();
    });
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const size = RESUMABLE_PART * 2 + 12345;
    const data = Buffer.alloc(size, 7);
    const out = await resumableUpload(url, "k", "t", "general", "uploads/big.bin", size, (b, n, at) => data.copy(b, 0, at, at + n), "application/octet-stream");
    assert.equal(out.ok, true);
    assert.deepEqual(made, { length: size, meta: { bucketName: "general", objectName: "uploads/big.bin", contentType: "application/octet-stream", cacheControl: "3600" } });
    assert.deepEqual(parts.map(p => [p.offset, p.length]), [[0, RESUMABLE_PART], [RESUMABLE_PART, RESUMABLE_PART], [RESUMABLE_PART * 2, 12345]]);
    assert.ok(parts.every(p => p.type === "application/offset+octet-stream"));
    refuse = { status: 413, body: { statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size" } };
    const big = await resumableUpload(url, "k", "t", "general", "x.bin", size, () => 0, "application/octet-stream");
    assert.deepEqual(big, { ok: false, status: 413, problem: "The object exceeded the maximum allowed size" });
  } finally { server.close(); }
});

test("a 409 on a resumable upload's part is not taken as a file already there: the part is sent again, and still failing, the file is not loaded", async () => {
  const { resumableUpload, RESUMABLE_PART, PART_RETRIES } = await import("../cli/lib/session.mjs");
  const { createServer } = await import("node:http");
  let patches = 0, failFirst = Infinity;
  const server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.method === "POST") { res.writeHead(201, { location: "/storage/v1/upload/resumable/u1" }); return res.end(); }
      if (req.method === "HEAD") { res.writeHead(404); return res.end(); }
      patches++;
      if (patches <= failFirst) { res.writeHead(409, { "content-type": "application/json" }); return res.end(JSON.stringify({ statusCode: "409", error: "Duplicate", message: "The resource already exists" })); }
      res.writeHead(204, { "upload-offset": String(Number(req.headers["upload-offset"]) + Number(req.headers["content-length"])) }); res.end();
    });
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  const size = RESUMABLE_PART + 10;
  const read = (b, n) => n;
  try {
    // Two failures, then the part goes through: the upload succeeds.
    failFirst = PART_RETRIES;
    assert.equal((await resumableUpload(url, "k", "t", "general", "a.bin", size, read, "application/octet-stream")).ok, true);
    assert.equal(patches, PART_RETRIES + 2);
    // Failing every time: three tries, then partFailed, with no status a caller could read as already there.
    patches = 0; failFirst = Infinity;
    const out = await resumableUpload(url, "k", "t", "general", "a.bin", size, read, "application/octet-stream");
    assert.equal(patches, PART_RETRIES + 1);
    assert.equal(out.partFailed, true);
    assert.equal(out.status, undefined);
    assert.match(out.problem, /stopped at byte 0 of 6291466, after 3 tries/);
  } finally { server.close(); }
  // The import counts such a file as not loaded, and fails.
  const dir = writeExport([{ elementId: "4:x:1", labels: ["Person"], properties: {} }], [], { "big.bin": "x" });
  const out = await importMaxy(dir, { ...fabrik({ upload: (bucket) => bucket === "general" ? { ok: false, partFailed: true, problem: "The upload of big.bin stopped at byte 0 of 7000000, after 3 tries: The resource already exists" } : { ok: true } }), map });
  assert.deepEqual([out.report.files.loaded, out.report.files.alreadyPresent], [0, 0]);
  assert.deepEqual(out.report.files.leftOut, [{ reason: "the upload stopped partway; a re-run loads it", count: 1, expected: false }]);
  assert.equal(out.report.ok, false);
});

test("a name that says it holds a secret is dropped though the drop list does not name it, and a count of tokens is kept", () => {
  const { properties, dropped } = cleanProperties({ name: "Ben", passwordHash: "h", client_secret: "c", sessionToken: "s", stripeApiKey: "k", "Private-Key": "p", refreshTokenEnc: "e",
    tokenCount: { $int: "3" }, maxTokens: { $int: "9" }, keywords: ["a"] }, map.dropProperties);
  assert.deepEqual(properties, { name: "Ben", tokenCount: 3, maxTokens: 9, keywords: ["a"] });
  assert.deepEqual(dropped.sort(), ["Private-Key", "client_secret", "passwordHash", "refreshTokenEnc", "sessionToken", "stripeApiKey"]);
});

test("a record fabrik holds under the node's id, its source gone or the record deleted, is left as it is, and a deleted one takes no link", async () => {
  const nodes = [{ elementId: "4:x:1", labels: ["Person"], properties: { name: "Ann" } }, { elementId: "4:x:2", labels: ["Organization"], properties: { name: "Acme" } },
    { elementId: "4:x:3", labels: ["Organization"], properties: { name: "Gone" } }];
  const rels = [{ elementId: "5:x:1", type: "WORKS_AT", start: "4:x:1", end: "4:x:2", properties: {} }, { elementId: "5:x:2", type: "WORKS_AT", start: "4:x:1", end: "4:x:3", properties: {} }];
  const ids = { ann: recordIdFor("acct", "4:x:1"), gone: recordIdFor("acct", "4:x:3") };
  // Ann's record was saved again in fabrik without its source; Gone's was deleted there. Neither is found by its source.
  const f = fabrik({ answers: {
    fabrik_preview_deletion: ({ p_record_id }) => ({ ok: true, result: p_record_id === ids.ann ? { record_id: ids.ann, request: {} } : p_record_id === ids.gone ? { deleted: { record_id: ids.gone } } : null }),
    fabrik_show_record: () => ({ ok: true, result: { title: "Ann", payload: {}, links: [] } }),
  } });
  const out = await importMaxy(writeExport(nodes, rels), { ...f, map });
  const saved = f.calls.filter(c => c[0] === "fabrik_save_version").map(c => c[1].p_request.title);
  assert.deepEqual(saved, ["Acme"]);
  assert.deepEqual([out.report.labels.Person.alreadyPresent, out.report.labels.Organization.loaded, out.report.labels.Organization.alreadyPresent], [1, 1, 1]);
  assert.deepEqual(out.report.problems, []);
  const w = out.report.relationships.WORKS_AT;
  assert.deepEqual([w.loaded, w.leftOut], [1, [{ reason: "an end's record was deleted in fabrik", count: 1, expected: true }]]);
  assert.equal(out.report.ok, true);
});

test("an upload that throws leaves that file out, and the import goes on to write its report", async () => {
  const dir = writeExport([{ elementId: "4:x:1", labels: ["Person"], properties: {} }], [], { "a.txt": "a", "b.txt": "b" });
  const f = fabrik({ upload: (bucket, path) => { if (path === "a.txt") throw new Error("fetch failed"); return { ok: true }; } });
  const out = await importMaxy(dir, { ...f, map });
  assert.deepEqual([out.report.files.loaded, out.report.files.leftOut], [1, [{ reason: "the upload was refused", count: 1, expected: false }]]);
  assert.deepEqual(out.report.problems, [{ what: "file", id: "a.txt", reason: "fetch failed" }]);
  assert.equal(out.report.ok, false);
  assert.equal(existsSync(join(dir, "import-report.json")), true);
});

test("a resumable upload that cannot be started, or whose part landed though its answer was lost, is answered, and the part is not sent twice", async () => {
  const { resumableUpload, RESUMABLE_PART } = await import("../cli/lib/session.mjs");
  const { createServer } = await import("node:http");
  let held = 0, patches = 0, heads = 0;
  const server = createServer((req, res) => {
    let got = 0;
    req.on("data", chunk => { got += chunk.length; });
    req.on("end", () => {
      if (req.method === "POST") { res.writeHead(201, { location: "/storage/v1/upload/resumable/u1" }); return res.end(); }
      if (req.method === "HEAD") { heads++; res.writeHead(200, { "upload-offset": String(held) }); return res.end(); }
      patches++;
      if (Number(req.headers["upload-offset"]) !== held) { res.writeHead(409); return res.end("Offset conflict"); }
      held += got;
      // The first part is kept, and its answer is lost.
      if (patches === 1) return req.socket.destroy();
      res.writeHead(204, { "upload-offset": String(held) }); res.end();
    });
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  const size = RESUMABLE_PART + 10;
  try {
    const out = await resumableUpload(url, "k", "t", "general", "a.bin", size, (b, n) => n, "application/octet-stream");
    assert.deepEqual([out.ok, patches, heads, held], [true, 2, 1, size]);
  } finally { server.close(); }
  // No server there: an answer, not a throw.
  const none = await resumableUpload(url, "k", "t", "general", "a.bin", size, (b, n) => n, "application/octet-stream");
  assert.equal(none.ok, false);
  assert.match(none.problem, /The upload of a\.bin could not be started/);
});

test("a task, event or run that is over is saved as evidence with its type, and one still open as a pending task", async () => {
  const nodes = [{ elementId: "4:x:1", labels: ["Task"], properties: { name: "Paint the shop", status: "completed" } },
    { elementId: "4:x:2", labels: ["Task"], properties: { name: "Order flour", status: "active" } },
    { elementId: "4:x:3", labels: ["Event"], properties: { name: "Tasting", eventStatus: "Cancelled" } },
    { elementId: "4:x:4", labels: ["WorkflowRun"], properties: { name: "Nightly", status: "failed" } },
    { elementId: "4:x:5", labels: ["Task"], properties: { name: "No status" } }];
  const f = fabrik();
  const out = await importMaxy(writeExport(nodes), { ...f, map });
  const saved = Object.fromEntries(f.calls.filter(c => c[0] === "fabrik_save_version").map(c => [c[1].p_request.title, c[1].p_request]));
  assert.deepEqual(Object.entries(saved).map(([title, r]) => [title, r.kind, r.payload.type, r.payload.state]).sort(), [
    ["Nightly", "evidence", "WorkflowRun", undefined], ["No status", "activity", "Task", "pending"], ["Order flour", "activity", "Task", "pending"],
    ["Paint the shop", "evidence", "Task", undefined], ["Tasting", "evidence", "Event", undefined]]);
  assert.equal(saved["Paint the shop"].payload.properties.status, "completed");
  assert.equal(out.report.ok, true);
});

test("when fabrik refuses a record's list of links, each is tried on its own, and only the one it refuses is left out", async () => {
  const nodes = [{ elementId: "4:x:1", labels: ["Person"], properties: {} }, { elementId: "4:x:2", labels: ["Organization"], properties: {} }, { elementId: "4:x:3", labels: ["Organization"], properties: {} }];
  const rels = [{ elementId: "5:x:1", type: "WORKS_AT", start: "4:x:1", end: "4:x:2", properties: {} }, { elementId: "5:x:2", type: "WORKS_AT", start: "4:x:1", end: "4:x:3", properties: {} }];
  const bad = recordIdFor("acct", "4:x:3");
  const f = fabrik({ answers: {
    fabrik_link_many: () => ({ ok: false, problem: "refused as a list" }),
    fabrik_link: ({ p_target }) => p_target === bad ? { ok: false, problem: "no link to that record" } : { ok: true, result: {} },
  } });
  const out = await importMaxy(writeExport(nodes, rels), { ...f, map });
  const w = out.report.relationships.WORKS_AT;
  assert.deepEqual([w.loaded, w.leftOut], [1, [{ reason: "the link was refused", count: 1, expected: false }]]);
  assert.deepEqual(out.report.problems, [{ what: "relationship", id: "5:x:2", reason: "no link to that record" }]);
  assert.equal(f.calls.filter(c => c[0] === "fabrik_link").length, 2);
});
