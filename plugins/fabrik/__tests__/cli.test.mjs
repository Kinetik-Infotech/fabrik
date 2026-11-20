// The fabrik command at a terminal, as a person runs it, against a local stand-in for Supabase's Auth
// and REST endpoints. Its drawing runs the fabrik plugin's own scripts, with Python 3.
// Run with: node scripts/test.mjs plugins/fabrik/__tests__/cli.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const FABRIK = fileURLToPath(new URL("../cli/fabrik.mjs", import.meta.url));
const PROGRESS = fileURLToPath(new URL("./progress.json", import.meta.url));
const REF = "abcdefghijklmnopqrst";
const OTHER = "tsrqponmlkjihgfedcba";
const KEY = "sb_publishable_test";
const USER = { id: "0b6c1f5e-0000-4000-8000-000000000001", email: "person@example.com" };

/** A stand-in for one project's Auth and REST endpoints. fabrik's refusals come back as PostgREST gives them. answers
 * gives a fabrik function's answer by its name, as a value or as a function of the call's arguments. */
async function supabase(answers = {}) {
  const state = { calls: [], n: 0, refresh: new Set([`rt-${REF}`, `rt-${OTHER}`]), access: new Set() };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const json = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : {};
    const url = new URL(req.url, "http://x");
    state.calls.push({ path: url.pathname, profile: req.headers["content-profile"], body: json });
    const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.apikey !== KEY) return send(401, { message: "No API key found in request" });
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      if (!state.refresh.delete(json.refresh_token)) return send(400, { msg: "Invalid Refresh Token: Refresh Token Not Found" });
      state.n += 1;
      state.refresh.add(`rt-${state.n}`);
      state.access.add(`at-${state.n}`);
      return send(200, { access_token: `at-${state.n}`, refresh_token: `rt-${state.n}`, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: USER });
    }
    if (!state.access.has(req.headers.authorization?.replace(/^Bearer /, ""))) return send(403, { msg: "invalid JWT" });
    if (url.pathname === "/rest/v1/rpc/fabrik_set_state") return send(400, { code: "42501", message: "No grant of yours covers edit, start on activity records in Project Riverside." });
    // fabrik answers a refusal it has logged as change_refused, in place of raising it.
    if (url.pathname === "/rest/v1/rpc/fabrik_add_scope") return send(200, { refused: true, problem: "Only an administrator adds a scope" });
    const answer = answers[url.pathname.replace("/rest/v1/rpc/", "")];
    if (answer !== undefined) return send(200, typeof answer === "function" ? answer(json) : answer);
    if (url.pathname.startsWith("/rest/v1/rpc/fabrik_")) return send(200, { received: json });
    return send(404, { code: "PGRST202", message: `Could not find the function ${url.pathname}` });
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise(done => server.close(done));
  return state;
}

/** A private home with a saved sign-in for each project given, and a working folder. */
function person(project, refs = [REF]) {
  const home = mkdtempSync(join(tmpdir(), "fabrik-cli-home-"));
  for (const ref of refs) {
    const folder = join(home, ".config", "supabase-auth", ref);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const file = join(folder, `${USER.email}.json`);
    writeFileSync(file, JSON.stringify({ version: 1, projectRef: ref, url: project.url, publishableKey: KEY, email: USER.email, refreshToken: `rt-${ref}` }));
    chmodSync(file, 0o600);
  }
  // The working folder by its real path, as the command sees it.
  const work = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-cli-work-")));
  return { home, work };
}

/** Runs the command as a person types it, in the working folder. */
async function fabrik({ home, work }, args, env = {}) {
  const child = spawn(process.execPath, [FABRIK, ...args], { cwd: work, env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ...env } });
  let out = "", err = "";
  child.stdout.on("data", chunk => { out += chunk; });
  child.stderr.on("data", chunk => { err += chunk; });
  const code = await new Promise(done => child.on("close", done));
  return { code, out, err };
}

test("with no name, the command prints its usage and every tool's name", async () => {
  const ran = await fabrik({ home: tmpdir(), work: tmpdir() }, []);
  assert.equal(ran.code, 0);
  assert.match(ran.out, /^Usage: node fabrik\.mjs/);
  for (const tool of ["whoami", "upload_file", "download_file", "draw_board", "draw_graph", "draw_reference", "draw_sop", "print_pdf"]) assert.match(ran.out, new RegExp(tool));
});

