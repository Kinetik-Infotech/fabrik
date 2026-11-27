// The public-agent hosted function, run against the step's own copy of the build, with Anthropic's API, Cloudflare's
// siteverify and Supabase's Storage and Auth answered here. Nothing outside this computer is called.
//
// An administrator sets the key, the Turnstile secret and an agent's files. A person who isn't one is refused each, and
// a wrong key or secret is not kept. The agent chat, which upgrade 0014 makes from the one chat box, takes its old
// KNOWLEDGE.md.
//
// A visitor's question in the file gets the file's answer, and one outside it gets don't know. The request to Claude
// holds the agent's INSTRUCTIONS.md, which starts as the starting text, then AGENTS.md, then KNOWLEDGE.md, cached
// together, the latest turns that fit, at most 10, and 1,000 tokens. Three agents each answer from their own files, and
// each one's cap counts its own tokens. AGENTS.md follows a new name or purpose and a removed agent, and an emptied
// INSTRUCTIONS.md stays empty. A post with no Turnstile token is refused before a database connection opens, and a
// failed check gets 403 and calls nothing.
//
// chat.js, run in a page, gets an answer to every question of a long conversation, and draws it again from the tab's
// session storage when the visitor comes back to the agent's page. A GET gives the Turnstile site key
// once one is saved. fabrik chat-page builds a page for each agent and a list of them from a Brand record, in its colours
// and with its logo. On a domain whose DNS Cloudflare runs, it puts them up as a Worker whose custom domain is the
// address, and never replaces a DNS record in the way; on another domain it prints the CNAME record. widget.js, run in a page on another website, opens the page of the agent data-agent names in a
// panel, where a question gets that agent's answer. An agent's greeting is saved with it, written into its page escaped,
// and drawn as its first answer in a new conversation. It is never posted or kept as an exchange, and a conversation the
// tab kept draws it once. Once today's tokens reach the cap, the answer is the resting message
// and Claude isn't called. No reply holds the key or the secret.
//
// Each question an agent answered, the resting answer and a failed answer included, is kept in public_exchange under
// the conversation id chat.js made when the box was drawn, and nowhere else. An id another agent holds is kept under a
// new one, and chat.js makes an id without crypto.randomUUID. A refused question is not kept, and no row holds the visitor's
// IP address, Turnstile token or browser. An administrator lists the conversations, reads one whole, and deletes one or
// every conversation of an agent before a date. The chat page says under the box that the business keeps the
// conversation. run.sh runs it.
import postgres from "npm:postgres@3.4.9";
import Anthropic from "npm:@anthropic-ai/sdk@0.137.0";
import { Window } from "npm:happy-dom@20.0.10";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const DB = Deno.env.get("STAND_IN_DB")!;
const FUNCTION = new URL("../../setup/functions/public-agent/index.ts", import.meta.url);
const KEY = `sk-ant-api03-public${crypto.randomUUID().replaceAll("-", "")}`;
const WRONG = `sk-ant-api03-wrong${crypto.randomUUID().replaceAll("-", "")}`;
const SECRET = `0x4AAAAAAA${crypto.randomUUID().replaceAll("-", "")}`;
const SITEKEY = "0x4AAAAAAAstandinSiteKey01";
const SERVICE_KEY = "service-key";
const GOOD_TOKEN = "turnstile-passed";
const KNOWLEDGE = "# Northfield Bakery\n\nOpening hours: 8am to 4pm, Tuesday to Saturday.\nServices: bread, cakes to order, and wholesale for cafes.\n";

let failed = 0;
function check(what: string, ok: boolean, seen: unknown) {
  console.log(`${ok ? "ok" : "FAIL"} - ${what}${ok ? "" : `: ${JSON.stringify(seen).slice(0, 2000)}`}`);
  if (!ok) failed++;
}
const sql = postgres(DB, { max: 1, prepare: false, onnotice() {} });

// Anthropic's Messages and Models APIs. An answer is the file's line that holds a word of the question, or don't know.
// A question holding "long answer" gets 830 characters. Every answer reads 6,000 tokens from the cache, which count 600,
// so it costs 1,030 tokens.
const sent: any[] = [];
// A reply as Claude sends it: whole, or as server-sent events in pieces of 20 characters when the request streams.
const answerAs = (body: any, message: any) => {
  if (!body.stream) return Response.json(message);
  const { content, stop_reason, usage, ...rest } = message;
  const text = (content ?? []).map((b: any) => b.text).join("");
  const lines: string[] = [];
  const event = (type: string, data: any) => lines.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("message_start", { message: { ...rest, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
  event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  for (let i = 0; i < text.length; i += 20) event("content_block_delta", { index: 0, delta: { type: "text_delta", text: text.slice(i, i + 20) } });
  event("content_block_stop", { index: 0 });
  event("message_delta", { delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
  event("message_stop", {});
  streamedReplies++;
  return new Response(lines.join(""), { headers: { "Content-Type": "text/event-stream" } });
};
let streamedReplies = 0;
const CUT = "We open at 8am. The café closes at 4pm, \"or later in summer!\"\nThe kitchen stops serving at";
const anthropic = Deno.serve({ port: 0, onListen() {} }, async (req) => {
  const url = new URL(req.url);
  if (req.headers.get("x-api-key") !== KEY) return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });
  if (req.method === "GET" && url.pathname.startsWith("/v1/models/")) {
    const id = url.pathname.slice("/v1/models/".length);
    if (!id.startsWith("claude-")) return Response.json({ type: "error", error: { type: "not_found_error", message: id } }, { status: 404 });
    // A model the organisation's key may not use.
    if (id.includes("locked")) return Response.json({ type: "error", error: { type: "permission_error", message: id } }, { status: 403 });
    return Response.json({ type: "model", id, display_name: id, created_at: "2026-09-01T00:00:00Z" });
  }
  if (req.method === "POST" && url.pathname === "/v1/messages") {
    const body = await req.json();
    sent.push(body);
    // An older model refuses the effort setting.
    if (body.output_config && body.model === "claude-haiku-4-5") return Response.json({ type: "error",
      error: { type: "invalid_request_error", message: "output_config.effort: This model does not support the effort parameter." } }, { status: 400 });
    const file = String(body.system?.at(-1)?.text ?? "");
    const words = String(body.messages.at(-1).content).toLowerCase().match(/[a-z]{4,}/g) ?? [];
    const line = file.split("\n").find((l) => words.some((w) => l.toLowerCase().includes(w)));
    const text = String(body.messages.at(-1).content).includes("long answer") ? `Long answer. ${"z".repeat(817)}`
      : line ? line.trim() : "I don't know. Please contact the owner.";
    // A reply with no content list, which the function can't read after Claude has charged for it.
    if (String(body.messages.at(-1).content).includes("broken reply")) return answerAs(body, { id: "msg_standin", type: "message", role: "assistant",
      model: body.model, stop_reason: "end_turn", content: null, usage: { input_tokens: 400, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 6000 } });
    // A reply that stops at the output cap, part way through its third sentence.
    if (String(body.messages.at(-1).content).includes("cut answer")) return answerAs(body, { id: "msg_standin", type: "message", role: "assistant",
      model: body.model, stop_reason: "max_tokens", stop_sequence: null, content: [{ type: "text", text: CUT }],
      usage: { input_tokens: 400, output_tokens: 4000, cache_creation_input_tokens: 0, cache_read_input_tokens: 6000 } });
    return answerAs(body, {
      id: "msg_standin", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text }],
      usage: { input_tokens: 400, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 6000 },
    });
  }
  return Response.json({ type: "error", error: { type: "not_found_error", message: url.pathname } }, { status: 404 });
});

// Cloudflare's siteverify: the secret SECRET, and the token GOOD_TOKEN, pass.
const verified: { secret: string; response: string }[] = [];
// Cloudflare's API, for the token TOKEN on the account acc-1: two domains whose DNS Cloudflare runs, and the Pages
// projects' custom domains. A custom domain turns active on the third time it's asked for, unless it's under
// stuck.example, which stays pending. One under broken.example is in error until it's checked again with a PATCH, one
// under refused.example can't be added, and one under flaky.example fails its first GET with a 503. The Workers' custom
// domains answer as Wrangler reads them: a changeset names an address another Worker has, or one with a DNS record in
// dnsRecords, and adding one with a record in its way and no override is refused.
const CF_TOKEN = "cf-token-1";
const zonesHeld = [{ name: "joinery.example", type: "full" }, { name: "smithjoinery.example", type: "full" }];
const customDomains = new Map<string, { project: string; asked: number; checkedAgain?: boolean }>();
let flakyFailed = false;
const cfCalls: string[] = [];
const dnsRecords = new Set<string>();
// Records Cloudflare's changeset misses and its PUT still refuses, as the live API did on 20 November 2026.
const hiddenRecords = new Set<string>();
const workerDomains = new Map<string, { id: string; service: string }>();
const workerPuts: any[] = [];
const workersApi = async (req: Request, url: URL) => {
  const one = /^\/client\/v4\/accounts\/acc-1\/workers\/domains\/([^/]+)$/.exec(url.pathname);
  if (one) {
    const d = [...workerDomains.entries()].find(([, v]) => v.id === one[1]);
    return d ? Response.json({ success: true, errors: [], result: { id: one[1], hostname: d[0], service: d[1].service } })
      : Response.json({ success: false, errors: [{ code: 100000, message: "Not found." }] }, { status: 404 });
  }
  const m = /^\/client\/v4\/accounts\/acc-1\/workers\/scripts\/([^/]+)\/domains\/(changeset|records)$/.exec(url.pathname);
  if (!m) return null;
  const body = await req.json();
  if (m[2] === "changeset") {
    const result = { added: [] as any[], removed: [], updated: [] as any[], conflicting: [] as any[] };
    for (const o of body) {
      const held = workerDomains.get(o.hostname);
      if (held) result.updated.push({ ...o, id: held.id, modified: held.service !== m[1] });
      else if (dnsRecords.has(o.hostname)) result.conflicting.push({ hostname: o.hostname });
      else result.added.push(o);
    }
    return Response.json({ success: true, errors: [], result });
  }
  workerPuts.push({ script: m[1], ...body });
  for (const o of body.origins) {
    if ((dnsRecords.has(o.hostname) || hiddenRecords.has(o.hostname)) && !body.override_existing_dns_record)
      return Response.json({ success: false, errors: [{ code: 100117, message: "Hostname already has externally managed DNS records." }] }, { status: 409 });
    workerDomains.set(o.hostname, { id: crypto.randomUUID().replaceAll("-", ""), service: m[1] });
  }
  return Response.json({ success: true, errors: [], result: body.origins });
};
const cloudflareApi = (req: Request, url: URL) => {
  cfCalls.push(`${req.method} ${url.pathname.slice("/client/v4".length)}`);
  if (req.headers.get("Authorization") !== `Bearer ${CF_TOKEN}`) return Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 });
  if (url.pathname === "/client/v4/zones" && url.searchParams.get("account.id") === "acc-1")
    return Response.json({ success: true, errors: [], result: zonesHeld, result_info: { page: 1, total_pages: 1 } });
  const m = /^\/client\/v4\/accounts\/acc-1\/pages\/projects\/([^/]+)\/domains(?:\/([^/]+))?$/.exec(url.pathname);
  const noRoute = () => Response.json({ success: false, errors: [{ code: 7003, message: "No route for that URI" }] }, { status: 404 });
  if (!m) return workersApi(req, url).then((r) => r ?? noRoute());
  return (async () => {
    if (req.method === "POST") {
      const { name } = await req.json();
      if (name.endsWith(".refused.example")) return Response.json({ success: false, errors: [{ code: 8000018, message: "The domain is not allowed." }] }, { status: 400 });
      customDomains.set(name, { project: m[1], asked: 0 });
      return Response.json({ success: true, errors: [], result: { name, status: "initializing" } });
    }
    if (m[2]?.endsWith(".flaky.example") && !flakyFailed) {
      flakyFailed = true;
      return Response.json({ success: false, errors: [{ code: 10013, message: "Service unavailable." }] }, { status: 503 });
    }
    const d = customDomains.get(decodeURIComponent(m[2] ?? ""));
    if (!d || d.project !== m[1]) return Response.json({ success: false, errors: [{ code: 8000021, message: "The domain you have requested does not exist." }] }, { status: 404 });
    if (req.method === "DELETE") { customDomains.delete(decodeURIComponent(m[2]!)); return Response.json({ success: true, errors: [], result: null }); }
    if (req.method === "PATCH") { d.checkedAgain = true; d.asked = 2; return Response.json({ success: true, errors: [], result: { name: m[2], status: "pending" } }); }
    d.asked++;
    if (m[2]!.endsWith(".broken.example") && !d.checkedAgain)
      return Response.json({ success: true, errors: [], result: { name: m[2], status: "error", validation_data: { status: "error", error_message: "CNAME record not set." } } });
    const status = !m[2]!.endsWith(".stuck.example") && d.asked >= 3 ? "active" : "pending";
    return Response.json({ success: true, errors: [], result: { name: m[2], status, verification_data: { status } } });
  })();
};
const cloudflare = Deno.serve({ port: 0, onListen() {} }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname.startsWith("/client/v4/")) return cloudflareApi(req, url);
  const form = await req.formData();
  const secret = String(form.get("secret") ?? ""), response = String(form.get("response") ?? "");
  verified.push({ secret, response });
  if (secret !== SECRET) return Response.json({ success: false, "error-codes": ["invalid-input-secret"] });
  return Response.json(response === GOOD_TOKEN ? { success: true, "error-codes": [] } : { success: false, "error-codes": ["invalid-input-response"] });
});

