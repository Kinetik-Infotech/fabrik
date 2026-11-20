// fabrik's cards: the records card, the board card, the graph card, the mail setup card and the connections card, each an
// MCP App that Claude draws in the conversation. show_records, show_board, show_graph, mail.ts's show_mail_setup and
// connections.ts's show_connections_setup show them.
//
// Each card's address, ui://fabrik-apps/<card>.html, serves the shell: a small fixed page, the same for every card but
// for its card's name. The shell speaks the MCP Apps protocol to Claude over postMessage: ui/initialize, the host's
// style variables and theme, and the card's height. When it opens, it calls card_page with its card's name and its own
// version, and draws the page card_page gives: its style, its body and its script, made from card.ts, which
// make-card.ts writes from plugins/fabrik/cards. It holds each notification Claude sends before the page is drawn, such
// as the tool's result, and passes each to the page once it is drawn, in order. Every button on a page calls card_call,
// which runs one of the app-only tools named for that card, as the signed-in person. So a change to a page, or to what
// an app-only tool does, reaches each person at their next card, with no reconnect. card_page refuses a shell of
// another version, asking the person to reconnect. Where fabrik holds the business's Brand record and the person may read
// it, card_page gives the page brand.ts's accent, fonts and logo; otherwise the page is the kit's as it is.
//
// A card's page can call any tool the person can, through the host, save_record and upload_file among them, as the
// person. So every value from fabrik is escaped on every page, and the rule in card_call that keeps a card to its own
// tools is tidiness, not a boundary. The stand-in opens the records, board and graph cards on a record whose title holds
// markup.
//
// The mail setup card's one tool, mail.ts's mail_setup_save, saves a mailbox and its password; the password goes from
// the card through card_call, never through the model. The connections card's two tools, connections.ts's
// connections_setup_save and connections_off, keep and remove the business's Anthropic API key in the same way, each only
// with the pass show_connections_setup gives the card in its result's _meta. The public agent card's two tools,
// public-agent.ts's public_agent_setup_save and public_agent_off, keep and remove the public agent's keys the same way.
// The other cards' tools write nothing. They read fabrik through
// three app-only tools, which Claude keeps from the model: card_find_records (fabrik_find_records, with the scopes'
// names from fabrik_get_scopes), card_record (fabrik_show_record) and card_view, which gives a board or graph its data:
// a plan's activities from fabrik_get_progress, every page of the plan's scope at one save number, as the board and
// graph skills read them; a model record from fabrik_show_record; or, for a board with no record, the person's newest
// records.
import type { McpServer } from "npm:@modelcontextprotocol/server@2.4.0";
import { z } from "npm:zod@4.3.6";
import { type Brand, cardStyle, FONT_DOMAINS, logoHtml, readBrand } from "./brand.ts";
import { CARDS } from "./card.ts";
import { allScopes, answer, call, type Ctx, refused, type Result, scopeIn, scopeOf, type Tool, tool, VERSION } from "./tool.ts";

/** The resource type Claude draws as an MCP App. */
export const CARD_TYPE = "text/html;profile=mcp-app";
/** The shell's version. card_page refuses a shell of another version. */
export const SHELL_VERSION = 1;
/** The cards, by the name each shell gives card_page. */
export const CARD_NAMES = ["records", "board", "graph", "mail-setup", "connections-setup", "public-agent-setup"] as const;
export type Card = typeof CARD_NAMES[number];
/** A card's address. */
export const cardUri = (card: Card) => `ui://fabrik-apps/${card}.html`;
/** The _meta of a tool only a card calls, which Claude keeps from the model. */
export const forCard = { ui: { visibility: ["app"] } };

/** Each app-only tool, with the cards whose pages may call it through card_call. */
const APP_TOOLS = new Map<string, { tool: Tool; cards: readonly Card[] }>();
/** Declares a tool only a card calls: Claude keeps it from the model, and card_call runs it for the cards named. */
// deno-lint-ignore no-explicit-any
export function appTool<S extends z.ZodObject<any>>(cards: readonly Card[], t: Omit<Tool<S>, "meta">): Tool {
  const made = tool({ ...t, meta: forCard });
  APP_TOOLS.set(t.name, { tool: made, cards });
  return made;
}

// ---- The shell ----

