// fabrik's local connector, mcp/relay.mjs, run as Claude runs it: a program on stdio, with the session's folder in
// FABRIK_SESSION_FOLDER, against a stand-in for the project's fabrik-apps hosted function. It passes each message to
// the function with the folder's sign-in, writes back each JSON-RPC answer whole, whether the function answered as JSON
// or as an event stream, and sends the function's session id on the calls after the first. It serves only a folder
// whose actor file says "connector": "local" and which is on the list of local folders outside it. A folder with no
// sign-in, or one the project refuses, starts with no tools and the sign-in command, and its tool list changes once
// the sign-in does. The actor file, the folder list and the sign-in's --local are checked here too.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readActorFile, writeActorFile } from "../cli/lib/actor-file.mjs";
import { addLocalFolder, isLocalFolder, listPath } from "../cli/lib/local-folders.mjs";
import { options } from "../cli/lib/sign-in-flow.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RELAY = join(ROOT, "mcp", "relay.mjs");
const REF = "abcdefghijklmnopqrst";
const EMAIL = "person@example.com";
const TOKEN = "access-token-of-person";
const KEY = "publishable-key";
// Larger than a pipe's buffer, so an answer cut short would show.
const BIG = "x".repeat(300_000);

/** A stand-in for fabrik-apps. initialize answers as JSON with a new session id, tools/list as an event stream, and a
 * tool call as JSON. A call carrying a session id the stand-in forgot answers 404. The tool "slow" never answers, and
 * "broken" answers 500 with a body that isn't JSON-RPC. Each request's headers and message are kept. */
async function standIn(t) {
  const seen = [];
  const sessions = new Set();
  let made = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);
    seen.push({ path: req.url, headers: req.headers, msg });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401, { "Content-Type": "application/json" }); return res.end('{"code":401,"message":"Invalid JWT"}'); }
    if (msg.method === "initialize") {
      const id = `session-${++made}`;
      sessions.add(id);
      res.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": id });
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fabrik-apps", version: "0.1.0" }, instructions: BIG } }));
    }
    const session = req.headers["mcp-session-id"];
    if (session && !sessions.has(session)) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"Session not found"}}'); }
    if (msg.method === undefined || msg.id === undefined) { res.writeHead(202); return res.end(); }
    if (msg.method === "tools/list") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "search", description: BIG, inputSchema: { type: "object" } }] } })}\n\n`);
    }
    if (msg.params?.name === "slow") return;
    if (msg.params?.name === "broken") { res.writeHead(500, { "Content-Type": "application/json" }); return res.end('{"code":500,"message":"Function crashed"}'); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `called ${msg.params?.name}` }] } }));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${server.address().port}`, seen, forget: () => sessions.clear() };
}

