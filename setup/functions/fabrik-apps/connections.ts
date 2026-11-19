// Connections, on the connections card: an administrator turns them on by typing the business's Anthropic API key, and
// turns them off. show_connections_setup shows the card with whether connections are on, from graph-reader's check.
// The card's Save calls connections_setup_save, and its Turn off calls connections_off, both through card_call, so the
// key goes from the card to graph-reader's set_key and never through the model. Each call reaches graph-reader with the
// person's own sign-in, so graph-reader's own check of an administrator decides it. graph-reader keeps the key in the
// Vault and gives it back in no answer. These tools give back none of graph-reader's words that name it, and take each
// Anthropic key, the one typed or any other, out of any text they pass on.
import { z } from "npm:zod@4.3.6";
import { answer, type Ctx, refused, type Result, type Tool, tool } from "./tool.ts";
import { appTool, cardUri } from "./cards.ts";

/** What a person reads when graph-reader refuses their sign-in. */
export const ADMINISTRATORS_ONLY = "Only an administrator turns connections on or off.";
/** What a person reads when graph-reader couldn't confirm their sign-in. */
export const SIGN_IN_AGAIN = "fabrik couldn't confirm your sign-in. Sign in again, then try again.";

type Reply = { status: number; body: Record<string, unknown> | null };

/** One call to graph-reader as the person. */
async function reader(ctx: Ctx, args: Record<string, unknown>): Promise<Reply> {
  const res = await ctx.project("/functions/v1/graph-reader", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(args),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body: body && typeof body === "object" ? body as Record<string, unknown> : null };
}

/** graph-reader's refusal, in words a person reads: a sign-in it couldn't confirm, a missing second factor and a
 * person who isn't an administrator in fabrik's own words, and any other reason with the key taken out. */
export function reason(got: Reply, key?: string): string {
  if (got.status === 401) return SIGN_IN_AGAIN;
  if (got.status === 403) return got.body?.second_factor === true ? String(got.body.problem) : ADMINISTRATORS_ONLY;
  if (got.status === 503) return "fabrik is busy. Try again in a minute.";
  if (got.status === 400 && key !== undefined) return "That isn't an Anthropic API key, which starts sk-ant-. Nothing was kept.";
  const said = String(got.body?.problem ?? `fabrik answered ${got.status}.`);
  return (key ? said.replaceAll(key, "[key]") : said).replace(/sk-ant-[A-Za-z0-9_-]+/g, "[key]");
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
    return {
      content: [{ type: "text", text: `The connections card is shown. ${said} The person types the key on the card. ` +
        "End the turn here; once they say the card shows connected, fabrik reads the waiting parts within a day." }],
      structuredContent: { card: "connections-setup", state: now.state, ...(now.problem ? { problem: now.problem } : {}), said: SAID },
    };
  },
});

const connectionsSetupSave = appTool(["connections-setup"], {
  name: "connections_setup_save",
  description: "Keep the Anthropic API key typed on the connections card, once Anthropic takes it, which turns connections on. " +
    "Answers connected, or the reason nothing was kept. Never the key.",
  input: z.object({ key: z.string() }),
  run: async (ctx, { key }) => {
    const got = await reader(ctx, { action: "set_key", key });
    if (got.status === 200 && got.body?.ok === true) return { content: [{ type: "text", text: "connected" }] };
    return refused(reason(got, key.trim()));
  },
});

const connectionsOff = appTool(["connections-setup"], {
  name: "connections_off",
  description: "Remove the business's Anthropic API key, which turns connections off. The connections fabrik already keeps stay.",
  input: z.object({}),
  run: async (ctx) => {
    const got = await reader(ctx, { action: "remove_key" });
    if (got.status === 200 && got.body?.ok === true) return answer({ state: "off" });
    return refused(reason(got));
  },
});

/** The connections tools, in the order Claude lists them. */
export const CONNECTIONS_TOOLS: Tool[] = [showConnectionsSetup, connectionsSetupSave, connectionsOff];
