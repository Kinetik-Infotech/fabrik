// The public-agent hosted function, run against the step's own copy of the build, with Anthropic's API, Cloudflare's
// siteverify and Supabase's Storage and Auth answered here. Nothing outside this computer is called.
//
// An administrator sets the key, the Turnstile secret and KNOWLEDGE.md. A person who isn't one is refused each, and a
// wrong key or secret is not kept.
//
// A visitor's question in the file gets the file's answer, and one outside it gets don't know. The request to
// Claude holds the fixed instruction, then the file, cached, the latest turns that fit, at most 10, and 1,000 tokens. A
// post with no Turnstile token is refused before a database connection opens, and a failed check gets 403 and calls
// nothing. chat.js, run in a page, gets an answer to every question of a long conversation. Once today's tokens reach the cap, the answer is the resting message and
// Claude isn't called. No row anywhere holds a question, and no reply holds the key or the secret. run.sh runs it.
import postgres from "npm:postgres@3.4.9";
import Anthropic from "npm:@anthropic-ai/sdk@0.137.0";
import { Window } from "npm:happy-dom@20.0.10";

const DB = Deno.env.get("STAND_IN_DB")!;
const FUNCTION = new URL("../../setup/functions/public-agent/index.ts", import.meta.url);
const KEY = `sk-ant-api03-public${crypto.randomUUID().replaceAll("-", "")}`;
const WRONG = `sk-ant-api03-wrong${crypto.randomUUID().replaceAll("-", "")}`;
const SECRET = `0x4AAAAAAA${crypto.randomUUID().replaceAll("-", "")}`;
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
const anthropic = Deno.serve({ port: 0, onListen() {} }, async (req) => {
  const url = new URL(req.url);
  if (req.headers.get("x-api-key") !== KEY) return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 });
  if (req.method === "GET" && url.pathname.startsWith("/v1/models/")) {
    const id = url.pathname.slice("/v1/models/".length);
    if (!id.startsWith("claude-")) return Response.json({ type: "error", error: { type: "not_found_error", message: id } }, { status: 404 });
    return Response.json({ type: "model", id, display_name: id, created_at: "2026-09-01T00:00:00Z" });
  }
  if (req.method === "POST" && url.pathname === "/v1/messages") {
    const body = await req.json();
    sent.push(body);
    const file = String(body.system?.[1]?.text ?? "");
    const words = String(body.messages.at(-1).content).toLowerCase().match(/[a-z]{4,}/g) ?? [];
    const line = file.split("\n").find((l) => words.some((w) => l.toLowerCase().includes(w)));
    const text = String(body.messages.at(-1).content).includes("long answer") ? `Long answer. ${"z".repeat(817)}`
      : line ? line.trim() : "I don't know. Please contact the owner.";
    // A reply with no content list, which the function can't read after Claude has charged for it.
    if (String(body.messages.at(-1).content).includes("broken reply")) return Response.json({ id: "msg_standin", type: "message", role: "assistant",
      model: body.model, stop_reason: "end_turn", content: null, usage: { input_tokens: 400, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 6000 } });
    return Response.json({
      id: "msg_standin", type: "message", role: "assistant", model: body.model, stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text }],
      usage: { input_tokens: 400, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 6000 },
    });
  }
  return Response.json({ type: "error", error: { type: "not_found_error", message: url.pathname } }, { status: 404 });
});

// Cloudflare's siteverify: the secret SECRET, and the token GOOD_TOKEN, pass.
const verified: { secret: string; response: string }[] = [];
const cloudflare = Deno.serve({ port: 0, onListen() {} }, async (req) => {
  const form = await req.formData();
  const secret = String(form.get("secret") ?? ""), response = String(form.get("response") ?? "");
  verified.push({ secret, response });
  if (secret !== SECRET) return Response.json({ success: false, "error-codes": ["invalid-input-secret"] });
  return Response.json(response === GOOD_TOKEN ? { success: true, "error-codes": [] } : { success: false, "error-codes": ["invalid-input-response"] });
});