test("a fabrik function is called in the fabrik schema, with objects, lists and true as JSON, and numbers and words as text", async () => {
  const project = await supabase();
  try {
    const me = person(project);
    writeFileSync(join(me.work, "fields.json"), JSON.stringify({ description: "From a file" }));
    const ran = await fabrik(me, ["fabrik_change_record", "p_record=Map the order intake", "p_fields=@fields.json", "p_preview=true", "p_reason=Started", "p_limit=5"]);
    assert.equal(ran.code, 0, ran.err);
    assert.deepEqual(JSON.parse(ran.out), { received: { p_record: "Map the order intake", p_fields: { description: "From a file" }, p_preview: true, p_reason: "Started", p_limit: "5" } });
    const call = project.calls.find(one => one.path === "/rest/v1/rpc/fabrik_change_record");
    assert.equal(call.profile, "fabrik");
  } finally { await project.close(); }
});

test("an object's fields may be given one at a time, and a list of files one file at a time", async () => {
  const project = await supabase();
  try {
    const me = person(project);
    const ran = await fabrik(me, ["fabrik_add_record", "p_scope=general", "p_fields.description=Two words", "p_fields.index=1.2", "progress_files=a.json", "progress_files=b.json"]);
    assert.equal(ran.code, 0, ran.err);
    assert.deepEqual(JSON.parse(ran.out).received, { p_scope: "general", p_fields: { description: "Two words", index: "1.2" }, progress_files: [join(me.work, "a.json"), join(me.work, "b.json")] });
    const twice = await fabrik(me, ["fabrik_add_record", "p_scope=general", "p_scope=other"]);
    assert.equal(twice.code, 2);
    assert.match(twice.err, /p_scope is given twice/);
  } finally { await project.close(); }
});

test("a field of an object is sent as typed, so a bucket path stays a bucket path", async () => {
  const project = await supabase();
  try {
    const me = person(project);
    const ran = await fabrik(me, ["fabrik_purge_check", "body.bucket=finance", "body.file=reports/q3.pdf", "file=q3.pdf"]);
    assert.equal(ran.code, 0, ran.err);
    assert.deepEqual(JSON.parse(ran.out).received, { body: { bucket: "finance", file: "reports/q3.pdf" }, file: join(me.work, "q3.pdf") });
  } finally { await project.close(); }
});

test("a result file is written in the working folder, named without its folder", async () => {
  const project = await supabase();
  try {
    const me = person(project);
    const ran = await fabrik(me, ["fabrik_get_progress", "p_scope_id=00000000-0000-4000-8000-000000000001", "result_file=progress.json"]);
    assert.equal(ran.code, 0, ran.err);
    assert.deepEqual(JSON.parse(readFileSync(join(me.work, "progress.json"), "utf-8")), { received: { p_scope_id: "00000000-0000-4000-8000-000000000001" } });
    assert.equal(project.calls.find(one => one.path === "/rest/v1/rpc/fabrik_get_progress").body.result_file, undefined);
  } finally { await project.close(); }
});

test("fabrik's refusal is printed as fabrik gives it, and the command exits 1", async () => {
  const project = await supabase();
  try {
    const ran = await fabrik(person(project), ["fabrik_set_state", "p_record=Map the order intake", "p_state=in_progress", "p_reason=Started"]);
    assert.equal(ran.code, 1);
    assert.equal(ran.err.trim(), "No grant of yours covers edit, start on activity records in Project Riverside.");
    assert.equal(ran.out, "");
  } finally { await project.close(); }
});

test("a refusal fabrik answers, and logs as change_refused, is printed as its problem sentence, and the command exits 1", async () => {
  const project = await supabase();
  try {
    const ran = await fabrik(person(project), ["fabrik_add_scope", "p_code=lettings", "p_display_name=Lettings", "p_description=Lettings work", "p_reason=New team"]);
    assert.equal(ran.code, 1);
    assert.equal(ran.err.trim(), "Only an administrator adds a scope");
    assert.equal(ran.out, "");
  } finally { await project.close(); }
});

