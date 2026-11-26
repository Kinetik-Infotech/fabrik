// Shared logins, on the Login card. show_logins shows the card, which lists the shared logins the person may open with
// logins_list, from fabrik_find_logins, which gives no password. Choosing one calls login_open, fabrik_open_login as the
// person, and shows its password hidden, with Show and Copy. For an administrator, Add login and Change password take a
// typed or generated password, and Save calls login_save, fabrik_save_login. Remove calls login_remove,
// fabrik_remove_login, after the person confirms.
//
// logins_list, login_open, login_save and login_remove are for the card alone: Claude keeps them from the model, and
// card_call runs them for the Login card only. Claude's keeping them from the model is no boundary, so show_logins gives
// the card a pass in its result's _meta, which the host gives the card and not the model, signed as connections.ts signs
// the connections card's. Each of the four refuses a call without a pass for the person that is still in time, before
// fabrik is called. A password goes from the card to fabrik and back to the card: show_logins's result holds none, the
// card tells Claude nothing, and this file logs no tool's arguments or answer.
//
// The Data API refuses fabrik_open_login and fabrik_save_login to every token, the person's own included, so an agent
// holding the person's sign-in can call neither. login_open and login_save call them over this function's own database
// connection, SUPABASE_DB_URL, which no agent holds, in a transaction that carries the person's account and sign-in
// level from the request's verified token, so fabrik decides as it would for the person. The fabrik plugin's
// login-guard hook also refuses every agent the calls that name them.
import postgres from "npm:postgres@3.4.9";
import { z } from "npm:zod@4.3.6";
import { allScopes, type Ctx, refused, type Result, type Tool, tool } from "./tool.ts";
import { appTool, cardUri } from "./cards.ts";
import { issuePass, passHolds } from "./connections.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CARD = "login";
/** What the card's tools answer a call without the card's pass, or with one out of time. */
export const CARD_ONLY = "Only the Login card lists, opens and changes shared logins, and this one has expired. Show the Login card again.";
const passArg = z.string().optional();

/** A fabrik answer for the card, with its refusal as the tool's error, and only a line of text for Claude. */
// deno-lint-ignore no-explicit-any
function cardAnswer(data: any, said: (data: Record<string, unknown>) => string): Result {
  if (data && typeof data === "object" && data.refused === true) return refused(String(data.problem ?? "fabrik refused it."));
  return { content: [{ type: "text", text: said(data ?? {}) }], structuredContent: data ?? {} };
}

/** One fabrik function's answer through the Data API as the person, for the card. */
async function forCard(ctx: Ctx, fn: string, args: Record<string, unknown>, said: (data: Record<string, unknown>) => string): Promise<Result> {
  const { data, error } = await ctx.fabrik.rpc(fn, args);
  return error ? refused(error.message) : cardAnswer(data, said);
}

let sql: ReturnType<typeof postgres> | null = null;
const db = () => sql ??= postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false, idle_timeout: 1, connection: { application_name: "fabrik-apps logins" } });

/** One call over this function's own connection, as the person the request's token names, at its sign-in level. Its
 * refusal is fabrik's own sentence, which names no value given. */