// Supabase's Storage, for the service key alone: an upload keeps the file and inserts its row, as Storage does.
let stored: string | null = null;
const supabase = Deno.serve({ port: 0, onListen() {} }, async (req) => {
  const path = new URL(req.url).pathname;
  if (path !== "/storage/v1/object/public-agent/KNOWLEDGE.md" || req.headers.get("Authorization") !== `Bearer ${SERVICE_KEY}`)
    return Response.json({ statusCode: "403", error: "Unauthorized" }, { status: 400 });
  if (req.method === "GET") return stored === null ? Response.json({ statusCode: "404", error: "not_found" }, { status: 400 }) : new Response(stored);
  stored = await req.text();
  await sql`insert into storage.objects(bucket_id, name, metadata) values ('public-agent', 'KNOWLEDGE.md', ${sql.json({ size: stored.length })})
    on conflict do nothing`;
  return Response.json({ Key: "public-agent/KNOWLEDGE.md" });
});

Deno.env.set("SUPABASE_URL", `http://127.0.0.1:${supabase.addr.port}`);
Deno.env.set("SUPABASE_DB_URL", DB);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY);
let handler: ((req: Request) => Promise<Response>) | undefined;
const serve = Deno.serve;
(Deno as unknown as { serve: unknown }).serve = (h: typeof handler) => { handler = h; return { finished: Promise.resolve(), shutdown() {} }; };
const { seam, INSTRUCTION, RESTING, UNAVAILABLE, NOT_CHECKED } = await import(FUNCTION.href);
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

