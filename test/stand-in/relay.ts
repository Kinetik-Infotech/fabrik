// fabrik's local connector, plugins/fabrik/mcp/relay.mjs, against the real fabrik-apps hosted function, on the step's
// own copy of the build. The relay runs as Claude runs it, a Node program on stdio, in a folder signed in with
// "connector": "local", with a sign-in saved in a home of its own whose address is this stand-in. The stand-in answers
// as Supabase does for what the relay and the connector call: /functions/v1/fabrik-apps is the connector, reached as
// through the Edge Functions gateway; /functions/v1/file-search is the real file-search function; /auth/v1/user gives a
// token's user; and a fabrik function is called by name as PostgREST calls it, as the token's user.
//
// It checks that initialize names fabrik-apps with fabrik's instructions, that tools/list gives the connector's tools,
// and that a record saved through the relay is found by search through it, as the person. A folder signed in without
// --local lists no tools, and so does a folder whose actor file says local but that isn't on the list of local folders.
// run.sh runs it.
import postgres from "npm:postgres@3.4.9";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "npm:jose@6.2.17";

const DB = Deno.env.get("STAND_IN_DB")!;
const WORK = Deno.env.get("STAND_IN_TMP")!;
const RELAY = new URL("../../plugins/fabrik/mcp/relay.mjs", import.meta.url).pathname;
const REF = "abcdefghijklmnopqrst";
const EMAIL = "relay@example.com";

let failed = 0;
function check(what: string, ok: boolean, seen: unknown) {
  console.log(`${ok ? "ok" : "FAIL"} - ${what}${ok ? "" : `: ${JSON.stringify(seen).slice(0, 2000)}`}`);
  if (!ok) failed++;
}
const sql = postgres(DB, { max: 4, prepare: false, onnotice() {} });

const { publicKey, privateKey } = await generateKeyPair("ES256");
const jwk = { ...(await exportJWK(publicKey)), kid: "stand-in", alg: "ES256", use: "sig" };
const tokenOf = (user: string) => new SignJWT({ role: "authenticated", aal: "aal1" })
  .setProtectedHeader({ alg: "ES256", kid: "stand-in" }).setSubject(user).setIssuedAt().setExpirationTime("10m").sign(privateKey);

