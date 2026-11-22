#!/usr/bin/env node
// fabrik's local connector: an MCP server over stdio for a person who can't add fabrik's connector in Claude's
// Settings. It holds no tool of its own. It passes each JSON-RPC message Claude sends to the connector's hosted
// function, https://<project ref>.supabase.co/functions/v1/fabrik-apps, as the person, with the access token their
// sign-in saved on this computer, and writes each JSON-RPC message the function answers back on stdout. So Claude gets
// the connector's own tools, instructions and cards, and the connector's code stays the only copy of them.
//
// It serves a session folder only when the folder's actor file, .fabrik-actor.json, says "connector": "local", and the
// folder is on the list of local folders in ~/.config/fabrik. fabrik sign-in --folder <folder> --local writes both, and
// owner setup does when the owner can't add the connector. A folder can't put itself on that list, so a folder someone
// else made, such as a cloned repository, never gets fabrik's tools. In every other folder the relay lists no tools and
// calls nothing, so a person who has the connector never sees each tool twice.
//
// Each message reads the actor file and the sign-in again, and the sign-in renews itself the way the plugin's other
// commands do. When the session starts with no sign-in, or with one the project refuses, the relay starts anyway with
// no tools and the sign-in command as its instructions. It then watches the saved sign-in, and once it changes it
// tells Claude the tool list changed, so Claude reads the connector's tools in the same session.
//
// The function's Mcp-Session-Id, when it gives one, is sent on every later call. When the function no longer knows that
// session, it answers 404, and the relay starts a new session with Claude's own initialize and sends the call again.
// The protocol on stdio is newline-delimited JSON-RPC, written directly, so the relay needs Node alone.
import { statSync } from "node:fs";
import { readActor, LOCAL } from "../cli/lib/actor-file.mjs";
import { SIGN_IN } from "../cli/fabrik-session.mjs";
import { isLocalFolder } from "../cli/lib/local-folders.mjs";
import { sessionAccess, sessionPath } from "../cli/lib/session.mjs";

const SERVER = { name: "fabrik", version: "1" };
const DEFAULT_PROTOCOL = "2025-06-18";
const FUNCTION = "fabrik-apps";
/** How long one call to the function may take. A hosted function is stopped by Supabase well before this. */
const TIMEOUT = Number(process.env.FABRIK_RELAY_TIMEOUT_MS) > 0 ? Number(process.env.FABRIK_RELAY_TIMEOUT_MS) : 300_000;
/** How often the saved sign-in is looked at while the relay waits for one. */
const WATCH_EVERY = Number(process.env.FABRIK_RELAY_WATCH_MS) > 0 ? Number(process.env.FABRIK_RELAY_WATCH_MS) : 2_000;

const folder = process.env.FABRIK_SESSION_FOLDER || process.cwd();
const quote = value => process.platform === "win32" ? `"${value}"` : `'${String(value).replaceAll("'", `'\\''`)}'`;
const signInHere = () => `${SIGN_IN} --folder ${quote(folder)} --local`;

/** Claude's own initialize, kept to start a session with the function when it has none. */
let clientInit = null;
let sessionId = null;
let protocol = null;
/** Whether the function has had an initialize from this relay. */
let started = false;

const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");
const failure = (id, message, code = -32000) => send({ jsonrpc: "2.0", id, error: { code, message } });
const isRpc = value => value !== null && typeof value === "object" && !Array.isArray(value) && value.jsonrpc === "2.0" && ("method" in value || "id" in value);

/** Whether this folder is served: { local: true, actor } or { local: false, problem? }. */
function relayed() {
  const actor = readActor(folder);
  if (!actor) return { local: false };
  if (!actor.ok) return { local: false, problem: actor.problem };
  if (actor.value.connector !== LOCAL) return { local: false };
  if (!isLocalFolder(actor.folder)) return { local: false, problem: `fabrik's local connector isn't turned on for ${folder} on this computer. Turn it on with: ${signInHere()}` };
  return { local: true, actor };
}

/** The answer to a request the relay can't pass on: a server with no tools. With watching, it says its tool list can
 * change, as it does once the person signs in. */
function idle(msg, problem, { watching = false } = {}) {
  const { id, method, params } = msg;
  if (id === undefined || method === undefined) return;
  if (method === "initialize")
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL, capabilities: { tools: watching ? { listChanged: true } : {} }, serverInfo: SERVER, ...(problem ? { instructions: problem } : {}) } });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: [] } });
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  failure(id, problem ?? `fabrik's local connector is off in ${folder}. Turn it on with: ${signInHere()}`);
}