// deno-lint-ignore no-explicit-any
async function asPerson(ctx: Ctx, call: (tx: any) => Promise<any>, said: (data: Record<string, unknown>) => string): Promise<Result> {
  if (!ctx.person) return refused("fabrik couldn't confirm your sign-in. Sign in again, then try again.");
  let data: unknown;
  try {
    data = await db().begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ctx.person, role: "authenticated", aal: ctx.aal ?? "aal1" })}, true)`;
      return (await call(tx))[0]?.r ?? null;
    });
  } catch (error) {
    return refused(String((error as Error)?.message ?? "fabrik couldn't finish that."));
  }
  return cardAnswer(data, said);
}

const showLogins = tool({
  name: "show_logins",
  description: "Show the Login card, as the records skill's \"Shared logins\" describes. The card lists the shared logins the signed-in person " +
    "may open, and shows a login's password to the person alone, with a copy button. An administrator adds a login, changes its password " +
    "and removes it on the card. A password is typed, generated and read on the card alone: never ask for one in the chat, never repeat one, " +
    "and never pass one here. After the card is shown, end the turn with no question.",
  input: z.object({}),
  meta: { ui: { resourceUri: cardUri("login") } },
  run: async (ctx) => {
    const pass = await issuePass(ctx.person, Date.now(), CARD);
    return {
      content: [{ type: "text", text: "The Login card is shown. End the turn with no question." }],
      structuredContent: { card: CARD },
      ...(pass ? { _meta: { pass } } : {}),
    };
  },
});

const loginsList = appTool(["login"], {
  name: "logins_list",
  description: "List the shared logins the signed-in person may open, without passwords, for the Login card, and for an administrator the " +
    "scopes a login may be kept in: each enabled and not private.",
  input: z.object({ pass: passArg }),
  run: async (ctx, { pass }) => {
    if (!await passHolds(pass, ctx.person, Date.now(), CARD)) return refused(CARD_ONLY);
    const { data, error } = await ctx.fabrik.rpc("fabrik_find_logins", {});
    if (error) return refused(error.message);
    const administrator = data?.administrator === true;
    const scopes: { scope_id: string; name: string }[] = [];
    if (administrator) {
      const all = await allScopes(ctx);
      if (typeof all === "string") return refused(all);
      for (const s of all) if (s.enabled !== false && s.is_private !== true) scopes.push({ scope_id: s.scope_id, name: s.display_name });
      scopes.sort((a, b) => a.name.localeCompare(b.name));
    }
    const logins = data?.logins ?? [];
    return { content: [{ type: "text", text: `${logins.length} logins.` }], structuredContent: { administrator, logins, scopes } };
  },
});

const loginOpen = appTool(["login"], {
  name: "login_open",
  description: "Open one shared login as the signed-in person, with fabrik_open_login, for the Login card.",
  input: z.object({ login_id: z.string().regex(UUID), pass: passArg }),
  run: async (ctx, { login_id, pass }) => {
    if (!await passHolds(pass, ctx.person, Date.now(), CARD)) return refused(CARD_ONLY);
    return asPerson(ctx, (tx) => tx`select fabrik.fabrik_open_login(${login_id}) as r`, () => "The login is open on the card.");
  },
});

const loginSave = appTool(["login"], {
  name: "login_save",
  description: "Add a shared login, or change its password, as the signed-in administrator, with fabrik_save_login, for the Login card.",
  input: z.object({
    login_id: z.string().regex(UUID).optional(),
    scope: z.string().max(200).optional(),
    service: z.string().max(200).optional(),
    web_address: z.string().max(2000).optional(),
    username: z.string().max(320).optional(),
    notes: z.string().max(2000).optional(),
    password: z.string().min(1).max(256),
    pass: passArg,
  }),
  run: async (ctx, a) => {
    if (!await passHolds(a.pass, ctx.person, Date.now(), CARD)) return refused(CARD_ONLY);
    return asPerson(ctx, (tx) => tx`select fabrik.fabrik_save_login(${a.login_id ?? null}::uuid, ${a.scope ?? null}, ${a.service ?? null},
      ${a.web_address ?? null}, ${a.username ?? null}, ${a.notes ?? null}, ${a.password}) as r`, (d) => `The login is ${d.saved}.`);
  },
});

const loginRemove = appTool(["login"], {
  name: "login_remove",
  description: "Remove a shared login, with its passwords, as the signed-in administrator, with fabrik_remove_login, for the Login card.",
  input: z.object({ login_id: z.string().regex(UUID), pass: passArg }),
  run: async (ctx, { login_id, pass }) => {
    if (!await passHolds(pass, ctx.person, Date.now(), CARD)) return refused(CARD_ONLY);
    return forCard(ctx, "fabrik_remove_login", { p_login: login_id }, () => "The login is removed.");
  },
});

/** The shared login tools, in the order Claude lists them. */
export const LOGIN_TOOLS: Tool[] = [showLogins, loginsList, loginOpen, loginSave, loginRemove];