type Handler = (req: Request) => Promise<Response>;
let connector: Handler, fileSearch: Handler;
const procsOf = new Map<string, Promise<{ names: string[]; types: string[] }[]>>();
const api = Deno.serve({ port: 0, onListen() {} }, async (req) => {
  const url = new URL(req.url);
  // The gateway passes a function the path after /functions/v1.
  if (url.pathname === "/functions/v1/fabrik-apps") return await connector(new Request(`http://127.0.0.1/fabrik-apps`, req));
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  let claims: { sub?: string; aal?: string };
  try { claims = (await jwtVerify(token, publicKey)).payload; }
  catch { return Response.json({ code: "PGRST301", message: "JWT could not be verified" }, { status: 401 }); }
  if (url.pathname === "/auth/v1/user") return Response.json({ id: claims.sub });
  if (url.pathname === "/functions/v1/file-search") return await fileSearch(req);
  const fn = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname)?.[1];
  if (!fn || req.headers.get("Content-Profile") !== "fabrik") return Response.json({ code: "PGRST106", message: "The schema must be fabrik" }, { status: 406 });
  const body: Record<string, unknown> = await req.json().catch(() => ({}));
  if (!procsOf.has(fn)) {
    procsOf.set(fn, sql`select p.proargnames as names, array(select format_type(t, null) from unnest(p.proargtypes) t) as types
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'fabrik' and p.proname = ${fn}`);
  }
  const matches = (await procsOf.get(fn)!).filter((p) => Object.keys(body).every((k) => (p.names ?? []).includes(k)));
  if (matches.length !== 1) return Response.json({ code: "PGRST202", message: `Could not find one function fabrik.${fn} with these arguments` }, { status: 404 });
  const [proc] = matches;
  const keys = Object.keys(body);
  const cast = (k: string, i: number) => {
    const type = proc.types[proc.names.indexOf(k)] as string;
    const value = `$${i + 1}::text::jsonb`;
    return type === "jsonb" || type === "json" ? `${value}::${type}`
      : type.endsWith("[]") ? `array(select jsonb_array_elements_text(${value}))::${type}`
      : `(${value} #>> '{}')::${type}`;
  };
  try {
    const [{ v }] = await sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: claims.sub, role: "authenticated", aal: claims.aal })}, true)`;
      await tx`set local role authenticated`;
      return await tx.unsafe(`select fabrik.${fn}(${keys.map((k, i) => `${k} => ${cast(k, i)}`).join(", ")}) as v`, keys.map((k) => body[k] == null ? null : JSON.stringify(body[k])));
    });
    return Response.json(v);
  } catch (err) {
    const e = err as { code?: string; message: string; detail?: string; hint?: string };
    return Response.json({ code: e.code, message: e.message, details: e.detail ?? null, hint: e.hint ?? null }, { status: 400 });
  }
});
const PROJECT_URL = `http://127.0.0.1:${api.addr.port}`;
Deno.env.set("SUPABASE_URL", PROJECT_URL);
Deno.env.set("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
Deno.env.set("SUPABASE_ANON_KEY", "publishable-key");
Deno.env.set("SUPABASE_JWKS", JSON.stringify({ keys: [jwk] }));
Deno.env.set("SUPABASE_FUNCTION_SLUG", "fabrik-apps");
Deno.env.set("SUPABASE_DB_URL", DB);
// file-search's gte-small runs only in Supabase's hosted functions; a fixed vector stands in, matching nothing by meaning.
(globalThis as Record<string, unknown>).Supabase = { ai: { Session: class { run() { return Promise.resolve(new Array(384).fill(0).map((_, i) => i === 383 ? 1 : 0)); } } } };
async function load(url: URL) {
  let taken: Handler | undefined;
  const serve = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (h: Handler) => { taken = h; return { finished: Promise.resolve(), shutdown() {} }; };
  await import(url.href);
  (Deno as unknown as { serve: unknown }).serve = serve;
  return taken!;
}
connector = await load(new URL("../../setup/functions/fabrik-apps/index.ts", import.meta.url));
fileSearch = await load(new URL("../../setup/functions/file-search/index.ts", import.meta.url));

/** A home with the person's sign-in saved as fabrik sign-in saves it, and a folder whose actor file holds actor. With
 * listed, the home's list of local folders names the folder, as sign-in --local writes it. */
async function place(name: string, token: string, actor: Record<string, string>, listed = true) {
  const home = `${WORK}/${name}/home`, folder = `${WORK}/${name}/folder`;
  const sessions = `${home}/.config/supabase-auth/${REF}`;
  await Deno.mkdir(sessions, { recursive: true, mode: 0o700 });
  await Deno.chmod(`${home}/.config/supabase-auth`, 0o700);
  await Deno.writeTextFile(`${sessions}/${EMAIL}.json`, JSON.stringify({ version: 1, projectRef: REF, url: PROJECT_URL, publishableKey: "publishable-key", email: EMAIL, refreshToken: "unused", accessToken: token, expiresAt: Date.now() + 600_000 }), { mode: 0o600 });
  await Deno.chmod(`${sessions}/${EMAIL}.json`, 0o600);
  await Deno.mkdir(folder, { recursive: true });
  await Deno.writeTextFile(`${folder}/.fabrik-actor.json`, JSON.stringify(actor));
  if (listed) {
    await Deno.mkdir(`${home}/.config/fabrik`, { recursive: true, mode: 0o700 });
    await Deno.writeTextFile(`${home}/.config/fabrik/local-folders.json`, JSON.stringify({ version: 1, folders: [await Deno.realPath(folder)] }), { mode: 0o600 });
    await Deno.chmod(`${home}/.config/fabrik/local-folders.json`, 0o600);
  }
  return { home, folder };
}

/** The relay, started as Claude starts it, given each message after the one before it is answered. Its answers by id. */
async function relay(where: { home: string; folder: string }, messages: Record<string, unknown>[]) {
  const child = new Deno.Command("node", { args: [RELAY], env: { HOME: where.home, FABRIK_SESSION_FOLDER: where.folder, PATH: Deno.env.get("PATH") ?? "" }, stdin: "piped", stdout: "piped", stderr: "piped", clearEnv: true }).spawn();
  const writer = child.stdin.getWriter();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  // deno-lint-ignore no-explicit-any
  const answers = new Map<number, any>();
  let buffer = "";
  for (const msg of messages) {
    await writer.write(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n"));
    if (msg.id === undefined) continue;
    while (!answers.has(msg.id as number)) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        answers.set(line.id, line);
      }
    }
  }
  await writer.close();
  reader.releaseLock();
  await child.stdout.cancel().catch(() => {});
  const ended = await child.output().catch(() => null);
  return { answers, stderr: ended ? new TextDecoder().decode(ended.stderr) : "" };
}

