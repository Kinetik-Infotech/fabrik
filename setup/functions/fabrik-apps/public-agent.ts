// The public agent's tools: the chat box on the owner's website, which the public-agent hosted function answers from
// KNOWLEDGE.md. Each tool calls public-agent with the person's own sign-in, so the function's own check of an
// administrator decides it. The function keeps the file in its private bucket, and the settings in fabrik_private, where
// no signed-in person reaches them directly.
//
// The Anthropic API key and the Turnstile keys go from the public agent card through card_call, as on the
// connections card. They never pass through the model. show_public_agent_setup gives the card a pass in its result's
// _meta, signed as connections.ts signs the connections card's. Save and Turn off refuse a call without a pass in time.
//
// A refused sign-in gets fixed words. A refused key gets public-agent's own sentence, which holds no key.
import { z } from "npm:zod@4.3.6";
import { answer, type Ctx, refused, type Result, type Tool, tool } from "./tool.ts";
import { appTool, cardUri } from "./cards.ts";
import { issuePass, passHolds } from "./connections.ts";

const CARD = "public-agent-setup";
export const ADMINISTRATORS_ONLY = "Only an administrator sets up the public agent.";
export const SIGN_IN_AGAIN = "fabrik couldn't confirm your sign-in. Sign in again, then try again.";
export const SECOND_FACTOR = "Sign in with a code from your authenticator app, then try again.";
export const BUSY = "fabrik is busy. Try again in a minute.";
export const FAILED = "fabrik couldn't finish that. Try again, and if it happens again, ask for support.";
export const CARD_ONLY = "Only the public agent card sets its keys, and this one has expired. Show the public agent card again.";
export const NOTHING_TYPED = "Type the Anthropic API key or the Turnstile keys. Nothing was kept.";

type Reply = { status: number; body: Record<string, unknown> | null };

/** One call to public-agent as the person. */
async function agent(ctx: Ctx, args: Record<string, unknown>): Promise<Reply> {
  const res = await ctx.project("/functions/v1/public-agent", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body: body && typeof body === "object" ? body as Record<string, unknown> : null };
}

/** public-agent's refusal of the person's sign-in, or of a call, in fixed words. A 400 or 422 carries public-agent's own
 * sentence, which names what to give and never holds a key. */
function reason(got: Reply, said = false): string {
  if (got.status === 401) return SIGN_IN_AGAIN;
  if (got.status === 403) return got.body?.second_factor === true ? SECOND_FACTOR : ADMINISTRATORS_ONLY;
  if (got.status === 503) return BUSY;
  if (said && (got.status === 400 || got.status === 422 || got.status === 502) && typeof got.body?.problem === "string") return got.body.problem;
  console.error(`public-agent tools: public-agent answered ${got.status}`);
  return FAILED;
}

/** A call's answer, or its refusal. */
async function run(ctx: Ctx, args: Record<string, unknown>, more: Record<string, unknown> = {}): Promise<Result> {
  const got = await agent(ctx, args);
  if (got.status !== 200 || got.body?.ok !== true) return refused(reason(got, true));
  const { ok: _, ...rest } = got.body;
  return answer({ ...rest, ...more });
}