/** Saves a current sign-in for EMAIL on REF at url in home, as fabrik sign-in does. */
function saveSignIn(home, url, token = TOKEN) {
  const sessions = join(home, ".config", "supabase-auth", REF);
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  chmodSync(join(home, ".config", "supabase-auth"), 0o700);
  const file = join(sessions, `${EMAIL}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, projectRef: REF, url, publishableKey: KEY, email: EMAIL, refreshToken: "refresh", accessToken: token, expiresAt: Date.now() + 3600_000 }));
  chmodSync(file, 0o600);
}

/** A home, and a folder whose actor file holds actor. The folder is on the home's list of local folders when listed,
 * and the home holds a sign-in when signedIn. */
function place({ url, actor = { project_ref: REF, auth_email: EMAIL, connector: "local" }, signedIn = true, listed = true, token = TOKEN }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-relay-")));
  const home = join(dir, "home");
  const folder = join(dir, "folder");
  mkdirSync(folder, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (actor) writeFileSync(join(folder, ".fabrik-actor.json"), JSON.stringify(actor));
  if (listed) addLocalFolder(folder, home);
  if (signedIn) saveSignIn(home, url, token);
  return { home, folder };
}

/** The relay, started as Claude starts it. send writes a message and, for a request, gives its answer. next waits for
 * the first line that matches. end closes stdin and gives every line the relay wrote, parsed. */
function start({ home, folder }, env = {}) {
  const child = spawn(process.execPath, [RELAY], { env: { PATH: process.env.PATH, HOME: home, FABRIK_SESSION_FOLDER: folder, FABRIK_RELAY_WATCH_MS: "20", ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stderr.on("data", d => { err += d; });
  // Only lines the relay has finished writing.
  const lines = () => out.slice(0, out.lastIndexOf("\n") + 1).split("\n").filter(Boolean).map(line => JSON.parse(line));
  const next = match => new Promise(done => {
    const look = () => { const found = lines().find(match); if (found) { child.stdout.off("data", look); done(found); return true; } return false; };
    child.stdout.on("data", look);
    look();
  });
  child.stdout.on("data", d => { out += d; });
  const closed = new Promise(done => child.on("close", code => done(code)));
  return {
    raw: text => child.stdin.write(text),
    send(msg) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
      return msg.id !== undefined && msg.method !== undefined ? next(line => line.id === msg.id) : Promise.resolve();
    },
    next,
    async end() { child.stdin.end(); const code = await closed; return { code, err, lines: lines() }; },
  };
}

const INIT = { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } };

test("a local folder: each answer, from JSON or an event stream, reaches stdout whole, with the sign-in and the session id sent", async t => {
  const fn = await standIn(t);
  const relay = start(place({ url: fn.url }));
  const init = await relay.send(INIT);
  await relay.send({ method: "notifications/initialized" });
  const list = await relay.send({ id: 2, method: "tools/list" });
  const call = await relay.send({ id: 3, method: "tools/call", params: { name: "search", arguments: { query: "notes" } } });
  const ran = await relay.end();
  assert.equal(ran.code, 0, ran.err);
  assert.equal(ran.lines.length, 3, "a notification gets no answer");
  assert.equal(init.result.instructions, BIG);
  assert.equal(list.result.tools[0].description, BIG);
  assert.equal(call.result.content[0].text, "called search");
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
  const relay = start(place({ url: fn.url, actor: { project_ref: REF, auth_email: EMAIL } }));
  const init = await relay.send(INIT);
  const list = await relay.send({ id: 2, method: "tools/list" });
  const call = await relay.send({ id: 3, method: "tools/call", params: { name: "search", arguments: {} } });
  await relay.end();
  assert.equal(init.result.serverInfo.name, "fabrik");
  assert.equal(init.result.instructions, undefined);
  assert.deepEqual(list.result.tools, []);
  assert.match(call.error.message, /local connector is off/);
  assert.match(call.error.message, /sign-in --folder .* --local/);
  const none = start(place({ url: fn.url, actor: null }));
  await none.send(INIT);
  assert.deepEqual((await none.send({ id: 2, method: "tools/list" })).result.tools, []);
  await none.end();
  assert.equal(fn.seen.length, 0);
});

test("a folder whose actor file says connector local, but that isn't on this computer's list, gets no tools and calls nothing", async t => {
  const fn = await standIn(t);
  const relay = start(place({ url: fn.url, listed: false }));
  const init = await relay.send(INIT);
  const list = await relay.send({ id: 2, method: "tools/list" });
  const call = await relay.send({ id: 3, method: "tools/call", params: { name: "search", arguments: {} } });
  await relay.end();
  assert.deepEqual(list.result.tools, []);
  assert.match(init.result.instructions, /isn't turned on for .* on this computer\. Turn it on with: .* --local$/);
  assert.ok(call.error);
  assert.equal(fn.seen.length, 0);
});

test("a local folder with no sign-in starts with the sign-in command, and its tool list changes once the person signs in", async t => {
  const fn = await standIn(t);
  const where = place({ url: fn.url, signedIn: false });
  const relay = start(where);
  const init = await relay.send(INIT);
  const sentence = `${EMAIL} is not signed in to fabrik on this computer. Sign in with: `;
  assert.ok(init.result.instructions.startsWith(sentence), init.result.instructions);
  assert.match(init.result.instructions, /fabrik\.mjs' sign-in --folder '.*folder' --local$/);
  assert.deepEqual(init.result.capabilities.tools, { listChanged: true });
  await relay.send({ method: "notifications/initialized" });
  assert.deepEqual((await relay.send({ id: 2, method: "tools/list" })).result.tools, []);
  const call = await relay.send({ id: 3, method: "tools/call", params: { name: "search", arguments: {} } });
  assert.ok(call.error.message.startsWith(sentence));
  assert.equal(fn.seen.length, 0);

  saveSignIn(where.home, fn.url);
  await relay.next(line => line.method === "notifications/tools/list_changed");
  const list = await relay.send({ id: 4, method: "tools/list" });
  await relay.end();
  assert.equal(list.result.tools[0].name, "search");
  // The function had no session, so the relay started one with Claude's own initialize before the call.
  assert.deepEqual(fn.seen.map(s => s.msg.method), ["initialize", "notifications/initialized", "tools/list"]);
  assert.deepEqual(fn.seen[0].msg.params, INIT.params);
  assert.equal(fn.seen[2].headers["mcp-session-id"], "session-1");
});

test("a sign-in the project refuses starts the server with the sign-in command, and writes nothing else", async t => {
  const fn = await standIn(t);
  const relay = start(place({ url: fn.url, token: "ended" }));
  const init = await relay.send(INIT);
  const call = await relay.send({ id: 2, method: "tools/call", params: { name: "search", arguments: {} } });
  const ran = await relay.end();
  assert.match(init.result.instructions, new RegExp(`^Project ${REF} refused ${EMAIL}'s sign-in\\. Sign in again with: .* --local$`));
  assert.deepEqual(init.result.capabilities.tools, { listChanged: true });
  assert.match(call.error.message, /refused/);
  assert.equal(ran.lines.length, 2, `nothing but the two answers: ${JSON.stringify(ran.lines)}`);
});