// The shell's client for the MCP Apps protocol. window.card is what a page uses: card.call runs an app-only tool through
// card_call, and card.on takes a notification from Claude, such as ui/notifications/tool-result.
const BRIDGE = `
var waiting = {}, lastId = 0, handlers = {}, held = [], drawn = false;
function post(m) { m.jsonrpc = "2.0"; window.parent.postMessage(m, "*"); }
function ask(method, params) {
  var id = ++lastId;
  return new Promise(function (resolve, reject) { waiting[id] = { resolve: resolve, reject: reject }; post({ id: id, method: method, params: params }); });
}
function themed(context) {
  var vars = (context && context.styles && context.styles.variables) || {};
  Object.keys(vars).forEach(function (k) { if (vars[k]) document.documentElement.style.setProperty(k, vars[k]); });
  if (context && context.theme) document.documentElement.style.colorScheme = context.theme;
}
function deliver(m) { if (handlers[m.method]) handlers[m.method](m.params || {}); }
window.addEventListener("message", function (e) {
  var m = e.data;
  if (e.source !== window.parent || !m || m.jsonrpc !== "2.0") return;
  if (!m.method) {
    var w = waiting[m.id];
    if (!w) return;
    delete waiting[m.id];
    if (m.error) w.reject(new Error(m.error.message || "Claude refused the call.")); else w.resolve(m.result);
    return;
  }
  if (m.id !== undefined) { post({ id: m.id, result: {} }); return; }
  if (m.method === "ui/notifications/host-context-changed") { themed(m.params); return; }
  if (drawn) deliver(m); else held.push(m);
});
var ready = ask("ui/initialize", {
  appInfo: { name: "fabrik-apps", version: VERSION },
  appCapabilities: {},
  protocolVersion: "2026-01-26",
}).then(function (r) { themed(r && r.hostContext); post({ method: "ui/notifications/initialized", params: {} }); });
window.card = {
  name: CARD,
  call: function (name, args) {
    return ready.then(function () { return ask("tools/call", { name: "card_call", arguments: { card: CARD, name: name, arguments: args || {} } }); });
  },
  on: function (method, handler) { handlers[method] = handler; },
};
new ResizeObserver(function () {
  post({ method: "ui/notifications/size-changed", params: { height: Math.ceil(document.documentElement.getBoundingClientRect().height) } });
}).observe(document.documentElement);
function shellLine(text) { var p = document.getElementById("card-shell"); if (!p) { document.body.insertAdjacentHTML("afterbegin", '<p id="card-shell"></p>'); p = document.getElementById("card-shell"); } p.textContent = text; }
ready.then(function () { return ask("tools/call", { name: "card_page", arguments: { card: CARD, shell: SHELL } }); }).then(function (r) {
  var page = r && !r.isError && r.structuredContent;
  if (!page) { shellLine(((r && r.content) || []).map(function (c) { return c.text || ""; }).join(" ") || "fabrik gave no card."); return; }
  document.getElementById("card-style").textContent = page.style;
  document.body.innerHTML = page.body;
  var script = document.createElement("script"), error = null;
  script.textContent = page.script + "\\n;window.cardDrawn = true;";
  function caught(e) { if (!error) error = e.error || { message: e.message }; }
  window.addEventListener("error", caught);
  try { document.body.appendChild(script); } finally { window.removeEventListener("error", caught); }
  if (!window.cardDrawn) { shellLine(error ? "The card stopped with an error: " + (error.message || String(error)) : "The card's script did not run here."); return; }
  drawn = true;
  held.splice(0).forEach(deliver);
}).catch(function (e) { shellLine("fabrik could not open the card: " + e.message); });
`;

