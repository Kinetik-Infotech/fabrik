// fabrik's client for Supabase's Management API, https://api.supabase.com, shared by fabrik connector-settings and
// fabrik setup --owner. Each call follows the API's own description, https://api.supabase.com/api/v1-json.
//
// The client holds a personal access token the owner pastes at a hidden prompt, for one run only. The token goes
// in the Authorization header and nowhere else: a refusal's message has it taken out, even when Supabase's answer
// echoes the request, and the client prints nothing.
//
// FABRIK_TEST_MANAGEMENT_API names a stand-in for the Management API, for the plugin's tests. It is used only when it
// is a loopback http address, such as http://127.0.0.1:<port>, and ignored otherwise. A command that uses it says
// so before any prompt.
import process, { stdin, stdout } from "node:process";

export const API = "https://api.supabase.com";
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
/** The services a project needs before setup can build in it: the database, the Data API, sign-in and files. */
const SERVICES = "auth,db,rest,storage";
/** The most projects one page holds, as the v1-json allows. */
const PAGE = 100;

/** The Management API's address: the real one, or a loopback stand-in named by FABRIK_TEST_MANAGEMENT_API. */
export function apiBase(env = process.env) {
  const given = env.FABRIK_TEST_MANAGEMENT_API;
  return given && LOOPBACK.test(given) ? given : API;
}

/** A refused or failed call, with Supabase's own message. */
export class Refused extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Supabase's own message from an answer's body. */
function message(text, status) {
  try {
    const body = JSON.parse(text);
    const said = body?.message ?? body?.error_description ?? body?.error ?? body?.msg;
    if (said) return typeof said === "string" ? said : JSON.stringify(said);
  } catch { /* not JSON */ }
  return text.trim() || `HTTP ${status}`;
}

