// fabrik's local connector, mcp/relay.mjs, run as Claude runs it: a program on stdio, with the session's folder in
// FABRIK_SESSION_FOLDER, against a stand-in for the project's fabrik-apps hosted function. It passes each message to
// the function with the folder's sign-in, writes back each answer whole, whether the function answered as JSON or as
// an event stream, and sends the function's session id on the calls after the first. A folder whose actor file doesn't
// say "connector": "local" lists no tools and calls nothing. A folder with no sign-in saved names the sign-in command.
// The actor file and the sign-in's --local are checked here too.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readActorFile, writeActorFile } from "../cli/lib/actor-file.mjs";
import { options } from "../cli/lib/sign-in-flow.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY = join(ROOT, "mcp", "relay.mjs");
const REF = "abcdefghijklmnopqrst";
const EMAIL = "person@example.com";
const TOKEN = "access-token-of-person";
const KEY = "publishable-key";
// Larger than a pipe's buffer, so an answer cut short would show.
const BIG = "x".repeat(300_000);

/** A stand-in for fabrik-apps: initialize answers as JSON with a session id, tools/list as an event stream. Each
 * request's headers and message are kept. */
async function standIn(t) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);
    seen.push({ path: req.url, headers: req.headers, msg });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end('{"message":"Invalid JWT"}'); }
    if (msg.id === undefined) { res.writeHead(202); return res.end(); }
    if (msg.method === "initialize") {
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "session-1" });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fabrik-apps", version: "0.1.0" }, instructions: BIG } }));
    }
    if (msg.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "search", description: BIG, inputSchema: { type: "object" } }] } })}\n\n`);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `called ${msg.params?.name}` }] } }));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** A home holding a current sign-in for EMAIL on REF at url, and a folder whose actor file holds actor. */
function place({ url, actor = { project_ref: REF, auth_email: EMAIL, connector: "local" }, signedIn = true, token = TOKEN }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-relay-")));
  const home = join(dir, "home");
  const folder = join(dir, "folder");
  mkdirSync(folder, { recursive: true });
  if (actor) writeFileSync(join(folder, ".fabrik-actor.json"), JSON.stringify(actor));
  if (signedIn) {
    const sessions = join(home, ".config", "supabase-auth", REF);
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    chmodSync(join(home, ".config", "supabase-auth"), 0o700);
    const file = join(sessions, `${EMAIL}.json`);
    writeFileSync(file, JSON.stringify({ version: 1, projectRef: REF, url, publishableKey: KEY, email: EMAIL, refreshToken: "refresh", accessToken: token, expiresAt: Date.now() + 3600_000 }));
    chmodSync(file, 0o600);
  }
  return { home, folder };
}

/** Starts the relay as Claude does, sends each message, and gives every line it wrote, parsed, once stdin closes. */
function relay({ home, folder }, messages) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [RELAY], { env: { PATH: process.env.PATH, HOME: home, FABRIK_SESSION_FOLDER: folder }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", fail);
    child.on("close", code => {
      try { done({ code, err, lines: out.split("\n").filter(Boolean).map(line => JSON.parse(line)) }); }
      catch (e) { fail(new Error(`${e.message}: ${out.slice(0, 300)}`)); }
    });
    // Each message waits for the one before it to be answered, as Claude waits for initialize.
    (async () => {
      for (const msg of messages) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
        const answered = () => out.split("\n").some(line => { try { return JSON.parse(line).id === msg.id; } catch { return false; } });
        if (msg.id !== undefined) await new Promise(r => child.stdout.on("data", function seen() { if (answered()) { child.stdout.off("data", seen); r(); } }));
      }
      child.stdin.end();
    })().catch(fail);
  });
}

const INIT = { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };
const byId = (lines, id) => lines.find(line => line.id === id);

test("a local folder: each answer, from JSON or an event stream, reaches stdout whole, with the sign-in and the session id sent", async t => {
  const fn = await standIn(t);
  const ran = await relay(place({ url: fn.url }), [INIT, { method: "notifications/initialized" }, { id: 2, method: "tools/list" }, { id: 3, method: "tools/call", params: { name: "search", arguments: { query: "notes" } } }]);
  assert.equal(ran.code, 0, ran.err);
  assert.equal(ran.lines.length, 3, "a notification gets no answer");
  assert.equal(byId(ran.lines, 1).result.instructions, BIG);
  assert.equal(byId(ran.lines, 2).result.tools[0].description, BIG);
  assert.equal(byId(ran.lines, 3).result.content[0].text, "called search");
  assert.deepEqual(fn.seen.map(s => s.msg.method), ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  for (const s of fn.seen) {
    assert.equal(s.path, "/functions/v1/fabrik-apps");
    assert.equal(s.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(s.headers.apikey, KEY);
    assert.match(s.headers.accept, /application\/json/);
    assert.match(s.headers.accept, /text\/event-stream/);
  }
  assert.equal(fn.seen[0].headers["mcp-session-id"], undefined);
  assert.ok(fn.seen.slice(1).every(s => s.headers["mcp-session-id"] === "session-1"), "every call after initialize carries the session id");
  assert.ok(fn.seen.slice(1).every(s => s.headers["mcp-protocol-version"] === "2025-06-18"));
});

test("a folder whose actor file doesn't say connector local lists no tools and calls nothing", async t => {
  const fn = await standIn(t);
  const ran = await relay(place({ url: fn.url, actor: { project_ref: REF, auth_email: EMAIL } }), [INIT, { id: 2, method: "tools/list" }, { id: 3, method: "tools/call", params: { name: "search", arguments: {} } }]);
  assert.equal(ran.code, 0, ran.err);
  assert.equal(byId(ran.lines, 1).result.serverInfo.name, "fabrik");
  assert.equal(byId(ran.lines, 1).result.instructions, undefined);
  assert.deepEqual(byId(ran.lines, 2).result.tools, []);
  assert.match(byId(ran.lines, 3).error.message, /local connector is off/);
  assert.match(byId(ran.lines, 3).error.message, /sign-in --folder .* --local/);
  const none = await relay(place({ url: fn.url, actor: null }), [INIT, { id: 2, method: "tools/list" }]);
  assert.deepEqual(byId(none.lines, 2).result.tools, []);
  assert.equal(fn.seen.length, 0);
});

test("a local folder with no sign-in saved answers with the sign-in command", async t => {
  const fn = await standIn(t);
  const ran = await relay(place({ url: fn.url, signedIn: false }), [INIT, { id: 2, method: "tools/list" }, { id: 3, method: "tools/call", params: { name: "search", arguments: {} } }]);
  assert.equal(ran.code, 0, ran.err);
  const sentence = `${EMAIL} is not signed in to fabrik on this computer. Sign in with: `;
  assert.ok(byId(ran.lines, 1).result.instructions.startsWith(sentence), byId(ran.lines, 1).result.instructions);
  assert.deepEqual(byId(ran.lines, 2).result.tools, []);
  assert.ok(byId(ran.lines, 3).error.message.startsWith(sentence));
  assert.match(byId(ran.lines, 3).error.message, /fabrik\.mjs' sign-in --folder '.*folder' --local$/);
  assert.equal(fn.seen.length, 0);
});

test("a sign-in the project refuses answers with the sign-in command", async t => {
  const fn = await standIn(t);
  const ran = await relay(place({ url: fn.url, token: "ended" }), [INIT]);
  assert.match(byId(ran.lines, 1).error.message, new RegExp(`^Project ${REF} refused ${EMAIL}'s sign-in\\. Sign in again with: .* --local$`));
});