/** The page a card's address serves: the bridge and the card's name. It asks card_page for the card's page, and draws it. */
export function shell(card: Card): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><style id="card-style">
body { margin: 0; padding: 0 4px; font-family: var(--font-sans, system-ui, sans-serif); color: var(--color-text-primary, CanvasText); background: transparent; }
</style></head><body><p id="card-shell">Opening the card…</p>
<script>
"use strict";
var CARD = ${JSON.stringify(card)}, SHELL = ${SHELL_VERSION}, VERSION = ${JSON.stringify(VERSION)};
${BRIDGE}</script></body></html>`;
}

// ---- The pages ----

/** A card's page, as card_page gives it to the shell. */
export type Page = { style: string; body: string; script: string };

/** A card file's style, its markup and its script. */
function partsOf(html: string) {
  const style = /<style>\n?([\s\S]*?)<\/style>/.exec(html)?.[1] ?? "";
  const script = /<script>\n?([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  const body = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<script>[\s\S]*?<\/script>/, "").trim();
  return { style, body, script };
}

/** A card's page: the kit's style and then the card's, the card's markup, and one script, the kit's code and then the
 * card's, in a function of its own so its names stay apart from the shell's. */
export function pageOf(card: Card): Page {
  const kit = partsOf(CARDS.kit), own = partsOf(CARDS[card]);
  return { style: kit.style + own.style, body: own.body, script: `"use strict";\n(function () {\n${kit.script}\n${own.script}\n})();\n` };
}
const PAGES = Object.fromEntries(CARD_NAMES.map((c) => [c, pageOf(c)])) as Record<Card, Page>;

/** A card's page in the business's brand: the fonts' @import first, the brand's tokens after the kit's and the card's
 * style, and the logo at the start of the card's first header. */
export function brandedPage(page: Page, brand: Brand | null): Page {
  if (!brand) return page;
  const { imports, css } = cardStyle(brand), logo = logoHtml(brand);
  return {
    style: imports + page.style + css,
    body: logo ? page.body.replace('<div class="fk-head">', () => `<div class="fk-head">${logo}`) : page.body,
    script: page.script,
  };
}

const cardPage = tool({
  name: "card_page",
  description: "Give a fabrik card's current page, its style, its markup and its script, for the card's shell. Each card calls it when it opens.",
  input: z.object({ card: z.string(), shell: z.number() }),
  meta: forCard,
  run: async (ctx, { card, shell: version }) => {
    if (version !== SHELL_VERSION) {
      return refused("This card is from another version of the fabrik connector. Reconnect fabrik in Claude's Connectors, and show the card again.");
    }
    if (!(CARD_NAMES as readonly string[]).includes(card)) return refused(`fabrik has no card named ${card}.`);
    const brand = await readBrand(ctx).catch(() => null);
    return { content: [{ type: "text", text: `The ${card} card's page.` }], structuredContent: brandedPage(PAGES[card as Card], brand) };
  },
});

const cardCall = tool({
  name: "card_call",
  description: "Run one of the tools a fabrik card's page calls, as the signed-in person, with its arguments. Each card's buttons call it.",
  input: z.object({ card: z.enum(CARD_NAMES), name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }),
  meta: forCard,
  run: (ctx, { card, name, arguments: args }) => {
    const found = APP_TOOLS.get(name);
    if (!found || !found.cards.includes(card)) return Promise.resolve(refused(`${name} is not a tool the ${card} card calls.`));
    const parsed = found.tool.input.safeParse(args ?? {});
    if (!parsed.success) {
      return Promise.resolve(refused(`${name}'s arguments are not as it takes them: ${parsed.error.issues.map((i) => `${i.path.join(".") || "arguments"} ${i.message}`).join("; ")}.`));
    }
    return found.tool.run(ctx, parsed.data);
  },
});

// ---- What the cards read ----

const KIND = z.enum(["activity", "decision", "evidence", "model"]);

const cardFindRecords = appTool(["records"], {
  name: "card_find_records",
  description: "Find fabrik records for the records card, 25 a page, newest save first, by kind, scope and words of the title, with each scope's name.",
  input: z.object({
    kind: KIND.optional(),
    scope: z.string().min(1).optional(),
    title: z.string().optional(),
    cutoff: z.number().int().min(0).optional(),
    cursor: z.number().int().min(1).optional(),
  }),
  run: async (ctx, a) => {
    // One read of the scopes both names the scope filtered on and gives each record its scope's name.
    const all = await allScopes(ctx);
    if (typeof all === "string") return refused(all);
    const known = all.map((s) => ({ scope_id: s.scope_id, name: s.display_name }));
    let scopeId: string | null = null;
    if (a.scope) {
      const found = scopeIn(all, a.scope);
      if (typeof found === "string") return refused(found);
      scopeId = found.scope_id;
    }
    const { data, error } = await ctx.fabrik.rpc("fabrik_find_records", {
      p_kind: a.kind ?? null, p_scope_id: scopeId, p_title: a.title?.trim() || null, p_cutoff: a.cutoff ?? null, p_cursor: a.cursor ?? null, p_limit: 25,
    });
    if (error) return refused(error.message);
    const name = new Map(known.map((s) => [s.scope_id, s.name]));
    // deno-lint-ignore no-explicit-any
    const items = (data?.items ?? []).map((r: any) => ({ ...r, scope_name: name.get(r.scope_id) ?? null }));
    return answer({ cutoff: data?.cutoff ?? null, next_cursor: data?.next_cursor ?? null, scope_id: scopeId, items, scopes: known });
  },
});