/** The saved sign-in as it stands: its file's change time, or none. */
function signInMark({ project_ref: ref, auth_email: email }) {
  try { return String(statSync(sessionPath(ref, email)).mtimeMs); } catch { return "none"; }
}

let watcher = null;
/** Watches the saved sign-in, and tells Claude the tool list changed once it does. */
function watchSignIn(actor) {
  if (watcher) return;
  const before = signInMark(actor);
  watcher = setInterval(() => {
    if (signInMark(actor) === before) return;
    clearInterval(watcher);
    watcher = null;
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }, WATCH_EVERY);
  watcher.unref();
}

/** Each JSON-RPC message in the function's answer, from JSON or from a server-sent event stream. Anything else, such as
 * the gateway's own error body, is left out. */
function messagesOf(type, text) {
  const parse = value => { try { return JSON.parse(value); } catch { return undefined; } };
  const found = [];
  const take = value => { for (const one of Array.isArray(value) ? value : [value]) if (isRpc(one)) found.push(one); };
  if (/text\/event-stream/i.test(type)) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
      const value = data ? parse(data) : undefined;
      if (value !== undefined) take(value);
    }
    return found;
  }
  const value = text ? parse(text) : undefined;
  if (value !== undefined) take(value);
  return found;
}

/** A current token for the folder's person: { ok: true, ref, email, url, key, token } or { ok: false, problem }. */
async function access({ project_ref: ref, auth_email: email }) {
  const again = `Sign in again with: ${signInHere()}`;
  let opened;
  try { opened = await sessionAccess(ref, email); }
  catch (err) {
    if (err?.cause || err instanceof TypeError) return { ok: false, problem: `fabrik's project ${ref} could not be reached: ${err?.cause?.code ?? err?.message ?? err}` };
    return { ok: false, signIn: true, problem: `${err.message} ${again}` };
  }
  if (opened.missing) return { ok: false, signIn: true, problem: `${email} is not signed in to fabrik on this computer. Sign in with: ${signInHere()}` };
  if (opened.wrongUser) return { ok: false, signIn: true, problem: `The saved sign-in is for ${opened.wrongUser}, not ${email}. ${again}` };
  if (!opened.ok && opened.status) return { ok: false, signIn: true, problem: `Project ${ref} ended ${email}'s sign-in: ${opened.problem}. ${again}` };
  if (!opened.ok) return { ok: false, problem: opened.problem };
  return { ok: true, ref, email, url: opened.url, key: opened.key, token: opened.token };
}