test("the actor file takes connector local and no other value, and signing in again keeps it", () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-actor-")));
  writeFileSync(join(folder, ".fabrik-actor.json"), JSON.stringify({ project_ref: REF, auth_email: EMAIL, connector: "remote" }));
  assert.equal(readActorFile(folder).ok, false);
  writeActorFile(folder, { projectRef: REF, email: EMAIL, local: true });
  assert.deepEqual(readActorFile(folder).value, { project_ref: REF, auth_email: EMAIL, connector: "local" });
  writeActorFile(folder, { projectRef: REF, email: EMAIL });
  assert.deepEqual(JSON.parse(readFileSync(join(folder, ".fabrik-actor.json"), "utf8")), { project_ref: REF, auth_email: EMAIL, connector: "local" });
  assert.equal(options(["--folder", folder, "--local"]).local, true);
  assert.throws(() => options(["--local"]), /--local goes with --folder/);
});

test("sign-in --folder alone signs in again as that folder's person", async () => {
  const { signInArgs } = await import("../cli/fabrik.mjs");
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-actor-")));
  writeFileSync(join(folder, ".fabrik-actor.json"), JSON.stringify({ project_ref: REF, auth_email: EMAIL }));
  assert.deepEqual(signInArgs(["--folder", folder, "--local"], "other@example.com", tmpdir()).slice(1), ["--project", REF, "--email", EMAIL, "--folder", folder, "--local"]);
});
