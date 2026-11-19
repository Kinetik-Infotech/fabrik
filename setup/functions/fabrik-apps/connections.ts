// Connections, on the connections card: an administrator turns them on by typing the business's Anthropic API key, and
// turns them off. show_connections_setup shows the card with whether connections are on, from graph-reader's check.
// The card's Save calls connections_setup_save, and its Turn off calls connections_off, both through card_call, so the
// key goes from the card to graph-reader's set_key and never through the model. Each call reaches graph-reader with the
// person's own sign-in, so graph-reader's own check of an administrator decides it. graph-reader keeps the key in the
// Vault and gives it back in no answer. These tools give back none of graph-reader's own words: each answer is one of
// the fixed reasons below, so no text from graph-reader or Anthropic, and no key, reaches the person or the model.
//
// Save and Turn off are app-only, but Claude's keeping them from the model is no boundary. So show_connections_setup
// gives the card a pass in its result's _meta, which the host gives the card and not the model: the person's account,
// this card and a time 15 minutes on, signed with a key made from the function's own database address. Save and Turn
// off refuse a call without a pass for the person that is still in time, before graph-reader is called.
import { z } from "npm:zod@4.3.6";
import { answer, type Ctx, refused, type Result, type Tool, tool } from "./tool.ts";
import { appTool, cardUri } from "./cards.ts";

/** What a person reads when graph-reader refuses their sign-in. */
export const ADMINISTRATORS_ONLY = "Only an administrator turns connections on or off.";
/** What a person reads when graph-reader couldn't confirm their sign-in. */
export const SIGN_IN_AGAIN = "fabrik couldn't confirm your sign-in. Sign in again, then try again.";
/** What a person reads when graph-reader wants the code from their authenticator app. */
export const SECOND_FACTOR = "Sign in with a code from your authenticator app, then try again.";
/** What a person reads when graph-reader couldn't read the Vault. */
export const BUSY = "fabrik is busy. Try again in a minute.";
/** What a person reads when the text typed isn't an Anthropic API key. */
export const NOT_A_KEY = "That isn't an Anthropic API key, which starts sk-ant-. Nothing was kept.";
/** What a person reads when Anthropic refuses the key typed. */
export const ANTHROPIC_REFUSED = "Anthropic refused the new key. Nothing was kept.";
/** What a person reads when Anthropic didn't answer. */
export const ANTHROPIC_SILENT = "Anthropic didn't answer. Try again in a minute.";
/** What a person reads for any other answer from graph-reader. */
export const FAILED = "fabrik couldn't finish that. Try again, and if it happens again, ask for support.";
/** What Save and Turn off answer a call without the card's pass, or with one out of time. */
export const CARD_ONLY = "Only the connections card turns connections on or off, and this one has expired. Show the connections card again.";

type Reply = { status: number; body: Record<string, unknown> | null };

/** One call to graph-reader as the person. */
async function reader(ctx: Ctx, args: Record<string, unknown>): Promise<Reply> {
  const res = await ctx.project("/functions/v1/graph-reader", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body: body && typeof body === "object" ? body as Record<string, unknown> : null };
}

/** graph-reader's refusal, in words a person reads: one of the fixed reasons above, and never graph-reader's own words.
 * key is given on Save, where a 400 means the text typed isn't a key. */
export function reason(got: Reply, key?: string): string {
  if (got.status === 401) return SIGN_IN_AGAIN;
  if (got.status === 403) return got.body?.second_factor === true ? SECOND_FACTOR : ADMINISTRATORS_ONLY;
  if (got.status === 503) return BUSY;
  if (got.status === 400 && key !== undefined) return NOT_A_KEY;
  if (got.status === 422 && key !== undefined) return ANTHROPIC_REFUSED;
  if (got.status === 502) return key !== undefined ? `${ANTHROPIC_SILENT} Nothing was kept.` : ANTHROPIC_SILENT;
  console.error(`connections: graph-reader answered ${got.status}`);
  return FAILED;
}

// ---- The card's pass ----

/** How long a pass lasts. */
export const PASS_LIFE_MS = 15 * 60_000;
const PASS_FOR = "connections-setup";
const bytes = new TextEncoder();
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