/** One message posted to the function: { status, messages } or { problem }. */
async function post(opened, msg) {
  let response;
  try {
    response = await fetch(`${opened.url}/functions/v1/${FUNCTION}`, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT),
      headers: {
        apikey: opened.key, Authorization: `Bearer ${opened.token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}), ...(protocol ? { "MCP-Protocol-Version": protocol } : {}),
      },
      body: JSON.stringify(msg),
    });
  } catch (err) {
    if (err?.name === "TimeoutError") return { problem: `fabrik's connector in project ${opened.ref} didn't answer within ${TIMEOUT / 1000} seconds.` };
    return { problem: `fabrik's project ${opened.ref} could not be reached: ${err?.cause?.code ?? err?.message ?? err}` };
  }
  const given = response.headers.get("mcp-session-id");
  if (given) sessionId = given;
  let text;
  try { text = await response.text(); }
  catch (err) { return { problem: err?.name === "TimeoutError" ? `fabrik's connector in project ${opened.ref} didn't answer within ${TIMEOUT / 1000} seconds.` : `fabrik's connector's answer was cut off: ${err?.message ?? err}` }; }
  return { status: response.status, text, messages: messagesOf(response.headers.get("content-type") ?? "", text) };
}

/** Starts a session with the function with Claude's own initialize, writing nothing to Claude. */
async function startSession(opened) {
  sessionId = null;
  protocol = null;
  const init = await post(opened, { jsonrpc: "2.0", id: "fabrik-relay-initialize", method: "initialize", params: clientInit ?? { protocolVersion: DEFAULT_PROTOCOL, capabilities: {}, clientInfo: SERVER } });
  const result = init.messages?.find(one => one.id === "fabrik-relay-initialize")?.result;
  if (!result) return false;
  if (typeof result.protocolVersion === "string") protocol = result.protocolVersion;
  await post(opened, { jsonrpc: "2.0", method: "notifications/initialized" });
  started = true;
  return true;
}

/** The answer to a request when the person's sign-in can't be used: the server still starts, with the sentence. */
function signedOut(msg, actor, problem) {
  const { id, method } = msg;
  if (id === undefined || method === undefined) return;
  watchSignIn(actor.value);
  if (method === "initialize" || method === "tools/list" || method === "ping") return idle(msg, problem, { watching: true });
  failure(id, problem);
}

async function relay(msg, actor) {
  const { id, method } = msg;
  const request = id !== undefined && method !== undefined;
  if (method === "initialize") clientInit = msg.params ?? null;
  const opened = await access(actor.value);
  if (!opened.ok) return opened.signIn ? signedOut(msg, actor, opened.problem) : request ? failure(id, opened.problem) : undefined;
  const refused = `Project ${opened.ref} refused ${opened.email}'s sign-in. Sign in again with: ${signInHere()}`;

  // A session the function never had, as after an initialize answered while signed out, starts before the call.
  if (method !== "initialize" && !started && clientInit) await startSession(opened);
  let answer = await post(opened, msg);
  // The function no longer knows the session: a new one, and the call again, once.
  if (answer.status === 404 && sessionId && method !== "initialize" && await startSession(opened)) answer = await post(opened, msg);
  if (answer.problem) return request ? failure(id, answer.problem) : undefined;
  if (method === "initialize" && answer.messages.some(one => one.id === id)) started = true;
  for (const one of answer.messages) {
    if (method === "initialize" && one.id === id && typeof one.result?.protocolVersion === "string") protocol = one.result.protocolVersion;
    send(one);
  }
  // A notification, or Claude's reply to a request from the function, gets no answer.
  if (!request || answer.messages.some(one => one.id === id)) return;
  if (answer.status === 401) return signedOut(msg, actor, refused);
  failure(id, `fabrik's connector answered HTTP ${answer.status}${answer.text ? `: ${answer.text.slice(0, 300)}` : ""}`);
}

async function handle(msg) {
  const folderSays = relayed();
  if (!folderSays.local) return idle(msg, folderSays.problem);
  return relay(msg, folderSays.actor);
}

// Each message is handled as it comes, so a slow call never holds up the next. Calls in flight are counted, so stdin
// closing never cuts off an answer still on its way.
let buffer = "";
let inFlight = 0;
let ended = false;
// Exit once written output has reached the pipe; exiting at once cuts a large answer short.
const settle = () => { if (ended && inFlight === 0) process.stdout.write("", () => process.exit(0)); };

async function one(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return failure(null, "Parse error: the line is not JSON.", -32700); }
  if (!isRpc(msg)) return failure(msg?.id ?? null, "Invalid Request: not a JSON-RPC 2.0 message.", -32600);
  inFlight += 1;
  try { await handle(msg); }
  catch (err) { if (msg.id !== undefined && msg.method !== undefined) failure(msg.id, err instanceof Error ? err.message : String(err), -32603); }
  finally { inFlight -= 1; settle(); }
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) one(line);
  }
});
process.stdin.on("end", () => { ended = true; settle(); });
