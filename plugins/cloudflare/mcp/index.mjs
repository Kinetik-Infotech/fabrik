#!/usr/bin/env node
// A Cloudflare connector over stdio MCP, with no dependencies to install.
//
// The protocol is newline-delimited JSON-RPC, implemented directly rather than through an SDK,
// so this plugin works the moment it is installed: no npm install, no build step, nothing to go
// stale between the marketplace copy and the installed one.
//
// Init must never throw. Credentials are resolved inside each call, never at module load, so a
// missing token costs one tool its answer instead of taking the allowed surface down — the failure
// mode where a connector "isn't registering" and nothing says why.
import { TOOLS } from "./lib/tools.mjs";
import { credentials } from "./lib/api.mjs";
import { toolsForProfile } from "./lib/policy.mjs";

let PROFILE_TOOLS;
try {
  PROFILE_TOOLS = toolsForProfile(TOOLS);
} catch (err) {
  process.stderr.write(`[cloudflare] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(78);
}
const TOOL_BY_NAME = new Map(PROFILE_TOOLS.map(tool => [tool.name, tool]));

const SERVER = { name: "fabrik-cloudflare", version: "0.1.0" };
const DEFAULT_PROTOCOL = "2025-06-18";

const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

// Every tool answers in the same envelope, so a refusal reads like a result rather than a
// crash, and the agent can act on the sentence in `problem`.
const asContent = payload => ({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });

async function callTool(name, args) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return asContent({ ok: false, result: null, problem: `No such tool: ${name}` });

  const c = await credentials();
  if (!c.ok) return asContent({ ok: false, result: null, problem: c.problem });

  try {
    const out = await tool.handler({ token: c.creds.token, accountId: c.creds.accountId }, args ?? {});
    return asContent(out);
  } catch (err) {
    // A thrown handler is a defect in this connector, not an operator error. It is reported as
    // one refusal rather than killing the process, which would take the whole surface down.
    return asContent({ ok: false, result: null, problem: `${name} failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    return reply(id, {
      // Echo the client's version when it names one: a hardcoded reply is what makes a
      // connector fail to register against a newer client for no stated reason.
      protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER,
    });
  }
  // Notifications carry no id and take no reply.
  if (method === "notifications/initialized" || id === undefined) return;

  if (method === "tools/list") {
    return reply(id, { tools: PROFILE_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.schema })) });
  }
  if (method === "tools/call") {
    return reply(id, await callTool(params?.name, params?.arguments));
  }
  if (method === "ping") return reply(id, {});
  if (method === "resources/list") return reply(id, { resources: [] });
  if (method === "prompts/list") return reply(id, { prompts: [] });

  return fail(id, -32601, `Method not found: ${method}`);
}

let buffer = "";
// In-flight calls are counted so a closing stdin cannot kill the process mid-request. A tool
// call is async; stdin ends the moment the last frame is written, which on a piped session is
// long before Cloudflare has answered.
let inFlight = 0;
let ended = false;
const settle = () => { if (ended && inFlight === 0) process.exit(0); };

process.stdin.setEncoding("utf-8");
process.stdin.on("data", async chunk => {
  // The whole chunk is one unit of work. Counting per message lets settle() fire after an
  // early frame while later frames are still queued in the buffer, and they are then never
  // answered — the failure looks like a connector that replies once and goes silent.
  inFlight += 1;
  buffer += chunk;
  try {
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); }
    catch { continue; }  // A partial or malformed frame is skipped, never fatal.
    try { await handle(msg); }
    catch (err) {
      if (msg?.id !== undefined) fail(msg.id, -32603, err instanceof Error ? err.message : String(err));
    }
  }
  } finally {
    inFlight -= 1;
    settle();
  }
});
process.stdin.on("end", () => { ended = true; settle(); });