const cardRecord = appTool(["records", "board", "graph"], {
  name: "card_record",
  description: "Read one fabrik record at its latest version, with its fields and links, for a card's record panel.",
  input: z.object({ record: z.string().min(1) }),
  run: (ctx, { record }) => call(ctx, "fabrik_show_record", { p_record: record }),
});

/** At most this many pages of a scope's progress, 100 activities each, are read for one plan. */
const PROGRESS_PAGES = 20;

/** A noun with its article: an evidence record, a decision record. */
const article = (noun: string) => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;

/** Why a board or a graph draws nothing for a record that is neither a plan nor a model. */
// deno-lint-ignore no-explicit-any
const notDrawn = (r: any) => `"${r?.title}" is ${r?.kind === "activity" ? "a task" : article(`${r?.kind ?? "record"} record`)}. Name a plan or a model record.`;

/** The record a board or a graph is drawn for, a plan or a model, as fabrik_show_record gives it, or why it cannot be.
 * show_board, show_graph and card_view all decide by this alone. */
// deno-lint-ignore no-explicit-any
async function drawable(ctx: Ctx, record: string): Promise<{ view: "plan" | "model"; record: Record<string, any> } | string> {
  const { data: r, error } = await ctx.fabrik.rpc("fabrik_show_record", { p_record: record });
  if (error) return error.message;
  if (r?.kind === "model") return { view: "model", record: r };
  if (r?.kind === "activity" && r.payload?.activity_kind === "plan") return { view: "plan", record: r };
  return notDrawn(r);
}

/** What a board or a graph draws for a record: a plan's activities, or a model; or why it draws neither. */
// deno-lint-ignore no-explicit-any
async function viewOf(ctx: Ctx, record: string): Promise<Record<string, any> | string> {
  const found = await drawable(ctx, record);
  if (typeof found === "string" || found.view === "model") return found;
  const r = found.record;
  // Every page of the plan's scope, at the first page's save number and time, as the board skill reads them.
  // deno-lint-ignore no-explicit-any
  let cutoff: any = null, observed: any = null, cursor: any = null, pages = 0;
  // deno-lint-ignore no-explicit-any
  const items: any[] = [];
  do {
    if (++pages > PROGRESS_PAGES) return `"${r.title}"'s scope has more than ${PROGRESS_PAGES * 100} activities, too many for one card.`;
    const { data, error } = await ctx.fabrik.rpc("fabrik_get_progress", {
      p_cutoff: cutoff, p_observed_at: observed, p_cursor: cursor, p_limit: 100, p_scope_id: r.scope_id,
    });
    if (error) return error.message;
    cutoff = data.cutoff;
    observed = data.observed_at;
    items.push(...(data.items ?? []));
    cursor = data.next_cursor ?? null;
  } while (cursor);
  return { view: "plan", plan_id: r.record_id, scope_name: r.scope_name, cutoff, observed_at: observed, items };
}

const cardView = appTool(["board", "graph"], {
  name: "card_view",
  description: "Read what a fabrik board or graph card draws: a plan's activities, a model record, or, with no record, the person's newest records.",
  input: z.object({ record: z.string().min(1).optional() }),
  run: async (ctx, { record }) => {
    if (record) {
      const v = await viewOf(ctx, record);
      return typeof v === "string" ? refused(v) : answer(v);
    }
    const { data, error } = await ctx.fabrik.rpc("fabrik_find_records", {
      p_kind: null, p_scope_id: null, p_title: null, p_cutoff: null, p_cursor: null, p_limit: 100,
    });
    if (error) return refused(error.message);
    return answer({ view: "recent", cutoff: data?.cutoff ?? null, items: data?.items ?? [] });
  },
});

// ---- The tools that show the cards ----

const SHOWN = "Claude draws the card, which reads fabrik itself, as the signed-in person, and writes nothing. " +
  "Say in one line what the card shows; the person reads the rest on the card.";

/** The record a board or graph is drawn for, checked before the card is shown, or the refusal. */
async function shownFor(ctx: Ctx, record: string): Promise<{ record_id: string; title: string; kind: string } | Result> {
  const found = await drawable(ctx, record);
  if (typeof found === "string") return refused(found);
  return { record_id: found.record.record_id, title: found.record.title, kind: found.view };
}

