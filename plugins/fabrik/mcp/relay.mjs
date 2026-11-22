#!/usr/bin/env node
// fabrik's local connector: an MCP server over stdio for a person who can't add fabrik's connector in Claude's
// Settings. It holds no tool of its own. It passes each JSON-RPC message Claude sends to the connector's hosted
// function, https://<project ref>.supabase.co/functions/v1/fabrik-apps, as the person, with the access token their
// sign-in saved on this computer, and writes each message the function answers back on stdout. So Claude gets the
// connector's own tools, instructions and cards, and the connector's code stays the only copy of them.
//
// It works only in a session folder whose actor file, .fabrik-actor.json, says "connector": "local", which
// fabrik sign-in --folder <folder> --local writes. In every other folder it lists no tools, so a person who has the
// connector never sees each tool twice. A folder with no sign-in saved answers each call with the sign-in command.
//
// Each message reads the actor file and the sign-in again, and the sign-in renews itself the way the plugin's other
// commands do, so a sign-in made while the session is open is used at the next call. The function's Mcp-Session-Id,
// when it gives one, is sent on every later call. The protocol on stdio is newline-delimited JSON-RPC, written
// directly, so the relay needs Node alone.
import { readActor, LOCAL } from "../cli/lib/actor-file.mjs";
import { SIGN_IN } from "../cli/fabrik-session.mjs";
import { sessionAccess } from "../cli/lib/session.mjs";

const SERVER = { name: "fabrik", version: "1" };
const DEFAULT_PROTOCOL = "2025-06-18";
const FUNCTION = "fabrik-apps";

const folder = process.env.FABRIK_SESSION_FOLDER || process.cwd();
const quote = value => process.platform === "win32" ? `"${value}"` : `'${String(value).replaceAll("'", `'\\''`)}'`;
const signInHere = () => `${SIGN_IN} --folder ${quote(folder)} --local`;

let sessionId = null;
let protocol = null;

const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");
const failure = (id, message) => send({ jsonrpc: "2.0", id, error: { code: -32000, message } });

/** Whether this folder asks for the relay: { local: true, actor } or { local: false, problem? }. */
function relayed() {
  const actor = readActor(folder);
  if (!actor) return { local: false };
  if (!actor.ok) return { local: false, problem: actor.problem };
  return actor.value.connector === LOCAL ? { local: true, actor } : { local: false };
}

/** The answer to a message in a folder the relay doesn't serve: a server with no tools. */
function idle(msg, problem) {
  const { id, method, params } = msg;
  if (id === undefined) return;
  if (method === "initialize")
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER, ...(problem ? { instructions: problem } : {}) } });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: [] } });
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  failure(id, problem ?? `fabrik's local connector is off in ${folder}. Turn it on with: ${signInHere()}`);
}

/** Each JSON-RPC message in the function's answer, from JSON or from a server-sent event stream. */
function messagesOf(type, text) {
  const parse = value => { try { return JSON.parse(value); } catch { return undefined; } };
  if (/text\/event-stream/i.test(type)) {
    const found = [];
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
      const value = data ? parse(data) : undefined;
      if (value !== undefined) found.push(...(Array.isArray(value) ? value : [value]));
    }
    return found;
  }
  const value = text ? parse(text) : undefined;
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/** A current token for the folder's person: { ok: true, ref, email, url, key, token } or { ok: false, problem }. */
async function access({ project_ref: ref, auth_email: email }) {
  const again = `Sign in again with: ${signInHere()}`;
  let opened;
  try { opened = await sessionAccess(ref, email); }
  catch (err) {
    if (err?.cause || err instanceof TypeError) return { ok: false, problem: `fabrik's project ${ref} could not be reached: ${err?.cause?.code ?? err?.message ?? err}` };
    return { ok: false, problem: `${err.message} ${again}` };
  }
  if (opened.missing) return { ok: false, problem: `${email} is not signed in to fabrik on this computer. Sign in with: ${signInHere()}` };
  if (opened.wrongUser) return { ok: false, problem: `The saved sign-in is for ${opened.wrongUser}, not ${email}. ${again}` };
  if (!opened.ok && opened.status) return { ok: false, problem: `Project ${ref} ended ${email}'s sign-in: ${opened.problem}. ${again}` };
  if (!opened.ok) return { ok: false, problem: opened.problem };
  return { ok: true, ref, email, url: opened.url, key: opened.key, token: opened.token };
}

async function relay(msg, actor) {
  const { id, method } = msg;
  const opened = await access(actor.value);
  if (!opened.ok) {
    if (id === undefined) return;
    // Claude starts the server even so, with no tools, and the sentence as its instructions.
    if (method === "initialize" || method === "tools/list" || method === "ping") return idle(msg, opened.problem);
    return failure(id, opened.problem);
  }
  const { url, key, token } = opened;
  let response;
  try {
    response = await fetch(`${url}/functions/v1/${FUNCTION}`, {
      method: "POST",
      headers: {
        apikey: key, Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}), ...(protocol ? { "MCP-Protocol-Version": protocol } : {}),
      },
      body: JSON.stringify(msg),
    });
  } catch (err) {
    if (id !== undefined) failure(id, `fabrik's project ${opened.ref} could not be reached: ${err?.cause?.code ?? err?.message ?? err}`);
    return;
  }
  const given = response.headers.get("mcp-session-id");
  if (given) sessionId = given;
  const text = await response.text();
  const answers = messagesOf(response.headers.get("content-type") ?? "", text);
  for (const one of answers) {
    if (method === "initialize" && one?.id === id && typeof one?.result?.protocolVersion === "string") protocol = one.result.protocolVersion;
    send(one);
  }
  if (id === undefined || answers.some(one => one?.id === id)) return;
  if (response.status === 401) return failure(id, `Project ${opened.ref} refused ${opened.email}'s sign-in. Sign in again with: ${signInHere()}`);
  failure(id, `fabrik's connector answered HTTP ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
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
  try { msg = JSON.parse(line); } catch { return; }
  inFlight += 1;
  try { await handle(msg); }
  catch (err) { if (msg?.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }); }
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