/** The key that signs passes, made from the function's database address, which only the function holds. */
async function passKey(): Promise<CryptoKey | null> {
  const secret = Deno.env.get("SUPABASE_DB_URL");
  if (!secret) return null;
  return await crypto.subtle.importKey("raw", bytes.encode(`fabrik connections card pass\n${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** A pass for the person's connections card, good until PASS_LIFE_MS from now, or null without a person or a key. */
export async function issuePass(person: string | undefined, now = Date.now()): Promise<string | null> {
  const k = await passKey();
  if (!person || !k) return null;
  const body = b64(bytes.encode(JSON.stringify({ p: person, c: PASS_FOR, e: now + PASS_LIFE_MS })));
  return `${body}.${b64(new Uint8Array(await crypto.subtle.sign("HMAC", k, bytes.encode(body))))}`;
}

/** Whether a pass is signed by this function, for this person and this card, and still in time. */
export async function passHolds(pass: unknown, person: string | undefined, now = Date.now()): Promise<boolean> {
  const k = await passKey();
  if (!person || !k || typeof pass !== "string" || pass.length > 1000) return false;
  const [body, sig, extra] = pass.split(".");
  if (!body || !sig || extra !== undefined) return false;
  try {
    if (!await crypto.subtle.verify("HMAC", k, unb64(sig), bytes.encode(body))) return false;
    const got = JSON.parse(new TextDecoder().decode(unb64(body)));
    return got?.p === person && got?.c === PASS_FOR && typeof got?.e === "number" && now < got.e;
  } catch {
    return false;
  }
}

type State = "on" | "off" | "refused" | "unknown";

/** Whether connections are on: on with a key Anthropic takes, off with none, refused with one it no longer takes, and
 * unknown when Anthropic or fabrik didn't answer, with the reason. Only a refused sign-in keeps the card closed, so an
 * administrator can still turn connections off or type a new key while Anthropic is down. */
async function state(ctx: Ctx): Promise<{ state: State; problem?: string } | Result> {
  const got = await reader(ctx, { action: "check" });
  if (got.status === 401 || got.status === 403) return refused(reason(got));
  if (got.status !== 200 || got.body?.ok !== true) return { state: "unknown", problem: reason(got) };
  const key = got.body.key;
  return { state: key === "available" ? "on" : key === "refused" ? "refused" : "off" };
}

/** What the card and Claude say for each state. The card takes these from show_connections_setup's result. */
export const SAID: Record<State, string> = {
  on: "Connections are on.",
  off: "Connections are off.",
  refused: "Anthropic no longer takes the business's key, so fabrik reads no parts. Type a new key.",
  unknown: "fabrik couldn't ask Anthropic whether the key works.",
};

const showConnectionsSetup = tool({
  name: "show_connections_setup",
  description: "Show the connections card, which says whether connections are on. On it an administrator types the business's Anthropic API key " +
    "to turn connections on, or turns them off. The card checks the key with Anthropic before fabrik keeps it, and shows connected, or the reason Anthropic gave. " +
    "The key goes from the card into the project's Vault: never ask for it in the chat, and never pass it here. Administrators only.",
  input: z.object({}),
  meta: { ui: { resourceUri: cardUri("connections-setup") } },
  run: async (ctx) => {
    const now = await state(ctx);
    if ("content" in now) return now;
    const said = now.problem ? `${SAID[now.state]} ${now.problem}` : SAID[now.state];
    const pass = await issuePass(ctx.person);
    return {
      content: [{ type: "text", text: `The connections card is shown. ${said} The person types the key on the card. ` +
        "End the turn here; once they say the card shows connected, fabrik reads the waiting parts usually within an hour, and at most a day." }],
      structuredContent: { card: "connections-setup", state: now.state, ...(now.problem ? { problem: now.problem } : {}), said: SAID },
      ...(pass ? { _meta: { pass } } : {}),
    };
  },
});

const connectionsSetupSave = appTool(["connections-setup"], {
  name: "connections_setup_save",
  description: "Keep the Anthropic API key typed on the connections card, once Anthropic takes it, which turns connections on. " +
    "Answers connected, or the reason nothing was kept. Never the key.",
  input: z.object({ key: z.string(), pass: z.string().optional() }),
  run: async (ctx, { key, pass }) => {
    if (!await passHolds(pass, ctx.person)) return refused(CARD_ONLY);
    const got = await reader(ctx, { action: "set_key", key });
    if (got.status === 200 && got.body?.ok === true) return { content: [{ type: "text", text: "connected" }] };
    return refused(reason(got, key.trim()));
  },
});

const connectionsOff = appTool(["connections-setup"], {
  name: "connections_off",
  description: "Remove the business's Anthropic API key, which turns connections off. The connections fabrik already keeps stay.",
  input: z.object({ pass: z.string().optional() }),
  run: async (ctx, { pass }) => {
    if (!await passHolds(pass, ctx.person)) return refused(CARD_ONLY);
    const got = await reader(ctx, { action: "remove_key" });
    if (got.status === 200 && got.body?.ok === true) return answer({ state: "off" });
    return refused(reason(got));
  },
});

/** The connections tools, in the order Claude lists them. */
export const CONNECTIONS_TOOLS: Tool[] = [showConnectionsSetup, connectionsSetupSave, connectionsOff];