const INIT = { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "stand-in", version: "1" } } };
const text = (answer: { result?: { content?: { text?: string }[] } }) => { try { return JSON.parse(answer?.result?.content?.[0]?.text ?? "null"); } catch { return null; } };

try {
  const person = crypto.randomUUID();
  await sql`insert into auth.users(id) values (${person})`;
  const [{ actor }] = await sql`select fabrik_private.provision_first_administrator(${person}::uuid, 'Relay test person') as actor`;
  await sql`insert into fabrik.scope(code, display_name, description, created_by) values ('relay_notes', 'Relay notes', 'Stand-in fixture', ${actor})`;
  const token = await tokenOf(person);

  const local = await place("local", token, { project_ref: REF, auth_email: EMAIL, connector: "local" });
  const saved = { scope: "Relay notes", kind: "evidence", title: "Harbour lighthouse notes", reason: "Relay test",
    fields: { summary: "The harbour lighthouse lamp was replaced.", standing: "observed", properties: {} } };
  const ran = await relay(local, [INIT, { method: "notifications/initialized" }, { id: 2, method: "tools/list" },
    { id: 3, method: "tools/call", params: { name: "save_record", arguments: saved } }]);
  const init = ran.answers.get(1), list = ran.answers.get(2), save = ran.answers.get(3);
  // The record's text, as file-search's worker reads it in Supabase, so search can find it by its words.
  const record = save?.result?.structuredContent?.record_id;
  const [waiting] = record ? await sql`select version_id as v, body from file_search.file_version where record_id = ${record}::uuid and state = 'waiting' order by queued_at desc limit 1` : [];
  if (waiting) await sql`select file_search.record_file_text(${waiting.v}::uuid, 'extracted', ${JSON.stringify([{ ordinal: 0, place: "part 1", body: waiting.body, section: 0 }])}::text::jsonb, null,
    ${JSON.stringify([{ ordinal: 0, place: "part 1", body: waiting.body }])}::text::jsonb)`;
  const second = await relay(local, [INIT, { method: "notifications/initialized" }, { id: 2, method: "tools/call", params: { name: "search", arguments: { query: "lighthouse" } } }]);
  const found = text(second.answers.get(2));
  check("initialize through the relay answers as fabrik-apps, with fabrik's instructions",
    init?.result?.serverInfo?.name === "fabrik-apps" && String(init?.result?.instructions ?? "").startsWith("fabrik is the person's own knowledge base"), init ?? ran.stderr);
  const names = (list?.result?.tools ?? []).map((t: { name: string }) => t.name);
  check("tools/list through the relay gives the connector's tools, search and save_record among them",
    names.length > 50 && names.includes("search") && names.includes("save_record"), names.length ? names : list ?? ran.stderr);
  check("save_record through the relay saves as the signed-in person", save?.result && !save.result.isError, save);
  check("search through the relay finds the record just saved",
    (found?.hits ?? []).some((h: { found_as?: string; file?: string }) => h.found_as === "record" && h.file === "Harbour lighthouse notes"), found ?? second.answers.get(2));

  const plain = await place("plain", token, { project_ref: REF, auth_email: EMAIL });
  const off = await relay(plain, [INIT, { id: 2, method: "tools/list" }]);
  check("a folder signed in without --local lists no tools through the relay",
    off.answers.get(1)?.result?.serverInfo?.name === "fabrik" && JSON.stringify(off.answers.get(2)?.result?.tools) === "[]", [...off.answers.values()]);

  const unlisted = await place("unlisted", token, { project_ref: REF, auth_email: EMAIL, connector: "local" }, false);
  const refused = await relay(unlisted, [INIT, { id: 2, method: "tools/list" }]);
  check("a folder whose actor file says connector local, but that isn't on the list of local folders, lists no tools",
    JSON.stringify(refused.answers.get(2)?.result?.tools) === "[]" && /isn't turned on for/.test(refused.answers.get(1)?.result?.instructions ?? ""), [...refused.answers.values()]);
} catch (err) {
  console.log(`FAIL - the relay step stopped: ${err instanceof Error ? err.stack : err}`);
  failed++;
} finally {
  await sql.end();
  await api.shutdown();
}
if (failed) { console.log(`FAIL ${failed} relay check(s)`); Deno.exit(1); }
console.log("PASS relay");
Deno.exit(0);