/** text with each secret taken out, every copy replaced by its label. */
const without = (text, secrets) => secrets.reduce((t, [secret, label]) => secret ? t.split(secret).join(label) : t, text);
/** The longest refusal message kept, so an answer that echoes a whole request stays one readable line. */
const MESSAGE_MAX = 500;
/** A message cut to MESSAGE_MAX characters, after every secret is taken out, so a cut never leaves part of one. */
const capped = text => text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 1)}…` : text;

/**
 * A client for the Management API with token. call(method, path, body, { allow404, secrets }) calls path, such as
 * /v1/organizations, and returns the answer's JSON, or null for a 404 when allowed. A FormData body goes as
 * multipart, any other body as JSON. A refusal throws Refused with Supabase's message, with the token, and each of
 * secrets, [value, label], taken out before the message is cut.
 */
export function managementClient(token, base = apiBase()) {
  return {
    async call(method, path, body, { allow404 = false, secrets = [] } = {}) {
      const form = body instanceof FormData;
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body && !form ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: form ? body : JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      if (res.status === 404 && allow404) return null;
      if (!res.ok) throw new Refused(res.status, capped(without(message(text, res.status), [[token, "[token]"], ...secrets])));
      if (!text) return {};
      try { return JSON.parse(text); }
      catch { throw new Refused(res.status, "Supabase's answer was not JSON."); }
    },
  };
}

/** The organisations the token reaches: [{ slug, name }]. GET /v1/organizations. */
export async function organizations(c) {
  return (await c.call("GET", "/v1/organizations")).map(o => ({ slug: o.slug, name: o.name }));
}

/** One organisation with its plan: free, pro, team, enterprise or platform. GET /v1/organizations/{slug}. */
export async function organization(c, slug) {
  const o = await c.call("GET", `/v1/organizations/${encodeURIComponent(slug)}`);
  return { slug, name: o.name, plan: o.plan };
}

/** Every project in the organisation, page by page: [{ ref, name, status }]. GET /v1/organizations/{slug}/projects. */
export async function projects(c, orgSlug) {
  const all = [];
  for (let offset = 0; ; ) {
    const { projects: page = [], pagination } = await c.call("GET", `/v1/organizations/${encodeURIComponent(orgSlug)}/projects?offset=${offset}&limit=${PAGE}`);
    all.push(...page.map(p => ({ ref: p.ref, name: p.name, status: p.status })));
    offset += page.length;
    if (!page.length || offset >= (pagination?.count ?? 0)) return all;
  }
}

/** A project reference: 20 lower-case letters and digits. */
export const PROJECT_REF = /^[a-z0-9]{20}$/;

/**
 * Creates a project, and returns { ref }, or { ref: null } when Supabase's answer holds no project reference, in ref
 * or, as older answers have it, in id. POST /v1/projects. dbPass goes in the body alone, and is taken out of a
 * refusal's message, as the token is.
 */
export async function createProject(c, { orgSlug, name, region, dbPass }) {
  const made = await c.call("POST", "/v1/projects", { name, organization_slug: orgSlug, db_pass: dbPass, region_selection: { type: "specific", code: region } },
    { secrets: [[dbPass, "[password]"]] });
  const ref = made?.ref ?? made?.id;
  return { ref: typeof ref === "string" && PROJECT_REF.test(ref) ? ref : null };
}

/** Whether every service the project needs answers healthy. GET /v1/projects/{ref}/health. */
async function healthy(c, ref) {
  const services = await c.call("GET", `/v1/projects/${encodeURIComponent(ref)}/health?services=${encodeURIComponent(SERVICES)}`);
  return Array.isArray(services) && services.length > 0 && services.every(s => s.healthy === true);
}

/** Answers that no later poll can change: a bad request, a refused token, a project the token cannot see. */
const FINAL = [400, 401, 403, 404, 422];

/** A project's states that no wait ends: paused or pausing, failed, or being removed. */
export const PAUSED = ["INACTIVE", "PAUSING"];
const STUCK = [...PAUSED, "PAUSE_FAILED", "RESTORE_FAILED", "INIT_FAILED", "REMOVED", "GOING_DOWN"];

/** A project in a state no wait ends, with that state as Supabase names it. */
export class ProjectStuck extends Error {
  constructor(state) { super(`Supabase shows the project as ${state}.`); this.state = state; }
}

/**
 * Polls the project's health every everyMs until it is healthy, and returns true, or false once timeoutMs has
 * passed. A poll Supabase turns down while the project comes up counts as not healthy yet, and so does a poll that
 * cannot reach Supabase at all, such as a network blip. It stops at once with Supabase's message on 400 or 422, a
 * refused token, 401 or 403, and a project the token cannot see, 404. A project that answers unhealthy is read with
 * GET /v1/projects/{ref}, and one that is paused, failed or being removed throws ProjectStuck at once.
 */
export async function waitHealthy(c, ref, { timeoutMs = 600000, everyMs = 10000, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const until = now() + timeoutMs;
  for (;;) {
    try {
      if (await healthy(c, ref)) return true;
      const state = (await c.call("GET", `/v1/projects/${encodeURIComponent(ref)}`))?.status;
      if (STUCK.includes(state)) throw new ProjectStuck(state);
    }
    catch (err) {
      // fetch throws a TypeError when the request never got an answer.
      const unreached = err instanceof TypeError;
      if (err instanceof ProjectStuck || !unreached && (!(err instanceof Refused) || FINAL.includes(err.status))) throw err;
    }
    if (now() >= until) return false;
    await sleep(everyMs);
  }
}

/** Runs sql in the project's database, and returns its rows. POST /v1/projects/{ref}/database/query. */
export async function query(c, ref, sql) {
  const rows = await c.call("POST", `/v1/projects/${encodeURIComponent(ref)}/database/query`, { query: sql });
  return Array.isArray(rows) ? rows : [];
}

/**
 * Deploys a hosted function from its files, creating it when it does not exist. POST /v1/projects/{ref}/functions/deploy,
 * multipart: one "file" part per file, under its name, and a "metadata" part with entrypoint_path, name and verify_jwt.
 */
export async function deployFunction(c, ref, { name, entrypoint, verifyJwt, files }) {
  const form = new FormData();
  form.append("metadata", JSON.stringify({ entrypoint_path: entrypoint, name, verify_jwt: verifyJwt }));
  for (const f of files) form.append("file", new Blob([f.text], { type: "application/typescript" }), f.name);
  await c.call("POST", `/v1/projects/${encodeURIComponent(ref)}/functions/deploy?slug=${encodeURIComponent(name)}`, form);
}

/** Deletes a hosted function. DELETE /v1/projects/{ref}/functions/{function_slug}. A function already gone is not an error. */
export async function deleteFunction(c, ref, slug) {
  await c.call("DELETE", `/v1/projects/${encodeURIComponent(ref)}/functions/${encodeURIComponent(slug)}`, undefined, { allow404: true });
}

/** The project's hosted functions: [{ slug, verify_jwt }]. GET /v1/projects/{ref}/functions. */
export async function functionsList(c, ref) {
  return (await c.call("GET", `/v1/projects/${encodeURIComponent(ref)}/functions`)).map(f => ({ slug: f.slug, verify_jwt: f.verify_jwt }));
}

/** The project's publishable key. GET /v1/projects/{ref}/api-keys, never asking Supabase to reveal a secret key. */
export async function publishableKey(c, ref) {
  const key = (await c.call("GET", `/v1/projects/${encodeURIComponent(ref)}/api-keys`)).find(k => k.type === "publishable" && k.api_key);
  if (!key) throw new Refused(404, "Supabase shows no publishable key for this project.");
  return key.api_key;
}

/** The email of the Supabase account the token belongs to, or null when Supabase gives none. GET /v1/profile. */
export async function profileEmail(c) {
  try {
    const email = (await c.call("GET", "/v1/profile"))?.primary_email;
    return typeof email === "string" && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
  } catch { return null; }
}

/** The Data API serves fabrik beside the schemas it already serves, and reloads its schema. GET, then PATCH,
 * /v1/projects/{ref}/postgrest. Supabase's PostgREST takes its schemas from this setting, not from the authenticator role's. */
export async function exposeFabrik(c, ref) {
  const path = `/v1/projects/${encodeURIComponent(ref)}/postgrest`;
  const served = String((await c.call("GET", path))?.db_schema ?? "public, graphql_public").split(",").map(x => x.trim()).filter(Boolean);
  if (!served.includes("fabrik")) await c.call("PATCH", path, { db_schema: [...served, "fabrik"].join(", ") });
  await query(c, ref, "notify pgrst, 'reload schema'");
}

// Typing before the token's prompt is held unshown and then dropped, so a token pasted early is never shown on the
// screen, and never joined to the one pasted at the prompt. Ctrl-C while it is held stops the command.
let held = null;

/** Turns the terminal's echo off and holds whatever is typed, until askHidden drops it. Does nothing without a terminal. */
export function holdTyping() {
  if (held || !stdin.isTTY || typeof stdin.setRawMode !== "function") return;
  held = { dropped: 0 };
  stdin.setEncoding("utf-8");
  stdin.setRawMode(true);
  held.take = chunk => {
    if (chunk.includes("\u0003")) { stdin.setRawMode(false); stdout.write("\n"); process.exit(130); }
    held.dropped += chunk.length;
  };
  stdin.on("data", held.take);
  stdin.resume();
}

/** Drops what was typed while held, after a moment for typing the terminal has queued to arrive. Returns whether any was. */
async function dropHeld() {
  if (!held) return false;
  await new Promise(resolve => setTimeout(resolve, 150));
  stdin.off("data", held.take);
  const dropped = held.dropped > 0;
  held = null;
  return dropped;
}

/** The line above every hidden question, since a password or token that does not show is often pasted twice. */
export const HIDDEN_HINT = "Nothing shows as you type or paste. Do it once, then press Enter.";

// Typed past the end of a visible answer, kept for the next question. What is typed past a hidden answer is dropped,
// so nothing typed after a password or token is ever shown.
let ahead = "";

/**
 * One line from the terminal. A visible one is echoed as it is typed, a hidden one never. Ctrl-C stops the run, and
 * Ctrl-D ends the answer as Enter does, once something was typed. Escape sequences, such as an arrow key or the marks
 * a terminal puts around a paste, ESC[200~ and ESC[201~, are dropped whole, and so is any other control character.
 */
export function askLine(prompt, hidden = false) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return Promise.reject(new Error("This command needs an interactive terminal."));
  stdin.setEncoding("utf-8");
  stdin.setRawMode(true);
  stdout.write(hidden ? `${HIDDEN_HINT}\n${prompt}` : prompt);
  return new Promise((done, fail) => {
    let value = "";
    // The escape sequence being read: ESC, then ESC [ and its parameters up to a final byte, or ESC O and one more.
    let esc = "";
    const finish = (error, answer) => {
      stdin.off("data", take);
      stdin.off("end", closed);
      stdin.setRawMode(false);
      stdin.pause();
      error ? fail(error) : done(answer);
    };
    const take = chunk => {
      const text = ahead + chunk;
      ahead = "";
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (esc) {
          esc += char;
          if (esc.length === 2 ? char !== "[" && char !== "O" : esc[1] === "O" || /[\x40-\x7e]/.test(char)) esc = "";
          continue;
        }
        if (char === "\u001b") { esc = char; continue; }
        if (char === "\r" || char === "\n" || char === "\u0004" && value) {
          if (!hidden) ahead = text.slice(char === "\r" && text[i + 1] === "\n" ? i + 2 : i + 1);
          stdout.write("\n");
          return finish(null, value.trim());
        }
        if (char === "\u0003") { stdout.write("\n"); return finish(new Error("cancelled.")); }
        if (char === "\u007f" || char === "\b") {
          if (value && !hidden) stdout.write("\b \b");
          value = value.slice(0, -1);
        } else if (char >= " ") {
          value += char;
          if (!hidden) stdout.write(char);
        }
      }
    };
    const closed = () => finish(new Error("input closed."));
    stdin.on("data", take);
    stdin.on("end", closed);
    stdin.resume();
    if (ahead) take("");
  });
}

/** One hidden line, such as an access token, with whatever was typed before its prompt dropped unshown. */
export async function askHidden(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("This command needs an interactive terminal.");
  if (await dropHeld()) stdout.write("What was typed before this prompt was not used, and was not shown.\n");
  return askLine(prompt, true);
}