/** The chat page's host name, such as fabrik-chat-abc.pages.dev, from its address, or null when it isn't one. */
export const pageHost = (page?: string) => {
  const m = /^https:\/\/([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+)\/?$/.exec(String(page ?? "").trim().toLowerCase());
  return m ? m[1] : null;
};

/** The address a website's chat box posts to. */
const address = () => `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/public-agent`;

/** What the card and Claude say for each state of the key. */
export const SAID: Record<string, string> = {
  available: "The public agent's Anthropic API key works.",
  missing: "The public agent has no Anthropic API key.",
  refused: "Anthropic no longer takes the public agent's key. Type a new key.",
  unknown: "fabrik couldn't ask Anthropic whether the key works.",
};

const showSetup = tool({
  name: "show_public_agent_setup",
  description: "Show the public agent card, which says whether the chat box on the owner's website has its Anthropic API key, its " +
    "Cloudflare Turnstile site key and secret key, and its KNOWLEDGE.md. On it an administrator types the keys, or turns the chat box off. " +
    "The card checks each key before fabrik keeps it. The keys go from the card into the project's Vault: never ask for them in " +
    "the chat, and never pass them here. Administrators only.",
  input: z.object({ page: z.string().optional().describe("The chat page's address, which fabrik chat-page printed, such as https://fabrik-chat-<ref>.pages.dev. The card names it as the Turnstile widget's hostname.") }),
  meta: { ui: { resourceUri: cardUri(CARD) } },
  run: async (ctx, { page }) => {
    const got = await agent(ctx, { action: "check" });
    if (got.status === 401 || got.status === 403) return refused(reason(got));
    const ok = got.status === 200 && got.body?.ok === true;
    const state = {
      key: ok ? String(got.body!.key) : "unknown",
      turnstile: ok ? String(got.body!.turnstile) : "unknown",
      sitekey: ok ? String(got.body!.sitekey) : "unknown",
      knowledge: ok ? got.body!.knowledge === true : null,
    };
    const pass = await issuePass(ctx.person, Date.now(), CARD);
    return {
      content: [{ type: "text", text: `The public agent card is shown. ${SAID[state.key] ?? ""} The Turnstile secret key is ${state.turnstile}, and its site key ${state.sitekey}. ` +
        `KNOWLEDGE.md is ${state.knowledge === true ? "saved" : state.knowledge === false ? "not saved yet" : "unknown"}. ` +
        "The person types the keys on the card. End the turn here." }],
      structuredContent: { card: CARD, ...state, said: SAID, address: address(), ...(pageHost(page) ? { page_host: pageHost(page) } : {}) },
      ...(pass ? { _meta: { pass } } : {}),
    };
  },
});

const setupSave = appTool([CARD], {
  name: "public_agent_setup_save",
  description: "Keep the Anthropic API key and the Turnstile keys, as typed on the public agent card. Each is kept once " +
    "Anthropic or Cloudflare takes it. The site key and the secret key are kept together, once Cloudflare's siteverify takes the " +
    "secret key. Answers what was kept, or the reason nothing was. Never a key.",
  input: z.object({ key: z.string().optional(), secret: z.string().optional(), sitekey: z.string().optional(), pass: z.string().optional() }),
  run: async (ctx, { key, secret, sitekey, pass }) => {
    if (!await passHolds(pass, ctx.person, Date.now(), CARD)) return refused(CARD_ONLY);
    if (!key?.trim() && !secret?.trim() && !sitekey?.trim()) return refused(NOTHING_TYPED);
    const kept: string[] = [];
    if (key?.trim()) {
      const got = await agent(ctx, { action: "set_key", key });
      if (got.status !== 200) return refused(reason(got, true));
      kept.push("key");
    }
    if (secret?.trim() || sitekey?.trim()) {
      const got = await agent(ctx, { action: "set_turnstile", ...(secret?.trim() ? { secret } : {}), ...(sitekey?.trim() ? { sitekey } : {}) });
      if (got.status !== 200) return refused(`${kept.length ? "The Anthropic API key was kept. " : ""}${reason(got, true)}`);
      if (got.body?.turnstile === "set") kept.push("turnstile");
      if (got.body?.sitekey === "set") kept.push("sitekey");
    }
    return answer({ kept });
  },
});

const turnOff = appTool([CARD], {
  name: "public_agent_off",
  description: "Remove the public agent's Anthropic API key, which stops the chat box answering. KNOWLEDGE.md and the Turnstile keys stay.",
  input: z.object({ pass: z.string().optional() }),
  run: async (ctx, { pass }) => {
    if (!await passHolds(pass, ctx.person, Date.now(), CARD)) return refused(CARD_ONLY);
    const got = await agent(ctx, { action: "remove_key" });
    if (got.status === 200 && got.body?.ok === true) return answer({ key: "removed" });
    return refused(reason(got));
  },
});

const knowledgeGet = tool({
  name: "public_knowledge_get",
  description: "Read KNOWLEDGE.md, the one file the public agent answers the owner's website visitors from. Gives text, or null " +
    "when none is saved. Administrators only.",
  input: z.object({}),
  run: (ctx) => run(ctx, { action: "knowledge_get" }),
});

const knowledgeSave = tool({
  name: "public_knowledge_save",
  description: "Replace KNOWLEDGE.md, the one file the public agent answers the owner's website visitors from, with the Markdown " +
    "given, at most 100,000 characters. The file before it is not kept. Anything in it can reach any visitor. Administrators only.",
  input: z.object({ text: z.string() }),
  run: (ctx, { text }) => run(ctx, { action: "knowledge_save", text }),
});

const settings = tool({
  name: "public_agent_settings",
  description: "Read the public agent's settings: its model, its daily cap, today's tokens, the Turnstile site key, and the " +
    "address the chat page posts to. Once a day's tokens reach the cap, the chat box answers that it's resting until the next day, in UTC. " +
    "Administrators only.",
  input: z.object({}),
  run: (ctx) => run(ctx, { action: "settings" }, { address: address() }),
});

const changeSettings = tool({
  name: "public_agent_settings_change",
  description: "Change the public agent's model, a Claude model's id, or its daily_cap_tokens, from 1,000 to 100,000,000, or " +
    "both. Gives the settings after the change, as public_agent_settings does. Administrators only.",
  input: z.object({ model: z.string().optional(), daily_cap_tokens: z.number().int().optional() }),
  run: (ctx, args) => run(ctx, { action: "settings", ...args }, { address: address() }),
});

/** The public agent's tools, in the order Claude lists them. */
export const PUBLIC_AGENT_TOOLS: Tool[] = [showSetup, setupSave, turnOff, knowledgeGet, knowledgeSave, settings, changeSettings];