test("an answer that isn't JSON-RPC is never written, and becomes the call's error", async t => {
  const fn = await standIn(t);
  const relay = start(place({ url: fn.url }));
  await relay.send(INIT);
  const call = await relay.send({ id: 2, method: "tools/call", params: { name: "broken", arguments: {} } });
  const ran = await relay.end();
  assert.match(call.error.message, /^fabrik's connector answered HTTP 500/);
  assert.equal(ran.lines.length, 2);
  assert.ok(ran.lines.every(line => line.jsonrpc === "2.0"));
});

test("Claude's reply to a request from the function is passed on, and gets no answer", async t => {
  const fn = await standIn(t);
  const relay = start(place({ url: fn.url }));
  await relay.send(INIT);
  await relay.send({ id: "from-function-1", result: { action: "accept" } });
  await relay.send({ id: 2, method: "ping" });
  const ran = await relay.end();
  assert.ok(fn.seen.some(s => s.msg.id === "from-function-1" && s.msg.result?.action === "accept"));
  assert.deepEqual(ran.lines.map(line => line.id), [1, 2]);
});

test("a line that isn't JSON gets a parse error", async t => {
  const fn = await standIn(t);
  const relay = start(place({ url: fn.url }));
  relay.raw("{not json\n");
  const parsed = await relay.next(line => line.error?.code === -32700);
  await relay.end();
  assert.equal(parsed.id, null);
});

test("a call the function never answers ends with an error once the timeout passes", async t => {
  const fn = await standIn(t);
  const relay = start(place({ url: fn.url }), { FABRIK_RELAY_TIMEOUT_MS: "300" });
  await relay.send(INIT);
  const call = await relay.send({ id: 2, method: "tools/call", params: { name: "slow", arguments: {} } });
  await relay.end();
  assert.match(call.error.message, /didn't answer within 0\.3 seconds\.$/);
});

test("a session the function forgot is started again, and the call sent again", async t => {
  const fn = await standIn(t);
  const relay = start(place({ url: fn.url }));
  await relay.send(INIT);
  fn.forget();
  const call = await relay.send({ id: 2, method: "tools/call", params: { name: "search", arguments: {} } });
  await relay.end();
  assert.equal(call.result.content[0].text, "called search");
  assert.deepEqual(fn.seen.map(s => [s.msg.method, s.headers["mcp-session-id"] ?? null]),
    [["initialize", null], ["tools/call", "session-1"], ["initialize", null], ["notifications/initialized", "session-2"], ["tools/call", "session-2"]]);
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

test("the list of local folders holds real paths, private to the person, and refuses one others can write", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-home-")));
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-folder-")));
  assert.equal(isLocalFolder(folder, home), false);
  addLocalFolder(folder, home);
  addLocalFolder(folder, home);
  assert.deepEqual(JSON.parse(readFileSync(listPath(home), "utf8")), { version: 1, folders: [folder] });
  assert.equal(isLocalFolder(folder, home), true);
  chmodSync(listPath(home), 0o666);
  assert.equal(isLocalFolder(folder, home), false);
});

test("sign-in --folder alone signs in again as that folder's person, and --url makes it a first sign-in", async () => {
  const { signInArgs } = await import("../cli/fabrik.mjs");
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-actor-")));
  writeFileSync(join(folder, ".fabrik-actor.json"), JSON.stringify({ project_ref: REF, auth_email: EMAIL }));
  assert.deepEqual(signInArgs(["--folder", folder, "--local"], "other@example.com", tmpdir()).slice(1), ["--project", REF, "--email", EMAIL, "--folder", folder, "--local"]);
  const other = ["--folder", folder, "--url", "https://tsrqponmlkjihgfedcba.supabase.co", "--key", "k"];
  assert.deepEqual(signInArgs(other, "other@example.com", tmpdir()).slice(1), other);
});