test("with two sign-ins saved, the command names both, and the plugin's settings choose one", async () => {
  const project = await supabase();
  try {
    const me = person(project, [REF, OTHER]);
    const refused = await fabrik(me, ["whoami"]);
    assert.equal(refused.code, 1);
    assert.match(refused.err, new RegExp(`--project ${REF} --email ${USER.email}`));
    assert.match(refused.err, new RegExp(`--project ${OTHER} --email ${USER.email}`));
    const chosen = await fabrik(me, ["fabrik_get_actor"], { SUPABASE_PROJECT_REF: OTHER, SUPABASE_AUTH_EMAIL: USER.email });
    assert.equal(chosen.code, 0, chosen.err);
    const named = await fabrik(me, ["--project", REF, "--email", USER.email, "fabrik_get_actor"]);
    assert.equal(named.code, 0, named.err);
  } finally { await project.close(); }
});

test("with no sign-in saved, the command gives the sign-in command and no instruction meant for an agent", async () => {
  const home = mkdtempSync(join(tmpdir(), "fabrik-cli-home-"));
  const ran = await fabrik({ home, work: home }, ["fabrik_get_actor"]);
  assert.equal(ran.code, 1);
  // The path is quoted for the shell, so a folder with a space in its name still runs.
  assert.match(ran.err, /Sign in with: node ["'].*fabrik\.mjs["'] sign-in\n$/);
  // The folder's path is left out, since a checkout's folder name may hold any word.
  assert.doesNotMatch(ran.err.replace(/node ["'].*["'] sign-in/, ""), /chat/);
});

test("an unknown name, or an argument without a value, is refused", async () => {
  const home = mkdtempSync(join(tmpdir(), "fabrik-cli-home-"));
  const unknown = await fabrik({ home, work: home }, ["get_scopes"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /get_scopes is not a fabrik function or a tool/);
  const bare = await fabrik({ home, work: home }, ["fabrik_get_actor", "p_limit"]);
  assert.equal(bare.code, 2);
  assert.match(bare.err, /p_limit is not <argument>=<value>/);
});

test("a board is drawn from a progress file named without its folder", async () => {
  const work = mkdtempSync(join(tmpdir(), "fabrik-cli-work-"));
  copyFileSync(PROGRESS, join(work, "progress.json"));
  const ran = await fabrik({ home: work, work }, ["draw_board", "progress_files=progress.json", "page_file=board.html", "purpose=Check the board"]);
  if (ran.code !== 0 && /Python 3 is not on this computer/.test(ran.err)) return;
  assert.equal(ran.code, 0, ran.err);
  assert.equal(JSON.parse(ran.out).ok, undefined);
  assert.ok(existsSync(join(work, "board.html")));
  assert.ok(existsSync(join(work, "board.outline.md")));
  assert.match(readFileSync(join(work, "board.html"), "utf-8"), /Check the board/);
});

const QUESTION = JSON.parse(readFileSync(new URL("./widgets/question-data.json", import.meta.url), "utf-8"));

test("draw_widget draws a question card from a data file, and returns its question word for word", async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-cli-work-")));
  writeFileSync(join(work, "question.json"), JSON.stringify(QUESTION));
  const ran = await fabrik({ home: work, work }, ["draw_widget", "kind=question", "data_file=question.json"]);
  assert.equal(ran.code, 0, ran.err);
  const drawn = JSON.parse(ran.out);
  assert.deepEqual([drawn.kind, drawn.count, drawn.question], ["question", 3, QUESTION.question]);
  const code = drawn.widget_code;
  assert.deepEqual(JSON.parse(code.match(/<script type="application\/json" id="widget-data">([\s\S]*?)<\/script>/)[1]), QUESTION);
  assert.equal(code.match(/<\/script>/g).length, 2, "the data block and the one script, with each < in the data as \\u003c");
  assert.doesNotMatch(code, /<!doctype|<html|<body|sendPrompt|<button|fetch\(|XMLHttpRequest|https?:\/\//i);
  // The card's script, run with no document, as the chat runs it before the page is ready.
  const context = {};
  runInNewContext(code.match(/<script>\n([\s\S]*?)<\/script>/)[1], context);
  const html = context.draw(QUESTION);
  assert.match(html, /<h2>Scope for the Card test note<\/h2>/);
  assert.match(html, /A note belongs to one scope &lt;\/script&gt;&lt;img src=x onerror=alert\(1\)&gt;\./);
  assert.match(html, /<strong>Clients<\/strong> <span class="wk-sub">3f9c2a1e<\/span>/);
  assert.match(html, /<tr><th>Records<\/th><td><span class="wk-value">4<\/span><\/td><\/tr>/);
  assert.match(html, /<tr><th>Purpose<\/th><td><span class="wk-old">empty<\/span><\/td><\/tr>/);
  assert.match(html, /<div class="wk-row"><p><strong>Private<\/strong><\/p><\/div>/, "a choice shows its name alone");
  assert.doesNotMatch(html, /Move the Card test note/, "the question is asked in the next-step box, not on the card");
});

test("the question card takes its colours from the chat's theme, and its escape from fabrik's cards' kit", async () => {
  const kit = readFileSync(new URL("../widgets/kit.html", import.meta.url), "utf-8");
  assert.doesNotMatch(kit, /prefers-color-scheme|function esc/, "the app's theme, not the computer's, and one esc for every card");
  assert.match(kit, /--wk-ink: var\(--color-text-primary/);
  const cardsEsc = readFileSync(new URL("../cards/kit.html", import.meta.url), "utf-8").match(/\nfunction esc\(v\) \{\n[\s\S]*?\n\}\n/)[0];
  const work = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-cli-work-")));
  writeFileSync(join(work, "question.json"), JSON.stringify(QUESTION));
  const drawn = JSON.parse((await fabrik({ home: work, work }, ["draw_widget", "kind=question", "data_file=question.json"])).out);
  assert.ok(drawn.widget_code.includes(cardsEsc.slice(1)));
});

test("draw_widget refuses a kind other than question, and a data file with a field missing, naming each, and draws nothing", async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-cli-work-")));
  const { person: _person, ...noPerson } = QUESTION;
  writeFileSync(join(work, "short.json"), JSON.stringify({ ...noPerson, question: "Move it?\nAnd save it?", rows: [{ name: "" }] }));
  writeFileSync(join(work, "many.json"), JSON.stringify({ ...QUESTION, rows: Array(21).fill(QUESTION.rows[1]) }));
  const short = await fabrik({ home: work, work }, ["draw_widget", "kind=question", "data_file=short.json"]);
  assert.equal(short.code, 1);
  assert.equal(short.err, `${join(work, "short.json")} lacks person, question, one line of 100 characters at most, rows[0].name. Nothing was drawn.\n`);
  const many = await fabrik({ home: work, work }, ["draw_widget", "kind=question", "data_file=many.json"]);
  assert.equal(many.err, `${join(work, "many.json")} lacks rows, a list of 1 to 20 rows. Nothing was drawn.\n`);
  const board = await fabrik({ home: work, work }, ["draw_widget", "kind=board", "data_file=many.json"]);
  assert.equal(board.err, 'kind is "board". It is question or list: fabrik shows records on the connector\'s show_records card.\n');
});

// Three scopes, as list_scopes returned them in a desktop Code session on ~/fabrik, for the list card.
const LIST = { kind: "list", person: "Test Person", drawn_at: "18 November 2026, 11:20:04 UK time", title: "Your scopes",
  rows: [{ name: "General", code: "0b6c1f5e" }, { name: "Clients", code: "3f9c2a1e" }, { name: "Private", code: "9d2e4a70" }] };

test("draw_widget draws a list card of three scopes with no question, and refuses a list with a question", async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-cli-work-")));
  writeFileSync(join(work, "list.json"), JSON.stringify(LIST));
  const ran = await fabrik({ home: work, work }, ["draw_widget", "kind=list", "data_file=list.json"]);
  assert.equal(ran.code, 0, ran.err);
  const drawn = JSON.parse(ran.out);
  assert.deepEqual([drawn.kind, drawn.count, drawn.question], ["list", 3, null]);
  const context = {};
  runInNewContext(drawn.widget_code.match(/<script>\n([\s\S]*?)<\/script>/)[1], context);
  const html = context.draw(LIST);
  assert.match(html, /<h2>Your scopes<\/h2>/);
  assert.match(html, /<strong>Clients<\/strong> <span class="wk-sub">3f9c2a1e<\/span>/);
  writeFileSync(join(work, "asked.json"), JSON.stringify({ ...LIST, question: "Which scope?" }));
  const asked = await fabrik({ home: work, work }, ["draw_widget", "kind=list", "data_file=asked.json"]);
  assert.equal(asked.code, 1);
  assert.equal(asked.err, `${join(work, "asked.json")} lacks no question, which a list card holds none of. Nothing was drawn.\n`);
  writeFileSync(join(work, "long.json"), JSON.stringify({ ...LIST, rows: Array(51).fill(LIST.rows[0]) }));
  const long = await fabrik({ home: work, work }, ["draw_widget", "kind=list", "data_file=long.json"]);
  assert.equal(long.err, `${join(work, "long.json")} lacks rows, a list of 1 to 50 rows. Nothing was drawn.\n`);
});

// ---- The business's brand on the question and list cards and on printed pages ----

const BRAND = JSON.parse(readFileSync(new URL("./widgets/brand-record.json", import.meta.url), "utf-8"));
const GENERAL = BRAND.scope_id;
/** fabrik's answers for a person who may read General, holding the Brand record given, or none. A newer model whose
 * title also holds the word Brand comes first, as fabrik_find_records gives it. */
function brandAnswers(record = BRAND) {
  const draft = { record_id: "5a7e1c2d-0000-4000-8000-00000000b002", kind: "model", scope_id: GENERAL, title: "Brand refresh ideas", version_number: 1, change_no: 12 };
  return {
    fabrik_get_scopes: { items: [{ scope_id: "3f9c2a1e-0000-4000-8000-0000000000bb", code: "clients", display_name: "Clients" }, { scope_id: GENERAL, code: "general", display_name: "General" }], next_cursor: null },
    fabrik_find_records: args => ({ cutoff: 12, next_cursor: null,
      items: args.p_kind === "model" && args.p_scope_id === GENERAL && /\bbrand\b/i.test(args.p_title ?? "") ? [draft, ...(record ? [{ ...record, change_no: 9 }] : [])] : [] }),
    fabrik_show_record: args => args.p_record === record?.record_id ? record : { ...draft, payload: {}, links: [] },
  };
}
/** The fabrik functions the command called, each with its arguments. */
const rpcCalls = project => project.calls.filter(c => c.path.startsWith("/rest/v1/rpc/")).map(c => [c.path.slice("/rest/v1/rpc/".length), c.body]);
const brandRecord = attributes => ({ ...BRAND, payload: { ...BRAND.payload, graph: { ...BRAND.payload.graph, nodes: [{ ...BRAND.payload.graph.nodes[0], attributes }] } } });

test("draw_widget dresses the question card in the Brand record in General, read as the signed-in person", async () => {
  const project = await supabase(brandAnswers());
  try {
    const me = person(project);
    writeFileSync(join(me.work, "question.json"), JSON.stringify(QUESTION));
    const ran = await fabrik(me, ["draw_widget", "kind=question", "data_file=question.json"]);
    assert.equal(ran.code, 0, ran.err);
    const drawn = JSON.parse(ran.out);
    assert.equal(drawn.look, "brand");
    const code = drawn.widget_code;
    // The accent goes on the rows' edge, the header's rule and the links, in its light and dark values; the text and
    // the background stay the chat's own.
    assert.match(code, /--wk-key: light-dark\(#3fa66b, #5cc78a\);/);
    assert.match(code, /--wk-head-rule: light-dark\(#3fa66b, #5cc78a\);/);
    assert.match(code, /--wk-accent: light-dark\(#1f6b41, #7fd8a3\);/);
    assert.match(code, /--wk-ink: var\(--color-text-primary/);
    assert.doesNotMatch(code, /#1d2a22|#fbfaf6|#eef2ee|#121a15/, "the brand's ink and paper stay off the card");
    assert.match(code, /--wk-font: "Inter", "Helvetica Neue", "Arial", sans-serif;/);
    assert.match(code, /--wk-heading-font: "Fraunces", "Georgia", serif;/);
    assert.match(code, /@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=Fraunces:wght@400;600&family=Inter:wght@400;600&display=swap"\);/);
    assert.match(code, /<div class="wk-head">\n    <img class="wk-logo" alt="Smith Joinery" src="data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]+">\n/);
    assert.deepEqual([...new Set(code.match(/https?:\/\/[^/"]+/g))], ["https://fonts.googleapis.com"], "the fonts are the card's one web request");
    assert.equal(code.match(/<\/script>/g).length, 2);
    const context = {};
    runInNewContext(code.match(/<script>\n([\s\S]*?)<\/script>/)[1], context);
    assert.match(context.draw(QUESTION), /<h2>Scope for the Card test note<\/h2>/);
    const calls = rpcCalls(project);
    assert.deepEqual(calls.find(([fn]) => fn === "fabrik_find_records")?.[1], { p_kind: "model", p_scope_id: GENERAL, p_title: "Brand", p_cutoff: null, p_cursor: null, p_limit: 100 });
    assert.deepEqual(calls.filter(([fn]) => fn === "fabrik_show_record").map(([, a]) => a), [{ p_record: BRAND.record_id }], "only the record titled Brand is read");
  } finally { await project.close(); }
});

test("with no Brand record, or no sign-in, the question card is drawn plain, with fabrik's mark in its header", async () => {
  const project = await supabase(brandAnswers(null));
  try {
    const me = person(project);
    writeFileSync(join(me.work, "question.json"), JSON.stringify(QUESTION));
    const none = JSON.parse((await fabrik(me, ["draw_widget", "kind=question", "data_file=question.json"])).out);
    const work = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-cli-work-")));
    writeFileSync(join(work, "question.json"), JSON.stringify(QUESTION));
    const signedOut = JSON.parse((await fabrik({ home: work, work }, ["draw_widget", "kind=question", "data_file=question.json"])).out);
    assert.deepEqual([none.look, signedOut.look], ["plain", "plain"]);
    assert.equal(none.widget_code, signedOut.widget_code);
    assert.doesNotMatch(none.widget_code, /light-dark|@import/);
    assert.match(none.widget_code, /<div class="wk-head">\n    <img class="wk-logo" alt="fabrik" src="data:image\/svg\+xml;base64,/);
    assert.equal(rpcCalls(project).filter(([fn]) => fn === "fabrik_show_record").length, 0);
  } finally { await project.close(); }
});

test("a brand value that is not a colour, a font name or a picture's data address is left out, and its markup is never drawn", async () => {
  const { palette, fonts, logo } = BRAND.payload.graph.nodes[0].attributes;
  const hostile = brandRecord({
    palette: { light: { ...palette.light, accent: "red;}</style><script>alert(7)</script>" } },
    fonts: { heading: { family: "Fraunces", source: "google", fallback: "Georgia, serif; } * { display: none" }, body: { family: 'Inter"; } * { x: y', source: "google", fallback: "Arial" } },
    logo: { ...logo, alt: '"><script>alert(8)</script>' },
  });
  const project = await supabase(brandAnswers(hostile));
  try {
    const me = person(project);
    writeFileSync(join(me.work, "question.json"), JSON.stringify(QUESTION));
    const code = JSON.parse((await fabrik(me, ["draw_widget", "kind=question", "data_file=question.json"])).out).widget_code;
    assert.equal(code.match(/<\/script>/g).length, 2);
    assert.equal(code.match(/<\/style>/g).length, 2, "the kit's style and the brand's");
    assert.doesNotMatch(code, /alert\(7\)|<script>alert|display: none|x: y/);
    const own = code.match(/<\/style>\n<style>\n([\s\S]*?)<\/style>/)[1];
    assert.doesNotMatch(own, /--wk-key:|--wk-head-rule:|--wk-font:/, "the bad accent and the bad body font are left out, so the kit's own stay");
    assert.match(code, /--wk-accent: light-dark\(#1f6b41, #1f6b41\);/, "a brand with no dark values uses its light ones");
    assert.match(code, /--wk-heading-font: "Fraunces", "Georgia", sans-serif;/);
    assert.match(code, /family=Fraunces:wght@400;600&display=swap/);
    assert.match(code, /alt="&quot;&gt;&lt;script&gt;alert\(8\)&lt;\/script&gt;"/);
  } finally { await project.close(); }
  const { brandOf } = await import("../cli/lib/brand.mjs");
  const bad = brandOf(brandRecord({ logo: { ...logo, data_address: "javascript:alert(1)" } }));
  assert.equal(bad, null, "a brand with nothing usable is no brand");
  const svg = brandOf(brandRecord({ palette, logo: { ...logo, data_address: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" } }));
  assert.equal(svg.logo, null, "a logo is a PNG, JPEG, GIF or WebP picture");
});

/** Python 3, as the fabrik tools find it, or null. */
const pythonFound = () => [["python3"], ["python"], ["py", "-3"]].some(one => spawnSync(one[0], [...one.slice(1), "-c", "import sys"]).status === 0);

test("a printed report, glossary and deck take the brand's palette, fonts and logo, and with no brand stay plain", async () => {
  if (!pythonFound()) return;
  const project = await supabase(brandAnswers());
  try {
    const me = person(project);
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-cli-work-")));
    for (const work of [me.work, plain]) {
      writeFileSync(join(work, "report.md"), "# Harbour works\n\nThe cranes are done.\n");
      writeFileSync(join(work, "glossary.json"), JSON.stringify({ part: "glossary", rows: [] }));
      writeFileSync(join(work, "deck.html"), '<!doctype html><html><head><title>Deck</title></head><body><section class="slide title"><h1>Harbour works</h1></section>' +
        '<section class="slide"><h2>Done</h2><footer class="band"><span>2026</span></footer></section></body></html>');
    }
    const report = ["report_page", "markdown_file=report.md", "page_file=report.html", "prepared_for=Sam", "prepared_by=fabrik", "read_at=18 November 2026", "project_owner=Sam"];
    const runAll = async who => ({
      report: JSON.parse((await fabrik(who, report)).out),
      glossary: JSON.parse((await fabrik(who, ["draw_reference", "reference_file=glossary.json", "page_file=glossary.html"])).out),
      deck: JSON.parse((await fabrik(who, ["embed_pictures", "page_file=deck.html", "new_file=deck-print.html", "style=deck"])).out),
    });
    const branded = await runAll(me), bare = await runAll({ home: plain, work: plain });
    for (const [name, r] of Object.entries(branded)) assert.equal(r.look, "brand", `${name}: ${JSON.stringify(r)}`);
    for (const [name, r] of Object.entries(bare)) assert.equal(r.look, "plain", `${name}: ${JSON.stringify(r)}`);
    const page = (work, file) => readFileSync(join(work, file), "utf-8");
    const LOGO = /<img class="brand-logo" alt="Smith Joinery" src="data:image\/png;base64,/;
    for (const file of ["report.html", "glossary.html", "deck-print.html"]) {
      const html = page(me.work, file);
      // A printed page is paper: the brand's light palette, whole.
      for (const token of ["--ink: #1d2a22", "--paper: #fbfaf6", "--muted: #5b6660", "--rule: #d9d6cc", "--accent: #3fa66b", "--accent-text: #1f6b41"]) assert.ok(html.includes(token), `${file} lacks ${token}`);
      assert.match(html, /--heading-font: "Fraunces", "Georgia", serif;/, file);
      assert.match(html, /--body-font: "Inter", "Helvetica Neue", "Arial", sans-serif;/, file);
      assert.match(html, LOGO, file);
      assert.doesNotMatch(html, /#5cc78a/, `${file} holds a dark value`);
      const without = page(plain, file);
      assert.doesNotMatch(without, /brand-logo"|#3fa66b|Fraunces/, file);
    }
    assert.match(page(me.work, "deck-print.html"), /<section class="slide title">\n?<img class="brand-logo"[^>]*>\n?<h1>/);
    assert.match(page(me.work, "deck-print.html"), /<footer class="band"><img class="brand-logo"[^>]*><span>2026<\/span>/);
  } finally { await project.close(); }
});

test("the page's picture is taken with the browser kept off the macOS keychain", () => {
  const work = mkdtempSync(join(tmpdir(), "fabrik-cli-work-"));
  const check = fileURLToPath(new URL("../skills/board/", import.meta.url));
  const script = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(check)})`,
    "import page_check",
    "page_check.browser = lambda: 'browser'",
    "page_check.subprocess.run = lambda args, **kw: print(json.dumps(args))",
    `page_check.picture(${JSON.stringify(join(work, "board.html"))}, 800)`,
  ].join("\n");
  // python3 on Windows can be the Store's shortcut, which runs nothing; the fabrik tools try the same three.
  const python = [["python3"], ["python"], ["py", "-3"]].find(one => spawnSync(one[0], [...one.slice(1), "-c", "import sys"]).status === 0);
  if (!python) return;
  const ran = spawnSync(python[0], [...python.slice(1), "-c", script], { encoding: "utf-8" });
  assert.equal(ran.status, 0, ran.stderr);
  const args = JSON.parse(ran.stdout);
  assert.ok(args.includes("--use-mock-keychain"), args.join(" "));
  assert.ok(args.includes("--password-store=basic"), args.join(" "));
});

test("sign-in in a folder already signed in signs in again as that folder's person, in its project and folder, and an older actor file's upload folder is ignored", async () => {
  const { signInArgs } = await import("../cli/fabrik.mjs");
  const { ACTOR_FILE } = await import("../cli/lib/actor-file.mjs");
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-cli-folder-")));
  mkdirSync(join(folder, "uploads"));
  writeFileSync(join(folder, ACTOR_FILE), JSON.stringify({ project_ref: REF, auth_email: USER.email, upload_folder: join(folder, "uploads") }));
  const args = signInArgs(["--new-password", "--url", "https://x.supabase.co", "--key", "k"], "other@example.com", folder);
  assert.deepEqual(args.slice(1), ["--project", REF, "--email", USER.email, "--folder", folder, "--new-password"]);
  // A folder with no actor file signs in as the email given, with the person's own options.
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-cli-plain-")));
  assert.deepEqual(signInArgs(["--url", "https://x.supabase.co", "--key", "k"], "a@example.com", plain).slice(1), ["--email", "a@example.com", "--url", "https://x.supabase.co", "--key", "k"]);
  // A broken actor file stops the sign-in rather than signing in as anyone else.
  writeFileSync(join(plain, ACTOR_FILE), "{");
  assert.throws(() => signInArgs([], "a@example.com", plain), /is not JSON/);
});

/** Python's pty module gives the sign-in a real terminal, which Node cannot open on its own. */
const PTY = `
import os, pty, sys, time, select
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
out = b""
def pump(until, timeout):
    global out
    start, end = len(out), time.time() + timeout
    while time.time() < end:
        if select.select([fd], [], [], 0.1)[0]:
            try: chunk = os.read(fd, 4096)
            except OSError: return
            if not chunk: return
            out += chunk
            if until and until.encode() in out[start:]: return
if sys.argv[1] == "email":
    pump("Email: ", 10)
    os.write(fd, b"person@example.com\\r")
pump("Password: ", 10)
os.write(fd, b"\\x03")
pump(None, 3)
sys.stdout.write(out.decode(errors="replace"))
`;
const python = spawnSync("python3", ["-c", "import pty"]).status === 0;

// A client's project, as the person copies its address and publishable key from the dashboard.
const CLIENT = ["--url", `https://${REF}.supabase.co`, "--key", "sb_publishable_client"];

test("fabrik sign-in, in a real terminal, given the project's address and key, asks only for the email and the password", { skip: process.platform === "win32" || !python }, async () => {
  const home = mkdtempSync(join(tmpdir(), "fabrik-cli-home-"));
  const run = spawnSync("python3", ["-c", PTY, "email", process.execPath, FABRIK, "sign-in", ...CLIENT, "--new-password"], { encoding: "utf-8", env: { PATH: process.env.PATH, HOME: home } });
  // Cancelled at the password, before anything reaches fabrik.
  assert.equal(run.stdout.replace(/\r/g, ""), "Email: person@example.com\nNothing shows as you type or paste. Do it once, then press Enter.\nPassword: Sign-in stopped: cancelled.\n");
});

test("fabrik sign-in takes the email from the fabrik plugin's settings, and asks only for the password", { skip: process.platform === "win32" || !python }, async () => {
  const home = mkdtempSync(join(tmpdir(), "fabrik-cli-home-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ pluginConfigs: { "fabrik@fabrik": { options: { auth_email: "Person@Example.com" } } } }));
  const run = spawnSync("python3", ["-c", PTY, "password", process.execPath, FABRIK, "sign-in", ...CLIENT, "--new-password"], { encoding: "utf-8", env: { PATH: process.env.PATH, HOME: home } });
  assert.equal(run.stdout.replace(/\r/g, ""), `Signing in to ${REF} as person@example.com.\nNothing shows as you type or paste. Do it once, then press Enter.\nPassword: Sign-in stopped: cancelled.\n`);
});

test("an email the person names wins over the settings, and a missing or broken settings file gives none", async () => {
  const { settingsEmail, signInArgs } = await import("../cli/fabrik.mjs");
  const home = mkdtempSync(join(tmpdir(), "fabrik-cli-home-"));
  assert.equal(settingsEmail(home, ""), null);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
  assert.equal(settingsEmail(home, ""), null);
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ pluginConfigs: { "fabrik@fabrik": { options: { auth_email: "a@example.com" } } } }));
  assert.equal(settingsEmail(home, ""), "a@example.com");
  assert.deepEqual(signInArgs(["--email", "b@example.com"], "a@example.com").slice(-2), ["--email", "b@example.com"]);
  assert.equal(signInArgs(["--email", "b@example.com"], "a@example.com").filter(a => a === "--email").length, 1);
});
