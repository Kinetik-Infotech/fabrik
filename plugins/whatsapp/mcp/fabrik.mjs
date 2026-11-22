// The person's fabrik, through their own saved sign-in, as fabrik's relay reaches it (plugins/fabrik/mcp/relay.mjs and
// cli/fabrik-session.mjs): the folder's actor file names the sign-in, else the only one saved on this computer. Chat
// files go into the person's private scope, through Storage, under the person's own rights, so fabrik's search reads
// them as it reads any file there.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readActor } from "./lib/actor-file.mjs";
import { callRpc, downloadObject, PROJECT_REF, sessionAccess, UPLOAD_LIMIT, uploadObject } from "./lib/session.mjs";

const SIGN_IN = "fabrik sign-in, as the fabrik plugin's actor skill describes";

/** The sign-in to use, as { ref, email }, or { problem }. */
export function whichSignIn(folder, home = homedir()) {
  const actor = folder ? readActor(folder) : null;
  if (actor && !actor.ok) return { problem: actor.problem };
  if (actor) return { ref: actor.value.project_ref, email: actor.value.auth_email };
  const root = join(home, ".config", "supabase-auth");
  const saved = [];
  try {
    for (const ref of readdirSync(root)) {
      if (!PROJECT_REF.test(ref)) continue;
      for (const file of readdirSync(join(root, ref))) if (file.endsWith(".json") && !file.startsWith(".")) saved.push({ ref, email: file.slice(0, -5) });
    }
  } catch { /* none saved */ }
  if (saved.length === 1) return saved[0];
  if (!saved.length) return { problem: `No fabrik sign-in is saved on this computer. Sign in first with ${SIGN_IN}.` };
  return { problem: `More than one fabrik sign-in is saved on this computer. Open the session in your fabrik folder, the one you signed in with --folder.` };
}

/** A current token for the person: { ok: true, ref, email, access: { url, key, token } } or { ok: false, problem }. */
export async function openFabrik({ ref, email }) {
  let opened;
  try { opened = await sessionAccess(ref, email); }
  catch (err) { return { ok: false, problem: `fabrik's project ${ref} could not be reached: ${err?.cause?.code ?? err?.message ?? err}` }; }
  if (opened.missing) return { ok: false, problem: `${email} is not signed in to fabrik on this computer. Sign in with ${SIGN_IN}.` };
  if (opened.wrongUser) return { ok: false, problem: `The saved sign-in is for ${opened.wrongUser}, not ${email}. Sign in again with ${SIGN_IN}.` };
  if (!opened.ok) return { ok: false, problem: `${opened.problem} Sign in again with ${SIGN_IN}.` };
  return { ok: true, ref, email, access: { url: opened.url, key: opened.key, token: opened.token } };
}

/**
 * The private scope the chats go in: the one named, else the person's only private scope. Answers { ok, code, name }
 * or { ok: false, problem }.
 */
export async function privateScope({ url, key, token }, named) {
  const me = await callRpc(url, key, token, "fabrik_get_actor", "fabrik", {});
  if (!me.ok) return { ok: false, problem: `fabrik didn't say who you are: ${me.problem}` };
  const mine = [];
  let cursor = null;
  do {
    const page = await callRpc(url, key, token, "fabrik_get_scopes", "fabrik", { p_cursor: cursor, p_limit: 100 });
    if (!page.ok) return { ok: false, problem: `fabrik didn't list your scopes: ${page.problem}` };
    for (const s of page.body?.items ?? []) if (s.is_private && s.owner_actor_id === me.body.actor_id && s.enabled !== false) mine.push(s);
    cursor = page.body?.next_cursor ?? null;
  } while (cursor);
  if (named) {
    const hit = mine.find(s => s.code === named);
    return hit ? { ok: true, code: hit.code, name: hit.display_name }
      : { ok: false, problem: `${named} is not a private scope of yours. Yours: ${mine.map(s => s.code).join(", ") || "none"}.` };
  }
  if (mine.length === 1) return { ok: true, code: mine[0].code, name: mine[0].display_name };
  if (!mine.length) return { ok: false, problem: "You have no private scope in fabrik, so the chats have nowhere to go. An administrator adds one for you, as section 20 of fabrik's records skill describes." };
  return { ok: false, problem: `You own more than one private scope. Name the one for WhatsApp as scope: ${mine.map(s => `${s.code} (${s.display_name})`).join(", ")}.` };
}

/** Reads and writes files in one scope: { read(path) → text or null, write(path, text) }. Each throws on a refusal. */
export function scopeFiles({ url, key, token }, scope) {
  return {
    async read(path) {
      const got = await downloadObject(url, key, token, scope, path, UPLOAD_LIMIT);
      if (got.ok) return Buffer.from(got.body).toString("utf8");
      if (got.status === 404 || (got.status === 400 && /not.?found/i.test(got.problem))) return null;
      throw new Error(`fabrik didn't give ${path}: ${got.problem}`);
    },
    async write(path, text) {
      const bytes = Buffer.from(text, "utf8");
      if (bytes.length > UPLOAD_LIMIT) throw new Error(`${path} is over ${UPLOAD_LIMIT / (1024 * 1024)} MB, the largest file this plugin uploads.`);
      const put = await uploadObject(url, key, token, scope, path, bytes, "text/markdown", true);
      if (!put.ok) throw new Error(`fabrik refused ${path}: ${put.problem}`);
    },
  };
}