try {
  const admin = crypto.randomUUID(), person = crypto.randomUUID();
  await sql`insert into auth.users(id) values (${admin}), (${person})`;
  users.add(admin); users.add(person);
  const [{ h }] = await sql`select fabrik_private.provision_first_administrator(${admin}::uuid, 'Public agent owner') as h`;
  await sql`select fabrik_private.provision_actor(${h}::uuid, ${person}::uuid, 'Public agent staff', 'human', null, 'restricted', false)`;

  const [bucket] = await sql`select public from storage.buckets where id = 'public-agent'`;
  check("the build makes the private bucket public-agent", bucket?.public === false, bucket);

  // Before setup, a visitor is told the assistant can't answer, and nothing outside is called.
  let res = await ask("When are you open?");
  check("before setup, a visitor's question gets 503 with the words a visitor reads, and calls neither Cloudflare nor Claude",
    res.status === 503 && res.body.problem === UNAVAILABLE && verified.length === 0 && sent.length === 0, res);
  const preflight = await handler!(new Request("http://function/", { method: "OPTIONS" }));
  check("a browser's preflight gets 204 with the headers a page on another site needs",
    preflight.status === 204 && preflight.headers.get("Access-Control-Allow-Origin") === "*" && /content-type/.test(preflight.headers.get("Access-Control-Allow-Headers") ?? ""), preflight.status);

  // The settings actions, for an administrator alone.
  for (const action of ["check", "set_key", "set_turnstile", "remove_key", "knowledge_get", "knowledge_save", "settings"]) {
    res = await post({ action, key: KEY, secret: SECRET, text: KNOWLEDGE }, person);
    if (res.status !== 403) check(`a person who isn't an administrator is refused ${action}`, false, res);
  }
  res = await post({ action: "check" });
  check("a person who isn't an administrator is refused every action, and an action with no sign-in gets 401",
    res.status === 401 && stored === null && (await sql`select count(*)::int as n from vault.secrets`)[0].n === 0, res);
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
  res = await post({ action: "knowledge_save", text: "x".repeat(100_001) }, admin);
  check("a KNOWLEDGE.md over 100,000 characters is refused", res.status === 400 && stored === null, res);
  res = await post({ action: "knowledge_save", text: KNOWLEDGE }, admin);
  const got = await post({ action: "knowledge_get" }, admin);
  check("knowledge_save keeps KNOWLEDGE.md and knowledge_get reads it back", res.status === 200 && got.body.text === KNOWLEDGE, { res, got });
  const [{ n: queued }] = await sql`select count(*)::int as n from file_search.file_version where bucket_id = 'public-agent'`;
  check("KNOWLEDGE.md isn't queued for fabrik's file search", queued === 0, queued);
  res = await post({ action: "check" }, admin);
  check("check says the key is available, the secret set and the file there",
    res.body.key === "available" && res.body.turnstile === "set" && res.body.knowledge === true, res);
  res = await post({ action: "settings" }, admin);
  check("settings gives Claude Haiku 5.5 and a cap of 500,000 tokens to start, and no tokens today",
    res.body.model === "claude-haiku-5-5" && res.body.daily_cap_tokens === 500000 && res.body.today_tokens === 0, res);

  // A visitor's questions.
  const marker = `zebra${crypto.randomUUID().slice(0, 8)}`;
  res = await ask("What are your opening hours?");
  check("a question the file answers gets the file's answer", res.status === 200 && res.body.answer === "Opening hours: 8am to 4pm, Tuesday to Saturday." && res.cors === "*", res);
  const first = sent.at(-1);
  check("Claude gets the fixed instruction, then the file with cache_control, the default model and at most 1,000 tokens",
    first.model === "claude-haiku-5-5" && first.max_tokens === 1000 && first.system[0].text === INSTRUCTION && !first.system[0].cache_control
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
  // 1,000 tokens of output, so the answer is the resting message.
  res = await post({ action: "settings", daily_cap_tokens: 5000 }, admin);
  const held = sent.length;
  const short = await ask("What services do you offer?");
  const afterHold = await post({ action: "settings" }, admin);
  check("an answer whose most would pass the cap gets the resting message, Claude isn't called, and nothing stays held",
    short.body.answer === RESTING && sent.length === held && afterHold.body.today_tokens === 4120, { short, afterHold });
  res = await post({ action: "settings", daily_cap_tokens: 4000 }, admin);
  check("settings counts today's tokens from Claude's usage, a cache read at a tenth, and sets the cap", res.body.today_tokens === 4120 && res.body.daily_cap_tokens === 4000, res);
  const before = sent.length;
  res = await ask("What services do you offer?");
  check("once today's tokens reach the cap, the answer is the resting message and Claude isn't called",
    res.status === 200 && res.body.answer === RESTING && sent.length === before, res);
  res = await post({ action: "settings", model: "gpt-4" }, admin);
  check("a model that isn't Claude's is refused", res.status === 400, res);

  // Nothing holds a question.
  const tables = await sql`select format('%I.%I', table_schema, table_name) as t from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')`;
  const holding: string[] = [];
  for (const { t } of tables) {
    const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${t} r where r::text like $1`, [`%${marker}%`]);
    if (n) holding.push(t);
  }
  const [usage] = await sql`select tokens from fabrik_private.public_agent_usage where day = (now() at time zone 'utc')::date`;
  check(`no row in any of ${tables.length} tables holds a question, and the usage row holds today's tokens`, holding.length === 0 && Number(usage?.tokens) === 4120, { holding, usage });

  // The hold counts bytes, so a question in any language can't pass the cap. 2,000 Chinese characters are 6,000 bytes:
  // with 4,120 spent, a cap of 10,120 leaves too little room for them.
  res = await post({ action: "settings", daily_cap_tokens: 10120 }, admin);
  const beforeChinese = sent.length;
  const chinese = await ask("营".repeat(2000));
  check("a 2,000-character question in Chinese is held at its 6,000 bytes, so it gets the resting message under a cap of 10,120",
    chinese.body.answer === RESTING && sent.length === beforeChinese, chinese);
  // A reply that breaks after Claude has charged for it still puts its own tokens in place of what was held.
  res = await post({ action: "settings", daily_cap_tokens: 500000 }, admin);
  const broken = await ask("Tell me about the broken reply");
  const afterBroken = await post({ action: "settings" }, admin);
  check("a reply the function can't read gets the words a visitor reads, and today's tokens hold its 1,030, not what was held",
    broken.status === 500 && broken.body.problem === UNAVAILABLE && afterBroken.body.today_tokens === 4120 + 1030, { broken, afterBroken });

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
  check("chat.js gets an answer to each of 12 questions with 830-character answers, sending the latest 9 turns once 10 would pass 8,000 characters",
    answers.length === 12 && answers.every((c) => c === "a") && lastHistory.length === 18 && lastHistory[0].content.startsWith("Question 3:")
      && lastHistory.reduce((n: number, t: any) => n + t.content.length, 0) <= 8000,
    { answers, sizes: posted.map((p) => [p.history.length, p.history.reduce((n: number, t: any) => n + t.content.length, 0)]) });
  await page.happyDOM.close();

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