// Supabase's Storage, for the service key alone: an upload keeps the file and inserts its row, as Storage does. A move
// renames a file, and a delete removes it.
const files = new Map<string, string>();
const supabase = Deno.serve({ port: 0, onListen() {} }, async (req) => {
  const path = new URL(req.url).pathname;
  if (req.headers.get("Authorization") !== `Bearer ${SERVICE_KEY}`) return Response.json({ statusCode: "403", error: "Unauthorized" }, { status: 400 });
  if (path === "/storage/v1/object/move" && req.method === "POST") {
    const { bucketId, sourceKey, destinationKey } = await req.json();
    if (bucketId !== "public-agent" || !files.has(sourceKey)) return Response.json({ statusCode: "404", error: "not_found" }, { status: 400 });
    files.set(destinationKey, files.get(sourceKey)!);
    files.delete(sourceKey);
    await sql`update storage.objects set name = ${destinationKey} where bucket_id = 'public-agent' and name = ${sourceKey}`;
    return Response.json({ message: "Successfully moved" });
  }
  const name = /^\/storage\/v1\/object\/public-agent\/([a-z0-9/.-]+|KNOWLEDGE\.md)$/.exec(path)?.[1];
  if (!name) return Response.json({ statusCode: "403", error: "Unauthorized" }, { status: 400 });
  if (req.method === "GET") return files.has(name) ? new Response(files.get(name)) : Response.json({ statusCode: "404", error: "not_found" }, { status: 400 });
  if (req.method === "DELETE") {
    if (!files.delete(name)) return Response.json({ statusCode: "404", error: "not_found" }, { status: 400 });
    return Response.json({ message: "Successfully deleted" });
  }
  files.set(name, await req.text());
  await sql`insert into storage.objects(bucket_id, name, metadata) values ('public-agent', ${name}, ${sql.json({ size: files.get(name)!.length })})
    on conflict do nothing`;
  return Response.json({ Key: `public-agent/${name}` });
});

Deno.env.set("SUPABASE_URL", `http://127.0.0.1:${supabase.addr.port}`);
Deno.env.set("SUPABASE_DB_URL", DB);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
let handler: ((req: Request) => Promise<Response>) | undefined;
const serve = Deno.serve;
(Deno as unknown as { serve: unknown }).serve = (h: typeof handler) => { handler = h; return { finished: Promise.resolve(), shutdown() {} }; };
const { seam, STARTING, RESTING, UNAVAILABLE, NOT_CHECKED, wholeSentences, passFor, PASS_MS, PASS_QUESTIONS } = await import(FUNCTION.href);
(Deno as unknown as { serve: unknown }).serve = serve;
seam.client = (apiKey: string) => new Anthropic({ apiKey, baseURL: `http://127.0.0.1:${anthropic.addr.port}`, maxRetries: 0 });
seam.siteverify = `http://127.0.0.1:${cloudflare.addr.port}/turnstile/v0/siteverify`;
const users = new Set<string>();
seam.user = (token: string) => Promise.resolve(users.has(token) ? token : null);
let connections = 0;
const connect = seam.connect;
seam.connect = () => { connections++; return connect(); };

const replies: string[] = [];
const post = async (body: Record<string, unknown>, bearer?: string) => {
  const res = await handler!(new Request("http://function/", {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
  }));
  const text = await res.text();
  replies.push(text);
  return { status: res.status, body: JSON.parse(text), cors: res.headers.get("Access-Control-Allow-Origin") };
};
const ask = (question: string, more: Record<string, unknown> = {}) => post({ question, turnstile_token: GOOD_TOKEN, ...more });
const get = async () => {
  const res = await handler!(new Request("http://function/", { method: "GET" }));
  const text = await res.text();
  replies.push(text);
  return { status: res.status, body: JSON.parse(text), cors: res.headers.get("Access-Control-Allow-Origin"), cache: res.headers.get("Cache-Control") };
};

// Cloudflare's Wrangler, standing in: signed in to one account, it keeps the projects made, the folder deployed, and each
// Worker's config as deployed.
const WRANGLER = `import { readFileSync, writeFileSync } from "node:fs";
const state = new URL("wrangler-state.json", import.meta.url);
const s = JSON.parse(readFileSync(state, "utf8"));
const args = process.argv.slice(2), cmd = args.join(" ");
const save = () => writeFileSync(state, JSON.stringify(s));
if (cmd === "whoami --json") console.log(JSON.stringify({ loggedIn: true, email: "owner@joinery.example", accounts: [{ id: "acc-1", name: "Smith Joinery" }],
  tokenPermissions: ["account:read", "user:read", "pages:write", "zone:read", "workers:write", "workers_scripts:write", "offline_access"] }));
else if (cmd === "auth token --json") { s.tokens = (s.tokens ?? 0) + 1; save(); console.log(JSON.stringify({ type: "oauth", token: "${CF_TOKEN}" })); }
else if (cmd === "pages project list --json") console.log(JSON.stringify(s.projects.map(p => ({ "Project Name": p, "Project Domains": p + ".pages.dev" }))));
else if (args.slice(0, 3).join(" ") === "pages project create") { s.projects.push(args[3]); save(); }
else if (args.slice(0, 2).join(" ") === "pages deploy") { s.deployed = { folder: args[2], project: args[4], branch: args[6] }; save(); }
else if (args[0] === "deploy" && args[1] === "--config") { const c = JSON.parse(readFileSync(args[2], "utf8")); s.workers = { ...s.workers, [c.name]: c }; save(); }
else { console.error("unexpected: " + cmd); process.exit(9); }
`;