const RECORD_NAME = "A record is named by its record_id, or by its exact title in any case among the records the person may read.";

const showRecords = tool({
  name: "show_records",
  description: "Show the records card: a list of the fabrik records the signed-in person may read, newest save first, with filters for kind, " +
    "scope and words of the title. Each record opens to its fields and links on the card, and a link opens the record it goes to. " + SHOWN,
  input: z.object({
    kind: KIND.optional().describe("Only records of this kind."),
    scope: z.string().min(1).optional().describe("Only records in this scope, by its scope_id, code or name, from list_scopes."),
    title: z.string().optional().describe("Words that must all appear in the title, in any case and any order."),
  }),
  meta: { ui: { resourceUri: cardUri("records") } },
  run: async (ctx, a) => {
    if (a.scope) {
      const found = await scopeOf(ctx, a.scope);
      if (typeof found === "string") return refused(found);
    }
    const filters = [a.kind, a.scope && `in ${a.scope}`, a.title && `titled "${a.title}"`].filter(Boolean).join(", ");
    return {
      content: [{ type: "text", text: `The records card is shown${filters ? `: ${filters}` : ""}. End the turn here.` }],
      structuredContent: { card: "records", kind: a.kind ?? null, scope: a.scope ?? null, title: a.title ?? null },
    };
  },
});

const showBoard = tool({
  name: "show_board",
  description: "Show the board card. With a plan, its activities are cards in columns by state (Pending, In progress, Paused, Completed, " +
    "Cancelled), in a row for each part of the plan, with dates and the badges Overdue, Due to start and Blocked. With a model record, each node is " +
    "a card, in rows by its type or by an attribute picked on the card. With no record, the person's newest records are cards in columns by kind, " +
    "a note just saved among them. Each card opens its record's fields on the board. A task, an evidence or a decision record is refused. " + SHOWN,
  input: z.object({
    record: z.string().min(1).optional().describe("The plan or model record to draw. " + RECORD_NAME + " Leave out for the newest records."),
  }),
  meta: { ui: { resourceUri: cardUri("board") } },
  run: async (ctx, { record }) => {
    if (!record) {
      return { content: [{ type: "text", text: "The board card is shown, with the newest records by kind. End the turn here." }], structuredContent: { card: "board", record_id: null } };
    }
    const found = await shownFor(ctx, record);
    if ("content" in found) return found;
    return {
      content: [{ type: "text", text: `The board card is shown for the ${found.kind} "${found.title}". End the turn here.` }],
      structuredContent: { card: "board", ...found },
    };
  },
});

const showGraph = tool({
  name: "show_graph",
  description: "Show the graph card: a model record's nodes and links, or a plan's activities with a Part of link to each one's parent and a " +
    "Waits on link to each activity it depends on, drawn as a graph with a column for each node type or each part of the plan. Clicking a node " +
    "shows its attributes and links, and for a plan's activity, opens its record. A task, an evidence or a decision record is refused. " + SHOWN,
  input: z.object({ record: z.string().min(1).describe("The plan or model record to draw. " + RECORD_NAME) }),
  meta: { ui: { resourceUri: cardUri("graph") } },
  run: async (ctx, { record }) => {
    const found = await shownFor(ctx, record);
    if ("content" in found) return found;
    return {
      content: [{ type: "text", text: `The graph card is shown for the ${found.kind} "${found.title}". End the turn here.` }],
      structuredContent: { card: "graph", ...found },
    };
  },
});

/** The cards' tools, in the order Claude lists them: those that show a card, then those only a card calls. */
export const CARD_TOOLS: Tool[] = [showRecords, showBoard, showGraph, cardPage, cardCall, cardFindRecords, cardRecord, cardView];

/** A card's _meta: it may load the brand's Google Fonts. */
const CARD_META = { ui: { csp: { resourceDomains: FONT_DOMAINS } } };

/** Adds each card's address, which serves its shell. */
export function registerCards(server: McpServer) {
  for (const card of CARD_NAMES) {
    const uri = cardUri(card);
    server.registerResource(`${card}-card`, uri, { mimeType: CARD_TYPE, _meta: CARD_META },
      () => ({ contents: [{ uri, mimeType: CARD_TYPE, text: shell(card), _meta: CARD_META }] }));
  }
}