try {
  const admin = crypto.randomUUID(), person = crypto.randomUUID();
  await sql`insert into auth.users(id) values (${admin}), (${person})`;
  users.add(admin); users.add(person);
  const [{ h }] = await sql`select fabrik_private.provision_first_administrator(${admin}::uuid, 'Public agent owner') as h`;
  await sql`select fabrik_private.provision_actor(${h}::uuid, ${person}::uuid, 'Public agent staff', 'human', null, 'restricted', false)`;

  const [bucket] = await sql`select public from storage.buckets where id = 'public-agent'`;
  check("the build makes the private bucket public-agent", bucket?.public === false, bucket);
  // A project whose one chat box answered from KNOWLEDGE.md before there were many agents: upgrade 0014 made it the
  // agent chat.
  files.set("KNOWLEDGE.md", KNOWLEDGE);
  await sql`insert into fabrik_private.public_agent(slug, name) values ('chat', 'Chat')`;

  // Before setup, a visitor is told the assistant can't answer, and nothing outside is called.
  let res = await ask("When are you open?");
  check("before setup, a visitor's question gets 503 with the words a visitor reads, and calls neither Cloudflare nor Claude",
    res.status === 503 && res.body.problem === UNAVAILABLE && verified.length === 0 && sent.length === 0, res);
  const preflight = await handler!(new Request("http://function/", { method: "OPTIONS" }));
  check("a browser's preflight gets 204 with the headers a page on another site needs",
    preflight.status === 204 && preflight.headers.get("Access-Control-Allow-Origin") === "*" && /content-type/.test(preflight.headers.get("Access-Control-Allow-Headers") ?? ""), preflight.status);

  // The settings actions, for an administrator alone.
  for (const action of ["check", "set_key", "set_turnstile", "remove_key", "agents_list", "agent_create", "agent_change", "agent_remove",
    "knowledge_get", "knowledge_save", "instructions_get", "instructions_save", "settings", "conversations_list", "conversation_get", "conversations_delete"]) {
    res = await post({ action, agent: "chat", name: "Hijacked", key: KEY, secret: SECRET, text: KNOWLEDGE, id: crypto.randomUUID() }, person);
    if (res.status !== 403) check(`a person who isn't an administrator is refused ${action}`, false, res);
  }
  res = await post({ action: "check" });
  check("a person who isn't an administrator is refused every action, and an action with no sign-in gets 401",
    res.status === 401 && JSON.stringify([...files.keys()]) === '["KNOWLEDGE.md"]'
      && (await sql`select name from fabrik_private.public_agent`).map((r) => r.name).join() === "Chat" && (await sql`select count(*)::int as n from vault.secrets`)[0].n === 0, res);
  res = await post({ action: "set_key", key: WRONG }, admin);
  check("a key Anthropic refuses is not kept", res.status === 422 && (await sql`select count(*)::int as n from vault.secrets`)[0].n === 0, res);
  res = await post({ action: "set_key", key: KEY }, admin);
  const names = (await sql`select name from vault.secrets order by name`).map((r) => r.name);
  check("set_key keeps the key as public_agent_anthropic_key, apart from the connections key", res.status === 200
    && JSON.stringify(names) === JSON.stringify(["public_agent_anthropic_key"]), { res, names });
  res = await post({ action: "set_turnstile", secret: "0x4AAAAAAAnot-the-secret-0000000" }, admin);
  check("a Turnstile secret Cloudflare refuses is not kept", res.status === 422 && res.body.problem === "Cloudflare refused the secret key. Nothing was kept.", res);
  res = await post({ action: "set_turnstile", secret: SECRET }, admin);
  check("set_turnstile keeps the secret once siteverify takes it", res.status === 200 && res.body.turnstile === "set", res);
  const looked = await post({ action: "check" }, admin);
  check("check reads the agents' files and saves or moves none of them",
    looked.body.agents?.[0]?.knowledge === true && looked.body.agents?.[0]?.instructions === "starting"
      && JSON.stringify([...files.keys()]) === '["KNOWLEDGE.md"]', { looked: looked.body, files: [...files.keys()] });
  const [moved, movedToo] = await Promise.all([post({ action: "knowledge_get", agent: "chat" }, admin), post({ action: "knowledge_get", agent: "chat" }, admin)]);
  check("the agent chat's first read moves the KNOWLEDGE.md the one chat box answered from to agents/chat/knowledge.md, and a read at the same moment gets it too",
    moved.body.text === KNOWLEDGE && movedToo.body.text === KNOWLEDGE && JSON.stringify([...files.keys()]) === '["agents/chat/knowledge.md"]',
    { moved, movedToo, files: [...files.keys()] });
  res = await post({ action: "knowledge_save", agent: "chat", text: "x".repeat(100_001) }, admin);
  check("a KNOWLEDGE.md over 100,000 characters is refused", res.status === 400 && files.get("agents/chat/knowledge.md") === KNOWLEDGE, res);
  res = await post({ action: "knowledge_save", agent: "chat", text: KNOWLEDGE }, admin);
  const got = await post({ action: "knowledge_get", agent: "chat" }, admin);
  check("knowledge_save keeps KNOWLEDGE.md and knowledge_get reads it back", res.status === 200 && got.body.text === KNOWLEDGE, { res, got });
  const [{ n: queued }] = await sql`select count(*)::int as n from file_search.file_version where bucket_id = 'public-agent'`;
  check("KNOWLEDGE.md isn't queued for fabrik's file search", queued === 0, queued);
  res = await post({ action: "check" }, admin);
  check("check says the key is available, the secret set and the file there",
    res.body.key === "available" && res.body.turnstile === "set" && res.body.agents?.[0]?.knowledge === true, res);
  res = await post({ action: "settings", agent: "chat" }, admin);
  check("settings gives Claude Haiku 5.5 and a cap of 500,000 tokens to start, and no tokens today",
    res.body.model === "claude-haiku-5-5" && res.body.daily_cap_tokens === 500000 && res.body.today_tokens === 0, res);

  // The Turnstile site key: saved beside the secret, and given to anyone with a GET.
  const noSitekey = await get();
  check("before a site key is saved, a GET gets 503 with the words a visitor reads",
    noSitekey.status === 503 && noSitekey.body.problem === UNAVAILABLE && noSitekey.cors === "*", noSitekey);
  const badSitekey = await post({ action: "set_turnstile", sitekey: "not a site key" }, admin);
  const sameKeys = await post({ action: "set_turnstile", sitekey: SITEKEY, secret: SITEKEY }, admin);
  const refusedSitekey = await post({ action: "set_turnstile", sitekey: SITEKEY }, person);
  const [{ k: unsaved }] = await sql`select turnstile_sitekey as k from fabrik_private.public_agent_setting`;
  check("a site key that isn't one, the same key twice, or a person who isn't an administrator is refused, and nothing is kept",
    badSitekey.status === 400 && sameKeys.status === 400 && refusedSitekey.status === 403 && unsaved === null, { badSitekey, sameKeys, refusedSitekey, unsaved });
  const verifiedBefore = verified.length;
  res = await post({ action: "set_turnstile", sitekey: SITEKEY }, admin);
  check("set_turnstile with a site key alone checks the saved secret with siteverify, then keeps the site key",
    res.status === 200 && res.body.sitekey === "set" && res.body.turnstile === undefined && verified.slice(verifiedBefore).every((v) => v.secret === SECRET)
      && verified.length === verifiedBefore + 1, res);
  const gotSitekey = await get();
  const checked = await post({ action: "check" }, admin);
  const withSitekey = await post({ action: "settings" }, admin);
  check("a GET gives the site key to anyone, and check and settings say it is saved",
    gotSitekey.status === 200 && gotSitekey.body.sitekey === SITEKEY && gotSitekey.cors === "*" && checked.body.sitekey === "set"
      && withSitekey.body.turnstile_sitekey === SITEKEY, { gotSitekey, checked: checked.body, withSitekey: withSitekey.body });
  const openedBefore = connections;
  const again = await get();
  check("a second GET within a minute opens no database connection, and the browser may keep the answer five minutes",
    again.body.sitekey === SITEKEY && connections === openedBefore && gotSitekey.cache === "public, max-age=300" && noSitekey.cache === null,
    { again, connections, openedBefore, cache: gotSitekey.cache });
  const NEW_SITEKEY = "0x4AAAAAAAstandinSiteKey02";
  await post({ action: "set_turnstile", sitekey: NEW_SITEKEY }, admin);
  const changed = await get();
  await post({ action: "set_turnstile", sitekey: SITEKEY }, admin);
  const changedBack = await get();
  check("a site key saved with set_turnstile is what the next GET gives", changed.body.sitekey === NEW_SITEKEY && changedBack.body.sitekey === SITEKEY, { changed, changedBack });

  // A visitor's questions.
  const marker = `zebra${crypto.randomUUID().slice(0, 8)}`;
  res = await ask("What are your opening hours?");
  check("a question the file answers gets the file's answer", res.status === 200 && res.body.answer === "Opening hours: 8am to 4pm, Tuesday to Saturday." && res.cors === "*", res);
  const first = sent.at(-1);
  check("the agent chat's first question saves the starting text as its INSTRUCTIONS.md, and with one agent Claude gets it, then KNOWLEDGE.md with cache_control, the default model, low effort and at most 4,000 tokens",
    files.get("agents/chat/instructions.md") === STARTING && first.model === "claude-haiku-5-5" && first.max_tokens === 4000
      && first.output_config?.effort === "low" && first.system.length === 2
      && first.system[0].text === STARTING && !first.system[0].cache_control
      && first.system[1].text === `<knowledge>\n${KNOWLEDGE}\n</knowledge>` && first.system[1].cache_control?.type === "ephemeral" && !first.tools, first);
  const history = Array.from({ length: 12 }, (_, i) => [{ role: "user", content: `Earlier question ${i}` }, { role: "assistant", content: `Earlier answer ${i}` }]).flat();
  res = await ask(`What is your home address, ${marker}?`, { history });
  const second = sent.at(-1);
  check("a question outside the file gets don't know", res.status === 200 && /don't know/.test(res.body.answer), res);
  check("only the last 10 turns of history go to Claude, then the question",
    second.messages.length === 21 && second.messages[0].content === "Earlier question 2" && second.messages[20].content.includes(marker), second.messages.map((m: any) => m.content));
  res = await post({ question: "When are you open?", turnstile_token: "forged" });
  const calls = sent.length;
  check("a failed Turnstile check gets 403 and calls nothing", res.status === 403 && res.body.problem === NOT_CHECKED && sent.length === calls, res);
  const opened = connections;
  res = await post({ question: "When are you open?" });
  const tooLong = await post({ question: "When are you open?", turnstile_token: "t".repeat(2049) });
  check("a question with no Turnstile token, or one over 2,048 characters, gets 403 and opens no database connection",
    res.status === 403 && tooLong.status === 403 && connections === opened, { res, tooLong, connections, opened });
  res = await ask("Hi", { history: [{ role: "assistant", content: "Hello" }, { role: "assistant", content: "Again" }] });
  check("a history that doesn't alternate is refused", res.status === 400, res);
  const long = await ask("Hi", { history: [{ role: "user", content: "Hello" }, { role: "assistant", content: "x".repeat(4001) }] });
  const longSent = sent.at(-1).messages.length;
  const many = await ask("Hi", { history: Array.from({ length: 10 }, (_, i) => [{ role: "user", content: `Question ${i}` }, { role: "assistant", content: "y".repeat(900) }]).flat() });
  const manySent = sent.at(-1).messages;
  check("a history with an answer over 4,000 characters, or over 8,000 characters in all, loses its oldest turns, and the question is answered",
    long.status === 200 && longSent === 1 && many.status === 200 && manySent.length === 17 && manySent[0].content === "Question 2", { long, longSent, many, manySent: manySent.map((m: any) => m.content.slice(0, 12)) });

  // The daily cap. The most an answer can cost is held before Claude is called. Four answers of 1,030 tokens make 4,120,
  // with each one's 6,000 tokens of cache read counted at 600. Under a cap of 5,000 there's less room than one answer's
  // 4,000 tokens of output, so the answer is the resting message.
  res = await post({ action: "settings", agent: "chat", daily_cap_tokens: 5000 }, admin);
  const held = sent.length;
  const short = await ask("What services do you offer?");
  const afterHold = await post({ action: "settings", agent: "chat" }, admin);
  check("an answer whose most would pass the cap gets the resting message, Claude isn't called, and nothing stays held",
    short.body.answer === RESTING && sent.length === held && afterHold.body.today_tokens === 4120, { short, afterHold });
  const tooLow = await post({ action: "settings", agent: "chat", daily_cap_tokens: 4999 }, admin);
  res = await post({ action: "settings", agent: "chat", daily_cap_tokens: 6000 }, admin);
  check("settings counts today's tokens from Claude's usage, a cache read at a tenth, sets the cap, and refuses one under 5,000",
    res.body.today_tokens === 4120 && res.body.daily_cap_tokens === 6000 && tooLow.status === 400 && tooLow.body.problem.includes("5,000"), { res, tooLow });
  const before = sent.length;
  res = await ask("What services do you offer?");
  check("while the cap leaves less room than one answer's most, the answer is the resting message and Claude isn't called",
    res.status === 200 && res.body.answer === RESTING && sent.length === before, res);
  res = await post({ action: "settings", agent: "chat", model: "gpt-4" }, admin);
  check("a model that isn't Claude's is refused", res.status === 400, res);
  res = await post({ action: "settings", page: "https://elsewhere.example", daily_cap_tokens: 9000 }, admin);
  const [{ p: pageAfter }] = await sql`select page_address as p from fabrik_private.public_agent_setting`;
  check("settings with a cap and no agent is refused, and the page's address it gave isn't saved", res.status === 400 && pageAfter === null, { res, pageAfter });

  // No table but public_exchange holds a question.
  const tables = await sql`select format('%I.%I', table_schema, table_name) as t from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')`;
  const holding: string[] = [];
  for (const { t } of tables) {
    const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${t} r where r::text like $1`, [`%${marker}%`]);
    if (n && t !== "fabrik_private.public_exchange") holding.push(t);
  }
  const [usage] = await sql`select tokens from fabrik_private.public_agent_usage where slug = 'chat' and day = (now() at time zone 'utc')::date`;
  check(`no row in any of ${tables.length} tables but public_exchange holds a question, and the usage row holds today's tokens`, holding.length === 0 && Number(usage?.tokens) === 4120, { holding, usage });

  // The hold counts bytes, so a question in any language can't pass the cap. 2,000 Chinese characters are 6,000 bytes:
  // with 4,120 spent, a cap of 10,120 leaves too little room for them.
  res = await post({ action: "settings", agent: "chat", daily_cap_tokens: 10120 }, admin);
  const beforeChinese = sent.length;
  const chinese = await ask("营".repeat(2000));
  check("a 2,000-character question in Chinese is held at its 6,000 bytes, so it gets the resting message under a cap of 10,120",
    chinese.body.answer === RESTING && sent.length === beforeChinese, chinese);
  // A reply that breaks after Claude has charged for it still puts its own tokens in place of what was held.
  res = await post({ action: "settings", agent: "chat", daily_cap_tokens: 500000 }, admin);
  const broken = await ask("Tell me about the broken reply");
  const afterBroken = await post({ action: "settings", agent: "chat" }, admin);
  check("a reply the function can't read gets the words a visitor reads, and today's tokens hold its 1,030, not what was held",
    broken.status === 500 && broken.body.problem === UNAVAILABLE && afterBroken.body.today_tokens === 4120 + 1030, { broken, afterBroken });
  const [brokenKept] = await sql`select answer, input_tokens, output_tokens from fabrik_private.public_exchange where question = 'Tell me about the broken reply'`;
  check("a question Claude failed on is kept with the words the visitor read and the tokens Claude charged",
    brokenKept?.answer === UNAVAILABLE && brokenKept.input_tokens === 6400 && brokenKept.output_tokens === 30, { brokenKept });

  // Three agents. Each answers from its own files, and Claude's system prompt holds its INSTRUCTIONS.md, AGENTS.md and
  // KNOWLEDGE.md and nothing else.
  const BOOKINGS = "Tables: book by phone on 01234 567890.\n";
  const CAKES = "Celebration cakes: order a week ahead.\n";
  const BEA = "You are Bea, who takes the bakery's bookings. Speak briskly and kindly.\n";
  const badSlug = await post({ action: "agent_create", agent: "Bookings!", name: "Bookings" }, admin);
  const madeBookings = await post({ action: "agent_create", agent: "bookings", name: "Bookings", purpose: "Books a table.", topic: "  Visits\n" }, admin);
  const madeCakes = await post({ action: "agent_create", agent: "cakes", name: "Cakes", purpose: "Answers questions about celebration cakes." }, admin);
  const twice = await post({ action: "agent_create", agent: "cakes", name: "Cakes again" }, admin);
  check("agent_create makes an agent with its slug, name and purpose, and refuses a slug that isn't one or is taken",
    badSlug.status === 400 && madeBookings.body.slug === "bookings" && madeCakes.body.purpose === "Answers questions about celebration cakes."
      && twice.status === 409 && files.get("agents/cakes/instructions.md") === STARTING, { badSlug, madeBookings, madeCakes, twice });
  // An agent's topic is saved with it, on one line, changed with agent_change and taken away with an empty one.
  const cakesTopic = await post({ action: "agent_change", agent: "cakes", topic: "Celebrations" }, admin);
  const cakesKept = await post({ action: "agent_change", agent: "cakes", purpose: "Answers questions about celebration cakes." }, admin);
  const longTopic = await post({ action: "agent_change", agent: "cakes", topic: "x".repeat(81) }, admin);
  const cakesCleared = await post({ action: "agent_change", agent: "cakes", topic: "" }, admin);
  const topicsListed = (await post({ action: "agents_list" }, admin)).body.agents.map((a: any) => [a.slug, a.topic]);
  check("an agent's topic is saved with it on one line, kept when another field changes, changed and taken away with agent_change, and refused past 80 characters",
    madeBookings.body.topic === "Visits" && madeCakes.body.topic === "" && cakesTopic.body.topic === "Celebrations" && cakesKept.body.topic === "Celebrations"
      && longTopic.status === 400 && cakesCleared.body.topic === "" && JSON.stringify(topicsListed) === '[["chat",""],["bookings","Visits"],["cakes",""]]',
    { madeBookings: madeBookings.body, cakesTopic, cakesKept, longTopic, cakesCleared, topicsListed });
  // An agent's greeting is saved with it, its line breaks kept and its ends trimmed, changed with agent_change and taken
  // away with an empty one.
  const cakesGreeting = await post({ action: "agent_change", agent: "cakes", greeting: "  Hello!\r\nAsk me about cakes.\n" }, admin);
  const greetingKept = await post({ action: "agent_change", agent: "cakes", topic: "Celebrations" }, admin);
  const longGreeting = await post({ action: "agent_change", agent: "cakes", greeting: "x".repeat(601) }, admin);
  const greetingsListed = (await post({ action: "agents_list" }, admin)).body.agents.map((a: any) => [a.slug, a.greeting]);
  const greetingCleared = await post({ action: "agent_change", agent: "cakes", greeting: "", topic: "" }, admin);
  check("an agent's greeting is saved with its line breaks and listed, kept when another field changes, refused past 600 characters, and taken away with an empty one",
    madeCakes.body.greeting === "" && cakesGreeting.body.greeting === "Hello!\nAsk me about cakes." && greetingKept.body.greeting === "Hello!\nAsk me about cakes."
      && longGreeting.status === 400 && JSON.stringify(greetingsListed) === '[["chat",""],["bookings",""],["cakes","Hello!\\nAsk me about cakes."]]'
      && greetingCleared.body.greeting === "",
    { cakesGreeting: cakesGreeting.body, greetingKept: greetingKept.body, longGreeting, greetingsListed, greetingCleared: greetingCleared.body });
  await post({ action: "settings", page: "https://fabrik-chat-abc.pages.dev/" }, admin);
  const AGENTS_MD = "- Chat, https://fabrik-chat-abc.pages.dev/chat/\n- Bookings, https://fabrik-chat-abc.pages.dev/bookings/: Books a table.\n" +
    "- Cakes, https://fabrik-chat-abc.pages.dev/cakes/: Answers questions about celebration cakes.\n";
  check("AGENTS.md lists every agent, one line each, with its name, its page's address and its purpose", files.get("agents.md") === AGENTS_MD, files.get("agents.md"));
  await post({ action: "knowledge_save", agent: "bookings", text: BOOKINGS }, admin);
  await post({ action: "knowledge_save", agent: "cakes", text: CAKES }, admin);
  await post({ action: "instructions_save", agent: "bookings", text: BEA }, admin);
  const askedChat = await ask("What are your opening hours?");
  const chatSystem = sent.at(-1).system;
  const askedBookings = await ask("How do I book tables?", { agent: "bookings" });
  const bookingsSystem = sent.at(-1).system;
  const askedCakes = await ask("Can I order celebration cakes?", { agent: "cakes" });
  const cakesSystem = sent.at(-1).system;
  const block = (text: string, cached = false) => JSON.stringify({ type: "text", text, ...(cached ? { cache_control: { type: "ephemeral" } } : {}) });
  const holds = (system: unknown[], parts: string[]) => JSON.stringify(system) === `[${parts.join(",")}]`;
  check("each agent answers from its own files, and Claude's system prompt is its INSTRUCTIONS.md, AGENTS.md and KNOWLEDGE.md, cached together, and nothing else",
    askedChat.body.answer === "Opening hours: 8am to 4pm, Tuesday to Saturday." && askedBookings.body.answer === "Tables: book by phone on 01234 567890."
      && askedCakes.body.answer === "Celebration cakes: order a week ahead."
      && holds(chatSystem, [block(STARTING), block(`<agents>\n${AGENTS_MD}\n</agents>`), block(`<knowledge>\n${KNOWLEDGE}\n</knowledge>`, true)])
      && holds(bookingsSystem, [block(BEA), block(`<agents>\n${AGENTS_MD}\n</agents>`), block(`<knowledge>\n${BOOKINGS}\n</knowledge>`, true)])
      && holds(cakesSystem, [block(STARTING), block(`<agents>\n${AGENTS_MD}\n</agents>`), block(`<knowledge>\n${CAKES}\n</knowledge>`, true)]),
    { askedChat, askedBookings, askedCakes, chatSystem, bookingsSystem, cakesSystem });
  const callsBefore = sent.length;
  const unknown = await ask("Hi", { agent: "nobody" });
  check("a question to an agent fabrik doesn't have gets 404 and calls nothing", unknown.status === 404 && sent.length === callsBefore, unknown);

  // Each agent's cap counts its own tokens.
  const tokensOf = async () => Object.fromEntries((await post({ action: "agents_list" }, admin)).body.agents.map((a: any) => [a.slug, a.today_tokens]));
  const counted = await tokensOf();
  await post({ action: "settings", agent: "bookings", daily_cap_tokens: 5000 }, admin);
  const restingBookings = await ask("How do I book tables?", { agent: "bookings" });
  const stillCakes = await ask("Can I order celebration cakes?", { agent: "cakes" });
  check("each agent's cap counts its own tokens: Bookings rests at its cap, and Cakes still answers",
    counted.chat === 5150 + 1030 && counted.bookings === 1030 && counted.cakes === 1030 && restingBookings.body.answer === RESTING
      && stillCakes.body.answer === "Celebration cakes: order a week ahead.", { counted, restingBookings, stillCakes });
  await post({ action: "settings", agent: "bookings", daily_cap_tokens: 500000 }, admin);

  // An emptied INSTRUCTIONS.md stays empty.
  await post({ action: "instructions_save", agent: "bookings", text: "" }, admin);
  await ask("How do I book tables?", { agent: "bookings" });
  const emptySystem = sent.at(-1).system;
  const emptyGot = await post({ action: "instructions_get", agent: "bookings" }, admin);
  const emptyCheck = (await post({ action: "check" }, admin)).body.agents;
  check("an emptied INSTRUCTIONS.md stays empty, and Claude then gets AGENTS.md and KNOWLEDGE.md alone",
    files.get("agents/bookings/instructions.md") === "" && emptyGot.body.text === ""
      && holds(emptySystem, [block(`<agents>\n${AGENTS_MD}\n</agents>`), block(`<knowledge>\n${BOOKINGS}\n</knowledge>`, true)])
      && JSON.stringify(emptyCheck.map((a: any) => a.instructions)) === '["starting","empty","starting"]', { emptySystem, emptyGot, emptyCheck });

  // The key is checked against every agent's model, not one.
  await sql`update fabrik_private.public_agent set model = 'claude-locked-1' where slug = 'bookings'`;
  const lockedCheck = (await post({ action: "check" }, admin)).body;
  await sql`update fabrik_private.public_agent set model = 'claude-haiku-5-5' where slug = 'bookings'`;
  check("check says Anthropic refuses the key when one agent's model is one the key may not use", lockedCheck.key === "refused", lockedCheck);

  // AGENTS.md follows a new name and purpose, on one line however it was typed, and a removed agent.
  await post({ action: "agent_change", agent: "cakes", name: "Celebration cakes", purpose: "Cakes for birthdays\nand weddings." }, admin);
  const renamed = files.get("agents.md");
  const removed = await post({ action: "agent_remove", agent: "cakes" }, admin);
  const afterRemove = files.get("agents.md");
  const [{ n: cakesTokens }] = await sql`select ((select count(*) from fabrik_private.public_agent_usage where slug = 'cakes')
    + (select count(*) from fabrik_private.public_exchange where slug = 'cakes'))::int as n`;
  check("AGENTS.md changes when an agent is renamed or removed, and a removed agent's files, tokens and conversations go",
    renamed === AGENTS_MD.replace("- Cakes, https://fabrik-chat-abc.pages.dev/cakes/: Answers questions about celebration cakes.", "- Celebration cakes, https://fabrik-chat-abc.pages.dev/cakes/: Cakes for birthdays and weddings.")
      && removed.body.removed === true && afterRemove === "- Chat, https://fabrik-chat-abc.pages.dev/chat/\n- Bookings, https://fabrik-chat-abc.pages.dev/bookings/: Books a table.\n"
      && !files.has("agents/cakes/knowledge.md") && !files.has("agents/cakes/instructions.md") && cakesTokens === 0, { renamed, removed, afterRemove, cakesTokens });

  // chat.js in a page, posting to the function. Each answer is 830 characters, so after nine of them the last 10 turns
  // would pass 8,000 characters. chat.js sends the latest turns that fit, and every question gets its answer.
  const page = new Window({ url: "https://bakery.example/", settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
  const doc = page.document;
  const tag = doc.createElement("script");
  tag.setAttribute("data-address", "https://project.example/functions/v1/public-agent");
  tag.setAttribute("data-sitekey", "1x00000000000000000000AA");
  doc.body.appendChild(tag);
  Object.defineProperty(doc, "currentScript", { get: () => tag, configurable: true });
  const posted: any[] = [];
  const pageFetch = (url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)));
    return handler!(new Request(url, init));
  };
  (page as any).turnstile = { render: () => 0, getResponse: () => GOOD_TOKEN, reset() {} };
  new Function("window", "document", "fetch", await Deno.readTextFile(new URL("../../plugins/fabrik/public-agent/chat.js", import.meta.url)))(page, doc, pageFetch);
  (page as any).fabrikChatTurnstile();
  const input = doc.querySelector("#fabrik-chat input") as any, send = doc.querySelector("#fabrik-chat button") as any;
  for (let i = 1; i <= 12; i++) {
    input.value = `Question ${i}: give me the long answer`;
    doc.querySelector("#fabrik-chat form")!.dispatchEvent(new page.Event("submit", { cancelable: true }));
    while (send.disabled) await new Promise((r) => setTimeout(r));
  }
  const answers = [...doc.querySelectorAll("#fabrik-chat li.a")].map((li: any) => li.className);
  const lastHistory = posted.at(-1).history;
  const pageConversation = posted[0].conversation;
  const [pageKept] = await sql`select count(*)::int as n, count(distinct conversation)::int as conversations from fabrik_private.public_exchange where conversation = ${pageConversation}::uuid`;
  const keptLine = doc.querySelector("#fabrik-chat p.kept")?.textContent;
  check("chat.js gets an answer to each of 12 questions with 830-character answers, sending the latest 9 turns once 10 would pass 8,000 characters",
    answers.length === 12 && answers.every((c) => c === "a") && lastHistory.length === 18 && lastHistory[0].content.startsWith("Question 3:")
      && lastHistory.reduce((n: number, t: any) => n + t.content.length, 0) <= 8000,
    { answers, sizes: posted.map((p) => [p.history.length, p.history.reduce((n: number, t: any) => n + t.content.length, 0)]) });
  check("chat.js makes one conversation id when the box is drawn and sends it with every question, the function keeps all 12 under it, and with no data-business the line under the box names no business",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(pageConversation) && posted.every((p) => p.conversation === pageConversation)
      && pageKept.n === 12 && keptLine === "This conversation is kept to improve its answers.", { pageConversation, pageKept, keptLine, sentIds: posted.map((p) => p.conversation) });
  // The same tab, back on this agent's page after another page of the chat: its session storage, copied into a new page,
  // draws the 24 messages again with their times, and the next question carries on the conversation with its history.
  // Another agent's page in the same tab starts a conversation of its own.
  const tabStorage = Object.fromEntries(Object.keys(page.sessionStorage).map((k) => [k, page.sessionStorage.getItem(k)]));
  await page.happyDOM.close();
  const backAgain = async (slug: string | null, storage: Record<string, unknown> = tabStorage) => {
    const w = new Window({ url: "https://bakery.example/", settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
    for (const [k, v] of Object.entries(storage)) w.sessionStorage.setItem(k, String(v));
    const t = w.document.createElement("script");
    t.setAttribute("data-address", "https://project.example/functions/v1/public-agent");
    t.setAttribute("data-sitekey", "1x00000000000000000000AA");
    if (slug) t.setAttribute("data-agent", slug);
    w.document.body.appendChild(t);
    Object.defineProperty(w.document, "currentScript", { get: () => t, configurable: true });
    const bodies: any[] = [];
    (w as any).turnstile = { render: () => 0, getResponse: () => GOOD_TOKEN, reset() {} };
    new Function("window", "document", "fetch", await Deno.readTextFile(new URL("../../plugins/fabrik/public-agent/chat.js", import.meta.url)))(w, w.document,
      (url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return handler!(new Request(url, init)); });
    (w as any).fabrikChatTurnstile();
    const drawn = [...w.document.querySelectorAll("#fabrik-chat li")].map((li: any) => [li.className, li.querySelector("time")?.dateTime ?? ""]);
    const box = w.document.querySelector("#fabrik-chat input") as any, button = w.document.querySelector("#fabrik-chat button") as any;
    box.value = "And one more question";
    w.document.querySelector("#fabrik-chat form")!.dispatchEvent(new w.Event("submit", { cancelable: true }));
    while (button.disabled) await new Promise((r) => setTimeout(r));
    await w.happyDOM.close();
    return { drawn, body: bodies[0] };
  };
  const back = await backAgain(null), cakesTab = await backAgain("cakes");
  check("back on an agent's page in the same tab, chat.js draws the conversation again from the tab's session storage and carries it on, and another agent's page starts its own",
    back.drawn.length === 24 && back.drawn.every(([c, at], i) => c === (i % 2 ? "a" : "q") && !Number.isNaN(Date.parse(at)))
      && back.body?.conversation === pageConversation && back.body.history.length === 18 && back.body.history.at(-2).content.startsWith("Question 12:")
      && cakesTab.drawn.length === 0 && cakesTab.body?.history.length === 0 && cakesTab.body.conversation !== pageConversation,
    { drawn: back.drawn.length, conversation: back.body?.conversation, history: back.body?.history?.length, cakesTab });
  // A stored conversation the function would refuse is never sent: a bad time is drawn as now, an id that isn't a UUID or
  // turns out of order start afresh, and a conversation stored with no id, by a browser with no crypto, carries on with none.
  {
  const pair = [{ role: "user", content: "Do you bake bread?" }, { role: "assistant", content: "Every morning." }];
  const drawnBefore = [{ text: "Do you bake bread?", kind: "q", at: "yesterday" }, { text: "Every morning.", kind: "a", at: "not a time" }];
  const tab = (value: unknown) => ({ "fabrik-chat:chat": JSON.stringify(value) });
  const badTime = await backAgain(null, tab({ conversation: pageConversation, turns: pair, shown: drawnBefore }));
  const badId = await backAgain(null, tab({ conversation: "not-a-uuid", turns: pair, shown: drawnBefore }));
  const outOfOrder = await backAgain(null, tab({ conversation: pageConversation, turns: [pair[1], pair[0]], shown: drawnBefore }));
  const noId = await backAgain(null, tab({ conversation: null, turns: pair, shown: drawnBefore }));
  check("chat.js sends no stored conversation the function would refuse: a bad time is drawn as now, a bad id or turns out of order start afresh, and a conversation with no id carries on with none",
    badTime.drawn.length === 2 && badTime.drawn.every(([, at]) => !Number.isNaN(Date.parse(at))) && badTime.body?.conversation === pageConversation && badTime.body.history.length === 2
      && badId.drawn.length === 0 && badId.body?.conversation !== "not-a-uuid" && badId.body.history.length === 0
      && outOfOrder.drawn.length === 0 && outOfOrder.body?.history.length === 0
      && noId.drawn.length === 2 && noId.body && !("conversation" in noId.body) && noId.body.history.length === 2,
    { badTime, badId, outOfOrder, noId });
  }

  // A browser without crypto.randomUUID, such as Safari before 15.4 or a page on http, and one with no crypto at all.
  const oldBrowser = async (crypto: unknown) => {
    const w = new Window({ url: "http://bakery.example/", settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
    Object.defineProperty(w, "crypto", { value: crypto, configurable: true });
    const t = w.document.createElement("script");
    t.setAttribute("data-address", "https://project.example/functions/v1/public-agent");
    t.setAttribute("data-sitekey", "1x00000000000000000000AA");
    w.document.body.appendChild(t);
    Object.defineProperty(w.document, "currentScript", { get: () => t, configurable: true });
    const bodies: any[] = [];
    (w as any).turnstile = { render: () => 0, getResponse: () => GOOD_TOKEN, reset() {} };
    try {
      new Function("window", "document", "fetch", await Deno.readTextFile(new URL("../../plugins/fabrik/public-agent/chat.js", import.meta.url)))(w, w.document,
        (url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return handler!(new Request(url, init)); });
    } catch (err) { await w.happyDOM.close(); return { bodies, answered: 0, error: String(err) }; }
    (w as any).fabrikChatTurnstile();
    const box = w.document.querySelector("#fabrik-chat input") as any, button = w.document.querySelector("#fabrik-chat button") as any;
    for (const q of ["What are your opening hours?", "Do you make cakes to order?"]) {
      box.value = q;
      w.document.querySelector("#fabrik-chat form")!.dispatchEvent(new w.Event("submit", { cancelable: true }));
      while (button.disabled) await new Promise((r) => setTimeout(r));
    }
    const answered = w.document.querySelectorAll("#fabrik-chat li.a").length;
    await w.happyDOM.close();
    return { bodies, answered };
  };
  const noRandomUUID = await oldBrowser({ getRandomValues: (b: Uint8Array) => crypto.getRandomValues(b) });
  const noCrypto = await oldBrowser(undefined);
  check("without crypto.randomUUID chat.js still draws the box and sends one random UUID with both questions, and with no crypto it sends none and both are answered",
    noRandomUUID.answered === 2 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(noRandomUUID.bodies[0]?.conversation)
      && noRandomUUID.bodies[1]?.conversation === noRandomUUID.bodies[0].conversation
      && noCrypto.answered === 2 && noCrypto.bodies.every((b) => !("conversation" in b)), { noRandomUUID, noCrypto });

  // fabrik chat-page's build and put-up, with the Brand record, the project's address and Wrangler standing in.
  const { chatPage, chatProject, widgetLine } = await import(new URL("../../plugins/fabrik/cli/chat-page.mjs", import.meta.url).href);
  const { brandOf } = await import(new URL("../../plugins/fabrik/cli/lib/brand.mjs", import.meta.url).href);
  const brandRecord = JSON.parse(await Deno.readTextFile(new URL("../../plugins/fabrik/__tests__/widgets/brand-record.json", import.meta.url)));
  const home = await Deno.makeTempDir();
  const tools = `${home}/wrangler`;
  await Deno.mkdir(tools);
  await Deno.writeTextFile(`${tools}/wrangler.mjs`, WRANGLER);
  await Deno.writeTextFile(`${tools}/wrangler-state.json`, JSON.stringify({ projects: [] }));
  const node = spawnSync("node", ["--version"]).status === 0 ? "node" : null;
  const said: string[] = [];
  // The agents and the page's address, read and saved with public-agent's own actions, as the administrator.
  const action = async (body: Record<string, unknown>) => { const r = await post(body, admin); if (r.status !== 200) throw new Error(r.body.problem); return r.body; };
  const readAgents = async () => (await action({ action: "agents_list" })).agents;
  const savePage = (page: string) => action({ action: "settings", page });
  // Cloudflare's API and the DNS stand in too. resolve gives what the DNS answers for a host, reach whether its https
  // address answers, and isDomain says outside.example is a domain itself.
  const dnsAnswers = new Map<string, boolean[]>(), reachAnswers = new Map<string, boolean[]>();
  const domains = { api: `http://127.0.0.1:${cloudflare.addr.port}/client/v4`, pause: () => Promise.resolve(), tries: 5,
    resolve: (host: string) => Promise.resolve(dnsAnswers.get(host)?.shift() ?? true), reach: (host: string) => Promise.resolve(reachAnswers.get(host)?.shift() ?? true),
    isDomain: (host: string) => Promise.resolve(host === "outside.example"),
    onCloudflare: (domain: string) => Promise.resolve(domain === "elsewhere.example") };
  reachAnswers.set("chat.joinery.example", [false, false, true]);
  const domainAnswers = ["3", "1", ""], asked: string[] = [];
  const options = { ask: () => Promise.reject(new Error("This command needs an interactive terminal.")), wrangler: [node!, `${tools}/wrangler.mjs`], home, env: Deno.env.toObject(), domains };
  // Bookings greets a visitor, in two lines that need escaping in the page. Chat has no greeting.
  const GREETING = 'Hello & welcome to "Bookings".\nAsk me <anything> about tables.';
  await action({ action: "agent_change", agent: "bookings", greeting: GREETING });
  const built = await chatPage({ ref: "abcdefghijklmnopqrst", url: "https://abcdefghijklmnopqrst.supabase.co", readBrand: () => Promise.resolve(brandOf(brandRecord)), readAgents, savePage },
    { ...options, say: (l: string) => said.push(l), ask: (q: string) => { asked.push(q); return Promise.resolve(domainAnswers.shift()!); } });
  const wrangled = JSON.parse(await Deno.readTextFile(`${tools}/wrangler-state.json`));
  const rootHtml = await Deno.readTextFile(`${built.folder}/index.html`);
  const bookingsHtml = await Deno.readTextFile(`${built.folder}/bookings/index.html`);
  const widgetJs = await Deno.readTextFile(`${built.folder}/widget.js`);
  const pagesHost = `${chatProject("abcdefghijklmnopqrst")}.pages.dev`;
  const site = "https://chat.joinery.example";
  check("fabrik chat-page lists the Cloudflare account's domains, asks which one again after an answer off the list, and asks for the subdomain, chat on Return",
    said.includes("1. joinery.example") && said.includes("2. smithjoinery.example") && said.includes("3 is not one of the numbers or a domain such as example.com.")
      && JSON.stringify(asked) === JSON.stringify([
        `Which domain is the chat for? Type its number, or another domain. Press Return to keep ${pagesHost}: `,
        `Which domain is the chat for? Type its number, or another domain. Press Return to keep ${pagesHost}: `,
        "Which subdomain of joinery.example? Press Return for chat: "]), { said, asked });
  const worker = "fabrik-chat-abcdefghijklmnopqrst";
  check("on a domain whose DNS Cloudflare runs, it puts the pages up as the Worker fabrik-chat-<ref>, with the pages as its assets, no script, no route and no workers.dev address",
    JSON.stringify(wrangled.workers?.[worker]) === JSON.stringify({ name: worker, account_id: "acc-1", compatibility_date: "2026-11-01", workers_dev: false,
      preview_urls: false, assets: { directory: built.folder } }), wrangled.workers);
  check("it makes chat.joinery.example the Worker's custom domain without replacing any DNS record, adds nothing to the Pages project, and waits until the address answers",
    JSON.stringify(cfCalls) === JSON.stringify(["GET /zones", `GET /accounts/acc-1/pages/projects/${worker}/domains/chat.joinery.example`,
      `POST /accounts/acc-1/workers/scripts/${worker}/domains/changeset`, `PUT /accounts/acc-1/workers/scripts/${worker}/domains/records`])
      && JSON.stringify(workerPuts) === JSON.stringify([{ script: worker, override_scope: true, override_existing_origin: false, override_existing_dns_record: false,
        origins: [{ hostname: "chat.joinery.example", zone_name: "joinery.example" }] }])
      && reachAnswers.get("chat.joinery.example")!.length === 0
      && said.includes("Cloudflare is making the DNS record and certificate for chat.joinery.example.") && said.includes("chat.joinery.example is ready.")
      && !said.some((l) => l.includes("CNAME"))
      && said.includes(`Add chat.joinery.example under Hostname management in the Turnstile widget, beside ${pagesHost}, or the chat can't check visitors there.`), { cfCalls, workerPuts, said });
  check("it reads the sign-in's token for Cloudflare's API once, not for each call", wrangled.tokens === 1, wrangled.tokens);
  check("fabrik chat-page puts a page for each agent, the list of agents, chat.js and widget.js up as fabrik-chat-<ref>, and gives each agent's page and widget line at the own domain",
    built.site === site && JSON.stringify(built.agents) === JSON.stringify([
      { slug: "chat", name: "Chat", page: `${site}/chat/`, widget: `<script src="${site}/widget.js" data-agent="chat" async></script>` },
      { slug: "bookings", name: "Bookings", page: `${site}/bookings/`, widget: widgetLine(site, "bookings") }])
      && wrangled.deployed?.project === "fabrik-chat-abcdefghijklmnopqrst" && wrangled.deployed?.folder === built.folder && wrangled.deployed?.branch === "main"
      && ["index.html", "chat/index.html", "bookings/index.html", "chat.js", "widget.js"].every((f) => existsSync(`${built.folder}/${f}`)) && said.some((l) => l.includes("Smith Joinery")),
    { built, wrangled, said });
  check("fabrik chat-page saves the page's address, and AGENTS.md then gives each agent's page",
    files.get("agents.md") === `- Chat, ${site}/chat/\n- Bookings, ${site}/bookings/: Books a table.\n`, files.get("agents.md"));
  check("fabrik keeps the address beside the pages", JSON.parse(await Deno.readTextFile(`${home}/.config/fabrik/chat/abcdefghijklmnopqrst.json`)).host === "chat.joinery.example",
    await Deno.readTextFile(`${home}/.config/fabrik/chat/abcdefghijklmnopqrst.json`));
  cfCalls.length = 0;
  const rerun = await chatPage({ ref: "abcdefghijklmnopqrst", url: "https://abcdefghijklmnopqrst.supabase.co", readBrand: () => Promise.resolve(brandOf(brandRecord)), readAgents, savePage },
    { ...options, say: () => {} });
  check("a later run reuses the address without asking, deploys the Worker again, and adds nothing", rerun.site === site && workerPuts.length === 1
    && JSON.stringify(cfCalls) === JSON.stringify(["GET /zones", `GET /accounts/acc-1/pages/projects/${worker}/domains/chat.joinery.example`,
      `POST /accounts/acc-1/workers/scripts/${worker}/domains/changeset`]), cfCalls);

  // A domain whose DNS is elsewhere, a domain itself, and a domain Cloudflare doesn't finish, each on a project of its own.
  const quiet = (page: string) => { void page; return Promise.resolve(); };
  const putUpFor = (ref: string, domain: string | undefined, lines: string[] = [], ask: (q: string) => Promise<string> = options.ask) => chatPage({ ref, url: `https://${ref}.supabase.co`, readBrand: () => Promise.resolve(null), readAgents, savePage: quiet, domain },
    { ...options, ask, say: (l: string) => lines.push(l) }).then((r: { site: string }) => r.site, (err: Error) => `stopped: ${err.message}`);
  const kept = (ref: string) => existsSync(`${home}/.config/fabrik/chat/${ref}.json`);
  const cnameSaid: string[] = [];
  dnsAnswers.set("chat.outside.example", [false, true]);
  const cnameSite = await putUpFor("bcdefghijklmnopqrstu", "chat.outside.example", cnameSaid);
  check("for a domain whose DNS is elsewhere, fabrik prints the CNAME record to the pages.dev address, says once it sees it, and waits until it's active",
    cnameSite === "https://chat.outside.example"
      && cnameSaid.includes("Your domain's DNS isn't on this Cloudflare account. Add this record where you manage the DNS of outside.example: Name chat, type CNAME, target fabrik-chat-bcdefghijklmnopqrstu.pages.dev. fabrik waits for it.")
      && cnameSaid.includes("fabrik sees the CNAME record for chat.outside.example.") && cnameSaid.includes("chat.outside.example is ready.")
      && !JSON.parse(await Deno.readTextFile(`${tools}/wrangler-state.json`)).workers?.["fabrik-chat-bcdefghijklmnopqrstu"], cnameSaid);
  cfCalls.length = 0;
  const otherSaid: string[] = [];
  const otherSite = await putUpFor("bcdefghijklmnopqrstw", "chat.elsewhere.example", otherSaid);
  check("a domain whose DNS another Cloudflare account runs is refused, nothing is added or kept, and the pages are given at pages.dev",
    otherSite === "https://fabrik-chat-bcdefghijklmnopqrstw.pages.dev" && !kept("bcdefghijklmnopqrstw") && !cfCalls.some((c) => c.startsWith("POST"))
      && otherSaid.includes("elsewhere.example's DNS is on another Cloudflare account. Cloudflare keeps the chat's address only on the account that holds its domain, so a chat at chat.elsewhere.example would stop answering within minutes. Choose a domain on this account, or move elsewhere.example to this account first. Meanwhile the pages are at https://fabrik-chat-bcdefghijklmnopqrstw.pages.dev."),
    { otherSite, otherSaid, cfCalls });
  cfCalls.length = 0;
  const apex = [await putUpFor("cdefghijklmnopqrstuv", "joinery.example"), await putUpFor("cdefghijklmnopqrstuv", "outside.example")];
  check("a domain itself is refused, in Cloudflare or outside it, and nothing is added",
    apex[0] === "stopped: fabrik puts the chat on a subdomain, such as chat.joinery.example, so your website at joinery.example stays as it is."
      && apex[1] === "stopped: fabrik puts the chat on a subdomain, such as chat.outside.example, so your website at outside.example stays as it is."
      && !cfCalls.some((c) => c.startsWith("POST")), { apex, cfCalls });
  const stuckSaid: string[] = [];
  const stuck = await putUpFor("defghijklmnopqrstuvw", "help.stuck.example", stuckSaid);
  check("where Cloudflare doesn't finish within the limit, fabrik says so, gives the pages at the pages.dev address, and keeps the domain for the next run",
    stuck === "https://fabrik-chat-defghijklmnopqrstuvw.pages.dev" && kept("defghijklmnopqrstuvw")
      && stuckSaid.includes("Cloudflare hasn't finished setting up help.stuck.example after a minute. It says pending. Run chat-page again later, and it carries on from here. Meanwhile the pages are at https://fabrik-chat-defghijklmnopqrstuvw.pages.dev."), { stuck, stuckSaid });
  const keptSite = await putUpFor("efghijklmnopqrstuvwx", "pages.dev");
  check("--domain pages.dev keeps the pages.dev address", keptSite === "https://fabrik-chat-efghijklmnopqrstuvwx.pages.dev", keptSite);

  // Cloudflare refusing, failing for a moment, and putting a domain in error; an answer that is already a subdomain;
  // and a host two levels below a domain whose DNS is elsewhere.
  cfCalls.length = 0;
  const refusedSaid: string[] = [];
  const refused = await putUpFor("fghijklmnopqrstuvwxy", "chat.refused.example", refusedSaid);
  check("a domain Cloudflare refuses isn't kept, so the next run asks again, and the pages are given at pages.dev",
    refused === "https://fabrik-chat-fghijklmnopqrstuvwxy.pages.dev" && !kept("fghijklmnopqrstuvwxy")
      && refusedSaid.some((l) => l.startsWith("Cloudflare didn't add chat.refused.example to your chat pages: The domain is not allowed.")), { refused, refusedSaid });
  customDomains.set("chat.flaky.example", { project: chatProject("ghijklmnopqrstuvwxyz"), asked: 0 });
  cfCalls.length = 0;
  const flakySaid: string[] = [];
  const flaky = await putUpFor("ghijklmnopqrstuvwxyz", "chat.flaky.example", flakySaid);
  check("a failed GET of a domain Cloudflare already holds adds nothing, and the pages are given at pages.dev",
    flaky === "https://fabrik-chat-ghijklmnopqrstuvwxyz.pages.dev" && !cfCalls.some((c) => c.startsWith("POST"))
      && flakySaid.some((l) => l.startsWith("Cloudflare didn't say whether chat.flaky.example is on your chat pages: Service unavailable.")), { flaky, flakySaid, cfCalls });
  cfCalls.length = 0;
  const brokenSaid: string[] = [];
  const brokenSite = await putUpFor("hijklmnopqrstuvwxyza", "chat.broken.example", brokenSaid);
  check("a domain in error is checked again once on Cloudflare, and then turns active",
    brokenSite === "https://chat.broken.example" && cfCalls.includes("PATCH /accounts/acc-1/pages/projects/fabrik-chat-hijklmnopqrstuvwxyza/domains/chat.broken.example")
      && brokenSaid.includes("Cloudflare says chat.broken.example has an error: CNAME record not set. fabrik asks it to check again."), { brokenSite, brokenSaid, cfCalls });
  const typedAsked: string[] = [];
  const typed = await putUpFor("ijklmnopqrstuvwxyzab", undefined, [], (q: string) => { typedAsked.push(q); return Promise.resolve("chat.smithjoinery.example"); });
  check("an answer that is already a subdomain is the address, and no subdomain is asked for",
    typed === "https://chat.smithjoinery.example" && typedAsked.length === 1, { typed, typedAsked });
  const deepSaid: string[] = [];
  await putUpFor("jklmnopqrstuvwxyzabc", "help.chat.outside.example", deepSaid);
  check("for a host two levels below a domain whose DNS is elsewhere, the record names both levels in the domain's DNS",
    deepSaid.some((l) => l.includes("where you manage the DNS of outside.example: Name help.chat, type CNAME")), deepSaid);

  // An address fabrik put on the Pages project before, a DNS record in the way, and an address another Worker has.
  customDomains.set("help.smithjoinery.example", { project: chatProject("klmnopqrstuvwxyzabcd"), asked: 0 });
  cfCalls.length = 0;
  const movedSaid: string[] = [];
  const movedSite = await putUpFor("klmnopqrstuvwxyzabcd", "help.smithjoinery.example", movedSaid);
  check("an address on a domain Cloudflare runs that fabrik put on the Pages project before is taken off it, and the Worker has it",
    movedSite === "https://help.smithjoinery.example" && !customDomains.has("help.smithjoinery.example")
      && cfCalls.includes("DELETE /accounts/acc-1/pages/projects/fabrik-chat-klmnopqrstuvwxyzabcd/domains/help.smithjoinery.example")
      && movedSaid.includes("Took help.smithjoinery.example off your chat pages on Pages, so the chat pages' Worker can have it."), { movedSite, movedSaid, cfCalls });
  dnsRecords.add("help.joinery.example");
  cfCalls.length = 0;
  const recordSaid: string[] = [], recordAsked: string[] = [];
  const recordSite = await putUpFor("lmnopqrstuvwxyzabcde", "help.joinery.example", recordSaid, (q: string) => {
    recordAsked.push(q);
    dnsRecords.delete("help.joinery.example");
    return Promise.resolve("");
  });
  const deleteAsk = "help.joinery.example already has a DNS record, so Cloudflare can't make the one the chat needs. Delete the record named help on Cloudflare's DNS page for joinery.example, https://dash.cloudflare.com/acc-1/joinery.example/dns/records.";
  check("an address with a DNS record names the record and asks the owner to delete it, and once it's gone the Worker has the address",
    recordSite === "https://help.joinery.example" && recordSaid.includes(deleteAsk)
      && JSON.stringify(recordAsked) === JSON.stringify(["Press Return once the record named help is deleted: "])
      && cfCalls.filter((c) => c.endsWith("/domains/changeset")).length === 2 && !cfCalls.some((c) => c.startsWith("DELETE"))
      && workerPuts.at(-1).origins[0].hostname === "help.joinery.example" && workerPuts.at(-1).override_existing_dns_record === false, { recordSite, recordSaid, recordAsked, cfCalls });
  dnsRecords.add("ask.joinery.example");
  const putsBefore = workerPuts.length;
  const leftSaid: string[] = [];
  const left = await putUpFor("mnopqrstuvwxyzabcdef", "ask.joinery.example", leftSaid);
  check("with no terminal to answer on, the record stays, the address isn't added, the pages are given at pages.dev, and the next run tries the address again",
    left === "https://fabrik-chat-mnopqrstuvwxyzabcdef.pages.dev" && dnsRecords.has("ask.joinery.example") && workerPuts.length === putsBefore && kept("mnopqrstuvwxyzabcdef")
      && leftSaid.includes(deleteAsk.replaceAll("help", "ask"))
      && leftSaid.includes("ask.joinery.example still has its DNS record. Once it's deleted, run chat-page again. Meanwhile the pages are at https://fabrik-chat-mnopqrstuvwxyzabcdef.pages.dev."), { left, leftSaid });
  // An address on Pages, with a record the changeset misses: the Worker can't take it, so it goes back on Pages.
  customDomains.set("hold.joinery.example", { project: chatProject("pqrstuvwxyzabcdefghi"), asked: 0 });
  hiddenRecords.add("hold.joinery.example");
  cfCalls.length = 0;
  const heldSaid: string[] = [];
  const heldSite = await putUpFor("pqrstuvwxyzabcdefghi", "hold.joinery.example", heldSaid);
  check("an address the Worker can't take, after Pages let it go, goes back on Pages, stays the chat's address, and names the record",
    heldSite === "https://hold.joinery.example" && customDomains.get("hold.joinery.example")?.project === chatProject("pqrstuvwxyzabcdefghi") && kept("pqrstuvwxyzabcdefghi")
      && cfCalls.includes("DELETE /accounts/acc-1/pages/projects/fabrik-chat-pqrstuvwxyzabcdefghi/domains/hold.joinery.example")
      && cfCalls.filter((c) => c === "POST /accounts/acc-1/pages/projects/fabrik-chat-pqrstuvwxyzabcdefghi/domains").length === 1
      && heldSaid.some((l) => l.startsWith("hold.joinery.example already has a DNS record") && l.endsWith("fabrik put hold.joinery.example back on your chat pages on Pages, so the chat stays up there.")), { heldSite, heldSaid, cfCalls });
  const takenSaid: string[] = [];
  const taken = await putUpFor("nopqrstuvwxyzabcdefg", "chat.smithjoinery.example", takenSaid);
  check("an address another Worker has isn't taken from it, and isn't kept",
    taken === "https://fabrik-chat-nopqrstuvwxyzabcdefg.pages.dev" && !kept("nopqrstuvwxyzabcdefg") && workerDomains.get("chat.smithjoinery.example")?.service === "fabrik-chat-ijklmnopqrstuvwxyzab"
      && takenSaid.some((l) => l.startsWith("chat.smithjoinery.example is already the address of the Worker fabrik-chat-ijklmnopqrstuvwxyzab on Cloudflare.")), { taken, takenSaid });
  const { dnsAnswers: chatDns } = await import(new URL("../../plugins/fabrik/cli/chat-domain.mjs", import.meta.url).href);
  const wildcard = { resolveCname: () => Promise.reject(new Error("ENODATA")), resolve4: () => Promise.resolve(["192.0.2.1"]) };
  check("an address record alone counts as the chat's DNS only where Cloudflare runs the DNS, never as the CNAME record",
    await chatDns("chat.outside.example", "x.pages.dev", false, wildcard) === false && await chatDns("chat.joinery.example", "x.pages.dev", true, wildcard) === true, null);

  const pageBefore = rootHtml;
  const deployedBefore = await Deno.readTextFile(`${tools}/wrangler-state.json`);
  const stopped = await chatPage({ ref: "abcdefghijklmnopqrst", url: "https://abcdefghijklmnopqrst.supabase.co", readBrand: () => Promise.reject(new Error("fabrik didn't answer in time.")), readAgents, savePage },
    { ...options, say: () => {} }).then(() => null, (err: Error) => err.message);
  const noAgents = await chatPage({ ref: "abcdefghijklmnopqrst", url: "https://abcdefghijklmnopqrst.supabase.co", readBrand: () => Promise.resolve(null), readAgents: () => Promise.resolve([]), savePage },
    { ...options, say: () => {} }).then(() => null, (err: Error) => err.message);
  check("where the Brand record can't be read, or there's no agent, fabrik chat-page stops and the pages put up before stay as they were",
    /couldn't read the Brand record/.test(String(stopped)) && /no public agent yet/.test(String(noAgents)) && await Deno.readTextFile(`${tools}/wrangler-state.json`) === deployedBefore
      && await Deno.readTextFile(`${built.folder}/index.html`) === pageBefore, { stopped, noAgents });
  const logo = brandRecord.payload.graph.nodes[0].attributes.logo.data_address;
  check("an agent's page takes the Brand record's colours in light and dark, its fonts and its logo, with the agent's name, and names the function's address, the agent, the business and its logo as the answers' mark",
    bookingsHtml.includes("--accent: light-dark(#3fa66b, #5cc78a)") && bookingsHtml.includes("--paper: light-dark(#fbfaf6, #121a15)")
      && bookingsHtml.includes("--ink: light-dark(#1d2a22, #eef2ee)") && bookingsHtml.includes('"Fraunces"') && bookingsHtml.includes(`src="${logo}"`)
      && bookingsHtml.includes("<title>Bookings | Smith Joinery</title>") && bookingsHtml.includes("<h1>Bookings</h1>")
      && bookingsHtml.includes(`<script src="../chat.js" data-address="https://abcdefghijklmnopqrst.supabase.co/functions/v1/public-agent" data-agent="bookings" data-business="Smith Joinery" data-greeting="Hello &amp; welcome to &quot;Bookings&quot;.\nAsk me <anything> about tables." data-mark="${logo}"></script>`)
      && !bookingsHtml.includes("{{") && !bookingsHtml.includes("data-sitekey"),
    bookingsHtml.slice(0, 1500));
  const chatHtml = await Deno.readTextFile(`${built.folder}/chat/index.html`);
  check("an agent with no greeting has no data-greeting on its page", chatHtml.includes('data-agent="chat"') && !chatHtml.includes("data-greeting"),
    chatHtml.match(/<script src="..\/chat.js"[^>]*>/)?.[0]);
  const navOf = (html: string) => html.match(/<nav[^]*?<\/nav>/)?.[0];
  check("the root page, in the brand, lists the main agent first, the one with no topic, then the agents by name and purpose under their topic, each linked to its page, with a link closing the list back to the main agent",
    rootHtml.includes("<title>Smith Joinery</title>") && rootHtml.includes('<main><div class="topics"><ul class="agents main"><li><a href="chat/"><strong>Chat</strong></a></li></ul>' +
      '<section><h2>Visits</h2><ul class="agents"><li><a href="bookings/"><strong>Bookings</strong><span>Books a table.</span></a></li></ul></section></div></main>')
      && rootHtml.includes('<a class="close" href="chat/" aria-label="Close the list of agents">') && !rootHtml.includes("<script src") && !rootHtml.includes("{{"),
    rootHtml.slice(rootHtml.indexOf("<main>"), rootHtml.indexOf("<main>") + 600));
  check("an agent's page links home to the main agent, except the main agent's own, to the list of agents and to the other agents of its own topic alone, and the list's own page has no such links",
    navOf(bookingsHtml) === '<nav id="agent-nav" aria-label="Visits: other agents"><a href="../chat/">Home</a><a href="../?from=bookings">All agents</a></nav>'
      && navOf(chatHtml) === '<nav id="agent-nav" aria-label="Other agents"><a href="../?from=chat">All agents</a></nav>' && !rootHtml.includes("<nav"),
    { bookings: navOf(bookingsHtml), chat: navOf(chatHtml) });
  check("the logo links to the main agent's page on the list and on another agent's page, and nowhere on the main agent's own page",
    rootHtml.includes('<header><a class="home" href="chat/" aria-label="Smith Joinery: home"><img') && bookingsHtml.includes('<header><a class="home" href="../chat/" aria-label="Smith Joinery: home"><img')
      && chatHtml.includes("<header><img") && !chatHtml.includes('class="home"'),
    { root: rootHtml.match(/<header>.{0,80}/)?.[0], bookings: bookingsHtml.match(/<header>.{0,80}/)?.[0], chat: chatHtml.match(/<header>.{0,80}/)?.[0] });
  check("widget.js carries the brand's accent and a readable colour on it", widgetJs.includes('"data-accent": "#3fa66b"') && /"data-on-accent": "#(111111|ffffff)"/.test(widgetJs) && !widgetJs.includes("{{"),
    widgetJs.slice(0, 1200));

  // widget.js on a page of another website, naming the agent Bookings: its button opens Bookings' page in a panel, and
  // closes it again.
  const other = new Window({ url: "https://joinery-shop.example/", settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableIframePageLoading: true } });
  const odoc = other.document;
  const wtag = odoc.createElement("script");
  wtag.setAttribute("src", `${site}/widget.js`);
  wtag.setAttribute("data-agent", "bookings");
  odoc.body.appendChild(wtag);
  Object.defineProperty(odoc, "currentScript", { get: () => wtag, configurable: true });
  new Function("window", "document", "URL", widgetJs)(other, odoc, URL);
  const launcher = odoc.querySelector(".fabrik-chat-button") as any;
  const closedFirst = { button: !!launcher, frame: odoc.querySelector("iframe"), colour: launcher?.style.background };
  launcher.click();
  const frame = odoc.querySelector(".fabrik-chat-box iframe.fabrik-chat-panel") as any;
  const box = odoc.querySelector(".fabrik-chat-box") as any;
  const panelOpened = { src: frame?.getAttribute("src"), hidden: box?.hidden, expanded: launcher.getAttribute("aria-expanded"), title: frame?.title };
  launcher.click();
  const closed = { hidden: box?.hidden, expanded: launcher.getAttribute("aria-expanded"), frames: odoc.querySelectorAll("iframe").length };
  check("on another website the button, in the brand's accent, opens the page of the agent data-agent names in an iframe panel, and closes it again",
    closedFirst.button && closedFirst.frame === null && /63, 166, 107|#3fa66b/i.test(String(closedFirst.colour)) && panelOpened.src === `${site}/bookings/` && panelOpened.hidden === false
      && panelOpened.expanded === "true" && closed.hidden === true && closed.expanded === "false" && closed.frames === 1, { closedFirst, panelOpened, closed });

  // The bar along the panel's top edge: its first button fills the window and puts the panel back, Escape puts a full
  // panel back before it closes anything, and its second button closes the panel and brings the launcher back. A dragged
  // size needs layout, which happy-dom has none of, so the drag was run in a browser instead.
  launcher.click();
  const expandButton = odoc.querySelector(".fabrik-chat-expand") as any;
  const isFull = () => box.classList.contains("fabrik-full");
  expandButton.click();
  const filled = { full: isFull(), launcherHidden: launcher.classList.contains("fabrik-hidden"), label: expandButton.getAttribute("aria-label") };
  other.document.dispatchEvent(new other.KeyboardEvent("keydown", { key: "Escape" }));
  const escaped = { full: isFull(), open: box.hidden === false, launcherHidden: launcher.classList.contains("fabrik-hidden") };
  expandButton.click();
  (odoc.querySelector(".fabrik-chat-close") as any).click();
  const barClosed = { hidden: box.hidden, launcherHidden: launcher.classList.contains("fabrik-hidden"), expanded: launcher.getAttribute("aria-expanded") };
  check("the panel's bar makes it fill the window and puts it back, Escape puts a full panel back before it closes, and the bar's close button closes it and shows the launcher",
    filled.full && filled.launcherHidden && filled.label === "Make the chat smaller" && !escaped.full && escaped.open && !escaped.launcherHidden
      && barClosed.hidden === true && !barClosed.launcherHidden && barClosed.expanded === "false", { filled, escaped, barClosed });
  await other.happyDOM.close();

  // A website's own data-accent: the icon takes the colour that reads on it.
  const light = new Window({ url: "https://joinery-shop.example/", settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableIframePageLoading: true } });
  const ltag = light.document.createElement("script");
  ltag.setAttribute("src", `${site}/widget.js`);
  ltag.setAttribute("data-accent", "#ffe14d");
  light.document.body.appendChild(ltag);
  Object.defineProperty(light.document, "currentScript", { get: () => ltag, configurable: true });
  new Function("window", "document", "URL", widgetJs)(light, light.document, URL);
  const lightButton = light.document.querySelector(".fabrik-chat-button") as any;
  const iconColour = String(lightButton?.style.color);
  check("with a pale data-accent, the button's icon is near black", /#111111|17, 17, 17/.test(iconColour), iconColour);
  lightButton.click();
  const oldLine = light.document.querySelector(".fabrik-chat-box iframe.fabrik-chat-panel")?.getAttribute("src");
  check("a widget line with no data-agent, as one from before there were many agents, opens the agent chat", oldLine === `${site}/chat/`, oldLine);
  await light.happyDOM.close();

  // Bookings' page, which the panel opens at its own address: chat.js asks for the site key with a GET, draws the
  // Turnstile check with it, and a question gets Bookings' answer.
  const chat = new Window({ url: panelOpened.src ?? `${site}/bookings/`, settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
  const cdoc = chat.document;
  cdoc.write(bookingsHtml);
  const ctag = cdoc.querySelector('script[src="../chat.js"]')!;
  Object.defineProperty(cdoc, "currentScript", { get: () => ctag, configurable: true });
  const rendered: string[] = [];
  (chat as any).turnstile = { render: (_: unknown, o: { sitekey: string }) => { rendered.push(o.sitekey); return 0; }, getResponse: () => GOOD_TOKEN, reset() {} };
  const methods: string[] = [], chatBodies: any[] = [];
  const chatFetch = (url: string, init: RequestInit) => {
    methods.push(String(init.method));
    if (init.body) chatBodies.push(JSON.parse(String(init.body)));
    return handler!(new Request(url, init));
  };
  new Function("window", "document", "fetch", await Deno.readTextFile(`${built.folder}/chat.js`))(chat, cdoc, chatFetch);
  // Bookings' greeting is its first answer, drawn at once with the mark's bubble and its line break, before anything is posted.
  const textOf = (li: any) => [...(li?.childNodes ?? [])].filter((n: any) => n.nodeName !== "TIME").map((n: any) => n.textContent).join("");
  const greeted = [...cdoc.querySelectorAll("#fabrik-chat li")].map((li: any) => [li.className, textOf(li)]);
  check("a new conversation on an agent's page opens with its greeting as the agent's first answer, line breaks kept, without posting anything",
    JSON.stringify(greeted) === JSON.stringify([["a", GREETING]]) && !methods.includes("POST"), { greeted, methods });
  while (!cdoc.querySelector('script[src*="challenges.cloudflare.com"]')) await new Promise((r) => setTimeout(r, 5));
  (chat as any).fabrikChatTurnstile();
  (cdoc.querySelector("#fabrik-chat input") as any).value = "How do I book tables?";
  cdoc.querySelector("#fabrik-chat form")!.dispatchEvent(new chat.Event("submit", { cancelable: true }));
  const thinking = cdoc.querySelector("#fabrik-chat li.thinking") as any;
  const thought = Boolean(thinking) && thinking.className === "thinking";
  while (cdoc.querySelectorAll("#fabrik-chat li.a:not(.writing)").length < 2) await new Promise((r) => setTimeout(r, 5));
  const greetedExchanges = await sql`select question, answer from fabrik_private.public_exchange where conversation = ${chatBodies[0].conversation}::uuid`;
  check("the greeting is never posted: the first question goes with no history, and the conversation keeps that one exchange alone",
    chatBodies.length === 1 && chatBodies[0].history.length === 0 && greetedExchanges.length === 1 && greetedExchanges[0].question === "How do I book tables?"
      && !JSON.stringify(greetedExchanges).includes("welcome"), { chatBodies, greetedExchanges });
  // The tab's conversation, drawn again on the same page, holds the greeting once, before the question and its answer.
  const tabKept = Object.fromEntries(Object.keys(chat.sessionStorage).map((k) => [k, chat.sessionStorage.getItem(k)]));
  const redrawPage = new Window({ url: `${site}/bookings/`, settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
  for (const [k, v] of Object.entries(tabKept)) redrawPage.sessionStorage.setItem(k, String(v));
  redrawPage.document.write(bookingsHtml);
  const atag = redrawPage.document.querySelector('script[src="../chat.js"]')!;
  Object.defineProperty(redrawPage.document, "currentScript", { get: () => atag, configurable: true });
  new Function("window", "document", "fetch", await Deno.readTextFile(`${built.folder}/chat.js`))(redrawPage, redrawPage.document,
    () => Promise.resolve(Response.json({ sitekey: SITEKEY })));
  const redrawn = [...redrawPage.document.querySelectorAll("#fabrik-chat li")].map((li: any) => [li.className, textOf(li)]);
  check("a conversation the tab kept is drawn again with its greeting once, and no greeting is added over it",
    JSON.stringify(redrawn) === JSON.stringify([["a", GREETING], ["q", "How do I book tables?"], ["a", "Tables: book by phone on 01234 567890."]]), redrawn);
  await redrawPage.happyDOM.close();
  const answered = { kept: cdoc.querySelector("#fabrik-chat p.kept")?.textContent, methods, rendered, thought, left: cdoc.querySelectorAll("#fabrik-chat li.thinking").length, answer: textOf([...cdoc.querySelectorAll("#fabrik-chat li.a")].at(-1)), time: [...cdoc.querySelectorAll("#fabrik-chat li.a time")].at(-1)?.getAttribute("datetime") ?? "", kind: [...cdoc.querySelectorAll("#fabrik-chat li.a")].at(-1)?.className, knowledge: sent.at(-1).system.at(-1).text };
  check("an agent's page says under the box that the business keeps the conversation, gets the site key with a GET, draws the Turnstile check with it, shows dots with no bubble while it waits, and a question gets that agent's answer with its time",
    answered.kept === "Smith Joinery keeps this conversation to improve its answers." && answered.thought && answered.left === 0 && JSON.stringify(methods) === JSON.stringify(["GET", "POST"]) && JSON.stringify(rendered) === JSON.stringify([SITEKEY])
      && answered.answer === "Tables: book by phone on 01234 567890." && !Number.isNaN(Date.parse(answered.time)) && answered.kind === "a" && answered.knowledge.includes(BOOKINGS), answered);
  await chat.happyDOM.close();

  // Before the site key is saved, the chat page says what is missing.
  const early = new Window({ url: `${site}/bookings/`, settings: { disableJavaScriptFileLoading: true, disableJavaScriptEvaluation: true, disableCSSFileLoading: true } });
  early.document.write(bookingsHtml);
  const etag = early.document.querySelector('script[src="../chat.js"]')!;
  Object.defineProperty(early.document, "currentScript", { get: () => etag, configurable: true });
  const noKey = () => Promise.resolve(Response.json({ ok: false, problem: UNAVAILABLE, setup: "sitekey" }, { status: 503 }));
  new Function("window", "document", "fetch", await Deno.readTextFile(`${built.folder}/chat.js`))(early, early.document, noKey);
  while (!early.document.querySelector("#fabrik-chat li.problem")) await new Promise((r) => setTimeout(r, 5));
  const earlyLine = early.document.querySelector("#fabrik-chat li.problem")?.textContent;
  check("before the site key is saved, the chat page says fabrik has no Turnstile site key", /no Turnstile site key/.test(String(earlyLine)), earlyLine);
  await early.happyDOM.close();
  await Deno.remove(home, { recursive: true });

  // The conversations the owner keeps. Two questions in one conversation and one in another, from a visitor at a known
  // address. A failed Turnstile check, a bad conversation id and a request with none.
  const since = new Date().toISOString();
  const [one, two] = [crypto.randomUUID(), crypto.randomUUID()];
  const IP = "203.0.113.77";
  const fromVisitor = async (body: Record<string, unknown>) => {
    const r = await handler!(new Request("http://function/", { method: "POST", body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": IP, "User-Agent": "StandInBrowser/1.0" } }));
    return { status: r.status, body: await r.json() };
  };
  const exchangesBefore = (await sql`select count(*)::int as n from fabrik_private.public_exchange`)[0].n;
  const refusedVisitor = await fromVisitor({ conversation: one, question: "Refused question?", turnstile_token: "forged" });
  const badId = await fromVisitor({ conversation: "not-a-uuid", question: "Hours?", turnstile_token: GOOD_TOKEN });
  check("a failed Turnstile check and a conversation that isn't a UUID are refused, and nothing is kept",
    refusedVisitor.status === 403 && badId.status === 400
      && (await sql`select count(*)::int as n from fabrik_private.public_exchange`)[0].n === exchangesBefore, { refusedVisitor, badId });
  await fromVisitor({ conversation: one, question: "What are your opening hours?", turnstile_token: GOOD_TOKEN });
  await fromVisitor({ conversation: one, question: "Do you make cakes to order?", turnstile_token: GOOD_TOKEN,
    history: [{ role: "user", content: "What are your opening hours?" }, { role: "assistant", content: "Opening hours: 8am to 4pm, Tuesday to Saturday." }] });
  await fromVisitor({ conversation: two, question: "Do you sell wholesale?", turnstile_token: GOOD_TOKEN });
  const listed = await post({ action: "conversations_list", agent: "chat", since }, admin);
  const whole = await post({ action: "conversation_get", id: one }, admin);
  check("conversations_list gives the two conversations newest first, each with its first question, its number of questions and its times",
    listed.status === 200 && JSON.stringify(listed.body.conversations?.map((c: any) => [c.id, c.agent, c.questions, c.first_question])) === JSON.stringify([
      [two, "chat", 1, "Do you sell wholesale?"], [one, "chat", 2, "What are your opening hours?"]])
      && listed.body.conversations[1].first_at <= listed.body.conversations[1].last_at, listed.body);
  check("conversation_get gives the first conversation's questions and answers in order, with each answer's tokens",
    whole.status === 200 && whole.body.agent === "chat" && JSON.stringify(whole.body.exchanges?.map((e: any) => [e.question, e.answer, e.input_tokens, e.output_tokens])) === JSON.stringify([
      ["What are your opening hours?", "Opening hours: 8am to 4pm, Tuesday to Saturday.", 6400, 30],
      ["Do you make cakes to order?", "Services: bread, cakes to order, and wholesale for cafes.", 6400, 30]]), whole.body);
  const crossed = await fromVisitor({ agent: "bookings", conversation: one, question: "Can I book a cake tasting?", turnstile_token: GOOD_TOKEN });
  const [crossedKept] = await sql`select conversation::text as c, slug from fabrik_private.public_exchange where question = 'Can I book a cake tasting?'`;
  const stillOne = await post({ action: "conversation_get", id: one }, admin);
  check("a conversation id another agent holds is kept under a new id of the asking agent's, and the first conversation stays one agent's",
    crossed.status === 200 && crossedKept?.slug === "bookings" && crossedKept.c !== one
      && stillOne.body.exchanges?.length === 2 && stillOne.body.agent === "chat", { crossed, crossedKept, stillOne: stillOne.body });
  const looseDates = await Promise.all(["11/01", "2026", "2026-02-30", "1"].map((before) => post({ action: "conversations_delete", agent: "chat", before }, admin)));
  check("conversations_delete refuses a before that isn't a calendar date or an ISO time, and deletes nothing",
    looseDates.every((r) => r.status === 400) && (await post({ action: "conversation_get", id: one }, admin)).body.exchanges?.length === 2,
    looseDates.map((r) => [r.status, r.body.problem]));
  const noId = await fromVisitor({ question: "Opening hours?", turnstile_token: GOOD_TOKEN });
  const noIdToo = await fromVisitor({ question: "Opening hours again?", turnstile_token: GOOD_TOKEN });
  const unnamed = await sql`select distinct conversation::text as c from fabrik_private.public_exchange where question in ('Opening hours?', 'Opening hours again?')`;
  check("a question with no conversation, from a page built before there was one, is kept under a new id of its own",
    noId.status === 200 && noIdToo.status === 200 && unnamed.length === 2 && unnamed.every((r) => r.c !== one && r.c !== two), unnamed);
  const tokensBeforeNul = (await post({ action: "settings", agent: "chat" }, admin)).body.today_tokens;
  const nul = await fromVisitor({ conversation: two, question: "Do you sell\u0000 bread?", turnstile_token: GOOD_TOKEN });
  const tokensAfterNul = (await post({ action: "settings", agent: "chat" }, admin)).body.today_tokens;
  const [nulKept] = await sql`select question from fabrik_private.public_exchange where conversation = ${two}::uuid order by id desc limit 1`;
  check("a question holding a NUL character gets its answer, is kept without it, and costs the agent its 1,030 tokens, not what was held",
    nul.status === 200 && nulKept?.question === "Do you sell bread?" && tokensAfterNul - tokensBeforeNul === 1030, { nul, nulKept, tokensBeforeNul, tokensAfterNul });
  const identifying: string[] = [];

  // A pass: the answer to a checked question brings its conversation's pass, and the next question of that conversation
  // brings it in place of a token, so siteverify isn't asked again. Another conversation's pass, a forged one and one out
  // of date are refused with check true, and Claude isn't called.
  const three = crypto.randomUUID();
  const passed = await fromVisitor({ conversation: three, question: "What are your opening hours?", turnstile_token: GOOD_TOKEN });
  const [checksBefore, claudeBefore] = [verified.length, sent.length];
  const withPass = await fromVisitor({ conversation: three, question: "Do you make cakes to order?", pass: passed.body.pass });
  check("an answer brings the conversation's pass, and its next question with the pass and no token is answered without asking siteverify",
    passed.status === 200 && /^[0-9]{13}\.[0-9a-f]{64}$/.test(passed.body.pass ?? "") && withPass.status === 200
      && withPass.body.answer === "Services: bread, cakes to order, and wholesale for cafes." && withPass.body.pass === passed.body.pass
      && verified.length === checksBefore, { passed, withPass, asked: verified.length - checksBefore });
  const forgedPass = passed.body.pass.slice(0, -1) + (passed.body.pass.endsWith("0") ? "1" : "0");
  const passesRefused = await Promise.all([
    fromVisitor({ conversation: one, question: "Opening hours?", pass: passed.body.pass }),
    fromVisitor({ conversation: three, question: "Opening hours?", pass: forgedPass }),
    fromVisitor({ conversation: three, question: "Opening hours?", pass: await passFor(SECRET, "chat", three, Date.now() - PASS_MS - 1000) }),
    fromVisitor({ conversation: three, question: "Opening hours?", pass: await passFor("another-secret", "chat", three) }),
    fromVisitor({ conversation: three, question: "Opening hours?", pass: await passFor(SECRET, "bookings", three) }),
  ]);
  check("another conversation's pass, a forged pass, one out of date, one signed with another secret and another agent's get 403 with check true, and Claude isn't called",
    passesRefused.every((r) => r.status === 403 && r.body.check === true && r.body.problem === NOT_CHECKED) && sent.length === claudeBefore + 1,
    passesRefused);

  // A streamed answer: the streamPieces as Claude writes them, then the answer as kept with the pass. A refusal stays JSON.
  const streamOf = async (body: Record<string, unknown>) => {
    const r = await handler!(new Request("http://function/", { method: "POST", body: JSON.stringify({ ...body, stream: true }),
      headers: { "Content-Type": "application/json" } }));
    const text = await r.text();
    const events = r.headers.get("Content-Type")?.startsWith("text/event-stream")
      ? text.split("\n\n").filter((e) => e.startsWith("data: ")).map((e) => JSON.parse(e.slice(6))) : null;
    return { status: r.status, events, json: events ? null : JSON.parse(text) };
  };
  const tokensBeforeStream = (await post({ action: "settings", agent: "chat" }, admin)).body.today_tokens;
  const streamedBefore = streamedReplies;
  const flowed = await streamOf({ conversation: three, question: "Do you sell wholesale?", pass: passed.body.pass });
  const streamPieces = (flowed.events ?? []).filter((e) => e.type === "text").map((e) => e.text);
  const lastEvent = flowed.events?.at(-1);
  const tokensAfterStream = (await post({ action: "settings", agent: "chat" }, admin)).body.today_tokens;
  const [streamedKept] = await sql`select answer, input_tokens, output_tokens from fabrik_private.public_exchange where conversation = ${three}::uuid and question = 'Do you sell wholesale?'`;
  check("a streamed answer comes in pieces, ends with the answer as kept and the pass, is kept with its tokens and costs its 1,030 tokens",
    flowed.status === 200 && streamedReplies === streamedBefore + 1 && streamPieces.length > 1
      && streamPieces.join("") === "Services: bread, cakes to order, and wholesale for cafes." && lastEvent?.type === "done" && lastEvent.answer === streamPieces.join("")
      && lastEvent.pass === passed.body.pass && streamedKept?.answer === lastEvent.answer && streamedKept.input_tokens === 6400 && streamedKept.output_tokens === 30
      && tokensAfterStream - tokensBeforeStream === 1030, { flowed, streamedKept, tokensBeforeStream, tokensAfterStream });
  const cutStreamed = await streamOf({ conversation: three, question: "Give me the cut answer", pass: passed.body.pass });
  check("a streamed answer cut at the output cap ends with the answer up to its last full sentence",
    cutStreamed.events?.filter((e) => e.type === "text").map((e) => e.text).join("") === CUT
      && cutStreamed.events?.at(-1)?.answer === wholeSentences(CUT), cutStreamed.events?.at(-1));
  const streamRefused = await streamOf({ conversation: three, question: "Opening hours?", turnstile_token: "forged" });
  check("a streamed question that fails the check gets JSON 403 with check true",
    streamRefused.status === 403 && streamRefused.json?.check === true, streamRefused);
  // A pass answers at most PASS_QUESTIONS questions, counted in its own row, so questions sent side by side can't pass
  // the limit together, and one whose conversation another agent holds is counted all the same.
  const [, passSig] = passed.body.pass.split(".");
  const usedSoFar = (await sql`select questions from fabrik_private.public_agent_pass where signature = ${passSig}`)[0]?.questions;
  await sql`update fabrik_private.public_agent_pass set questions = ${PASS_QUESTIONS - 3} where signature = ${passSig}`;
  const claudeBeforeBurst = sent.length;
  const burst = await Promise.all(Array.from({ length: 6 }, () => fromVisitor({ conversation: three, question: "Opening hours?", pass: passed.body.pass })));
  const checkedAgain = await fromVisitor({ conversation: three, question: "Opening hours?", turnstile_token: GOOD_TOKEN });
  const [, newSig] = (checkedAgain.body.pass ?? ".").split(".");
  const newRow = (await sql`select questions from fabrik_private.public_agent_pass where signature = ${newSig}`)[0]?.questions;
  check(`a pass answers ${PASS_QUESTIONS} questions in all: of 6 sent side by side with 3 left, 3 are answered and 3 get 403 with check true, and a new check brings a new pass with its question taken`,
    usedSoFar === 4 && burst.filter((r) => r.status === 200).length === 3 && burst.filter((r) => r.status === 403 && r.body.check === true).length === 3
      && sent.length === claudeBeforeBurst + 4 && checkedAgain.status === 200 && checkedAgain.body.pass !== passed.body.pass && newRow === 1,
    { usedSoFar, burst: burst.map((r) => r.status), calls: sent.length - claudeBeforeBurst, checkedAgain, newRow });
  const heldElsewhere = crypto.randomUUID();
  await fromVisitor({ agent: "bookings", conversation: heldElsewhere, question: "Can I book a table?", turnstile_token: GOOD_TOKEN });
  const crossedPass = (await fromVisitor({ conversation: heldElsewhere, question: "Opening hours?", turnstile_token: GOOD_TOKEN })).body.pass;
  await fromVisitor({ conversation: heldElsewhere, question: "Opening hours?", pass: crossedPass });
  const crossedRow = (await sql`select questions from fabrik_private.public_agent_pass where signature = ${crossedPass.split(".")[1]}`)[0]?.questions;
  check("a pass for a conversation another agent holds counts its questions all the same",
    crossedRow === 2, { crossedPass, crossedRow });
  for (const { t } of tables) {
    const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${t} r where r::text like any($1)`, [[`%${IP}%`, `%${GOOD_TOKEN}%`, "%StandInBrowser%"]]);
    if (n) identifying.push(t);
  }
  check("no row in any table holds the visitor's IP address, Turnstile token or browser", identifying.length === 0, identifying);
  const badDelete = await post({ action: "conversations_delete", id: one, agent: "chat" }, admin);
  const deleted = await post({ action: "conversations_delete", id: two }, admin);
  const remaining = await post({ action: "conversations_list", agent: "chat", since }, admin);
  const gone = await post({ action: "conversation_get", id: two }, admin);
  check("conversations_delete refuses an id with an agent, deletes the one conversation given, and the other stays whole",
    badDelete.status === 400 && deleted.status === 200 && deleted.body.conversations === 1 && deleted.body.exchanges === 2 && gone.status === 404
      && JSON.stringify(remaining.body.conversations?.map((c: any) => c.id).filter((c: string) => c === one || c === two)) === JSON.stringify([one])
      && (await post({ action: "conversation_get", id: one }, admin)).body.exchanges?.length === 2, { badDelete, deleted, remaining: remaining.body, gone });
  const bookingsBefore = (await post({ action: "conversations_list", agent: "bookings" }, admin)).body.conversations.length;
  const byAgent = await post({ action: "conversations_delete", agent: "chat", before: new Date(Date.now() + 60_000).toISOString() }, admin);
  const chatLeft = (await post({ action: "conversations_list", agent: "chat" }, admin)).body.conversations.length;
  const bookingsLeft = (await post({ action: "conversations_list", agent: "bookings" }, admin)).body.conversations.length;
  check("conversations_delete with an agent and a date deletes every conversation of that agent last asked before it, and leaves the other agents'",
    byAgent.status === 200 && byAgent.body.conversations > 2 && chatLeft === 0 && bookingsBefore > 0 && bookingsLeft === bookingsBefore, { byAgent: byAgent.body, chatLeft, bookingsBefore, bookingsLeft });

  // A reply that stops at the output cap reaches the visitor, and is kept, up to its last full sentence.
  const cut = await ask("Give me the cut answer.");
  const [cutKept] = await sql`select answer from fabrik_private.public_exchange where question = 'Give me the cut answer.'`;
  const cutWhole = "We open at 8am. The café closes at 4pm, \"or later in summer!\"";
  check("a reply that stops at the output cap ends at its last full sentence, for the visitor and in the kept exchange",
    cut.status === 200 && cut.body.answer === cutWhole && cutKept?.answer === cutWhole, { cut, cutKept });
  const lines = wholeSentences("Sources:\n- Opening hours\n- Cake ord");
  const words = wholeSentences("The kitchen stops serving at four");
  check("a cut reply with no sentence end keeps its whole lines, and one with no line either ends at its last whole word and an ellipsis",
    lines === "Sources:\n- Opening hours" && words === "The kitchen stops serving at…", { lines, words });
  const chineseCut = wholeSentences("我们早上八点开门。下午四点关门。厨房在");
  const title = wholeSentences("We open at 8am. Ask Dr. Smith about the cake ord");
  check("a cut reply ends after a Chinese full stop with no space after it, and not after a title such as Dr.",
    chineseCut === "我们早上八点开门。下午四点关门。" && title === "We open at 8am.", { chineseCut, title });

  // A model that refuses the effort setting is asked again without it.
  await post({ action: "settings", agent: "chat", model: "claude-haiku-4-5" }, admin);
  const sentBefore = sent.length;
  const older = await ask("What are your opening hours?");
  const [withEffort, without] = sent.slice(sentBefore);
  check("an agent on a model that refuses the effort setting still answers, asked again without it",
    older.body.answer === "Opening hours: 8am to 4pm, Tuesday to Saturday." && withEffort?.output_config?.effort === "low" && without && !without.output_config,
    { older, withEffort: withEffort?.output_config, without: without?.output_config });
  await post({ action: "settings", agent: "chat", model: "claude-haiku-5-5" }, admin);

  // remove_key stops the answers.
  res = await post({ action: "remove_key" }, admin);
  const after = await ask("What are your opening hours?");
  check("remove_key deletes the key, and a visitor then gets 503", res.body.key === "removed" && after.status === 503 && after.body.problem === UNAVAILABLE, { res, after });
  check("no reply holds the key or the Turnstile secret", !replies.some((r) => r.includes(KEY) || r.includes(SECRET) || r.includes(WRONG)), replies.filter((r) => r.includes("sk-ant")));
} catch (err) {
  console.log(`FAIL - public-agent.ts stopped: ${err instanceof Error ? err.stack : err}`);
  failed++;
} finally {
  await sql.end();
  await anthropic.shutdown();
  await cloudflare.shutdown();
  await supabase.shutdown();
}
if (failed) { console.log(`FAIL ${failed} public-agent check(s) failed`); Deno.exit(1); }
console.log("ok - public-agent");
