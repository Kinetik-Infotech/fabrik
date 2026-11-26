// fabrik chat-page: builds the public agents' chat pages in the business's brand, and puts them up on Cloudflare Pages.
//
//   node fabrik.mjs chat-page [--domain <address>] [--project <ref> --email <email>]
//
// It reads the Brand record and the list of public agents as the signed-in person, and the public-agent function's
// address from the sign-in's project. It writes a chat page for each agent at <slug>/index.html, an index.html that
// lists the agents, chat.js and widget.js into ~/.config/fabrik/chat/<ref>. That folder is fabrik's own, outside the
// owner's folder, and made again each run.
//
// It puts them up with Wrangler as the Pages project fabrik-chat-<ref>, on the same Cloudflare sign-in as the sign-in
// page. chat-domain.mjs then puts them at an address on the owner's own domain, such as chat.example.com, as the Worker
// fabrik-chat-<ref> where Cloudflare runs the domain's DNS, or keeps the pages.dev one. Then it saves the address with public-agent, for AGENTS.md, and prints each agent's page and the line
// that puts its chat button on a website. With no Brand record, the pages take fabrik's own look.
// The pages hold no key: chat.js asks public-agent for the Turnstile site key.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { FABRIK_MARK, fontImport, headLogoHtml, LOGO_CSS, pairOf, stack } from "./lib/brand.mjs";
import { publishPage, WRANGLER } from "./sign-in-page.mjs";
import { DomainNotReady, ownDomain } from "./chat-domain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The folder that holds chat.js, widget.js and page.html, the template of index.html. */
export const SOURCE = resolve(HERE, "..", "public-agent");
/** The folder fabrik chat-page builds one project's chat page in. */
export const chatFolder = (ref, home = homedir()) => join(home, ".config", "fabrik", "chat", ref);
/** The Pages project of one fabrik project's chat page. */
export const chatProject = ref => `fabrik-chat-${ref}`;
/** The line that puts an agent's chat button on any website. */
export const widgetLine = (site, slug) => `<script src="${site}/widget.js" data-agent="${slug}" async></script>`;

/** fabrik's own look, for each token the brand leaves out: fabrik.tech's paper, navy and gold, Fraunces and Inter. */
const FABRIK = {
  ink: ["#1b2433", "#f6f1e7"], paper: ["#f6f1e7", "#111827"], muted: ["#545f70", "#b9c1cd"],
  rule: ["#d3d0c9", "#3a4150"], accent: ["#e3a82b", "#f0be4c"],
};
const FABRIK_FONTS = {
  heading: { family: "Fraunces", google: true, fallback: ["Georgia", "serif"] },
  body: { family: "Inter", google: true, fallback: ["Helvetica Neue", "Arial", "sans-serif"] },
};

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** A colour's relative luminance, as WCAG works it out. */
function luminance(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = [...h].map(c => c + c).join("");
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** The text colour that reads best on a colour: near black or white, whichever contrasts more. */
export function onColour(hex) {
  const l = luminance(hex);
  return (l + 0.05) / (luminance("#111111") + 0.05) > 1.05 / (l + 0.05) ? "#111111" : "#ffffff";
}

/** The brand's value of a token in light and dark, or fabrik's own where the brand gives neither. */
const token = (brand, name) => pairOf(brand, name) ?? FABRIK[name];

/** The page's style: the fonts' @import, then its tokens in light and dark, and the switch to a dark logo where the
 * brand has one. */
export function pageStyle(brand) {
  const fonts = { heading: brand?.fonts.heading ?? FABRIK_FONTS.heading, body: brand?.fonts.body ?? FABRIK_FONTS.body };
  const [ink, paper, muted, rule, accent] = ["ink", "paper", "muted", "rule", "accent"].map(n => token(brand, n));
  const pair = ([l, d]) => `light-dark(${l}, ${d})`;
  return `${fontImport({ fonts })}:root {
  color-scheme: light dark;
  --ink: ${pair(ink)}; --paper: ${pair(paper)}; --muted: ${pair(muted)}; --rule: ${pair(rule)};
  --accent: ${pair(accent)}; --on-accent: ${pair(accent.map(onColour))};
  --card: color-mix(in srgb, var(--paper) 92%, var(--ink)); --refused: light-dark(#b3261e, #ff8a80);
  --heading-font: ${stack(fonts.heading)}; --body-font: ${stack(fonts.body)};
}${brand?.logo?.dark ? `\n${LOGO_CSS.trimEnd()}` : ""}`;
}

const SLUG = /^[a-z0-9-]{1,40}$/;

/** Writes the chat pages into folder: a page in the brand for each agent at <slug>/index.html, index.html listing the
 * agents, chat.js, and widget.js with the brand's accent. agents is [{ slug, name, purpose }], at least one. */
export function buildChatPage({ brand, address, folder, agents }) {
  if (!/^https?:\/\/[^\s"'<>]+$/.test(String(address))) throw new Error(`${address} is not the public-agent function's address.`);
  if (!Array.isArray(agents) || !agents.length) throw new Error("fabrik has no public agent yet, so there's no chat page to put up. Add an agent first.");
  for (const a of agents) if (!SLUG.test(String(a?.slug))) throw new Error(`${a?.slug} is not an agent's slug.`);
  const business = brand?.name?.trim() || "";
  const fill = (text, values) => text.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => values[k]);
  const template = readFileSync(join(SOURCE, "page.html"), "utf8");
  const style = pageStyle(brand), logo = headLogoHtml(brand, "logo");
  // The tab's icon: the brand's logo where it has one, and fabrik's mark otherwise.
  const icon = esc(brand?.logo?.src || FABRIK_MARK);
  const list = `<ul class="agents">${agents.map(a => `<li><a href="${a.slug}/"><strong>${esc(a.name)}</strong>` +
    `${a.purpose?.trim() ? `<span>${esc(a.purpose.trim())}</span>` : ""}</a></li>`).join("")}</ul>`;
  const root = fill(template, { TITLE: esc(business || "Ask a question"), NAME: esc(business || "Ask a question"), STYLE: style, LOGO: logo, ICON: icon, NAV: "", MAIN: list, SCRIPT: "" });
  const [accent] = token(brand, "accent");
  // A widget line from before there were many agents names none, and opens the agent chat, which was that one chat box.
  const fallback = agents.some(a => a.slug === "chat") ? "chat" : "";
  const widget = fill(readFileSync(join(SOURCE, "widget.js"), "utf8"), { ACCENT: accent, ON_ACCENT: onColour(accent), AGENT: fallback });
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, "index.html"), root);
  // An agent's page links to the list of agents, and to each other agent by name, with its purpose as the link's title.
  const nav = slug => agents.length < 2 ? "" : `<nav aria-label="Other agents"><a href="../">All agents</a>${agents.filter(o => o.slug !== slug)
    .map(o => `<a href="../${o.slug}/"${o.purpose?.trim() ? ` title="${esc(o.purpose.trim())}"` : ""}>${esc(o.name)}</a>`).join("")}</nav>`;
  for (const a of agents) {
    mkdirSync(join(folder, a.slug), { mode: 0o700 });
    writeFileSync(join(folder, a.slug, "index.html"), fill(template, {
      TITLE: esc(business ? `${a.name} | ${business}` : a.name), NAME: esc(a.name), STYLE: style, LOGO: logo, ICON: icon, NAV: nav(a.slug),
      MAIN: '<div id="fabrik-chat"></div>', SCRIPT: `<script src="../chat.js" data-address="${esc(address)}" data-agent="${a.slug}"${business ? ` data-business="${esc(business)}"` : ""}></script>`,
    }));
  }
  writeFileSync(join(folder, "chat.js"), readFileSync(join(SOURCE, "chat.js")));
  writeFileSync(join(folder, "widget.js"), widget);
  return ["index.html", ...agents.map(a => `${a.slug}/index.html`), "chat.js", "widget.js"];
}

/**
 * Builds the chat pages for the project ref and puts them up. url is the project's address. readBrand() gives the
 * brand, null when fabrik holds none, or throws when it can't be read. readAgents() gives the agents, or throws. A
 * failed read puts nothing up, so a live page never loses its brand or an agent. savePage(site) saves the address with
 * public-agent. domain is --domain's value, if any. The options are putUpPage's, with ownDomain's seams under domains.
 * Returns { site, agents: [{ slug, name, page, widget }], folder }.
 */
export async function chatPage({ ref, url, readBrand, readAgents, savePage, domain }, { ask, say, wrangler = WRANGLER, home = homedir(), env = process.env, domains = {} } = {}) {
  let brand, agents;
  try { brand = await readBrand(); }
  catch (err) { throw new Error(`fabrik couldn't read the Brand record, so the chat page wasn't put up: ${err instanceof Error ? err.message : err}`); }
  try { agents = await readAgents(); }
  catch (err) { throw new Error(`fabrik couldn't read the public agents, so the chat page wasn't put up: ${err instanceof Error ? err.message : err}`); }
  const folder = chatFolder(ref, home);
  buildChatPage({ brand, address: `${url}/functions/v1/public-agent`, folder, agents });
  say(brand ? `Built ${agents.length === 1 ? "the chat page" : `${agents.length} chat pages`} in ${brand.name || "the business"}'s brand.`
    : "Built the chat pages in fabrik's own look, since fabrik holds no Brand record.");
  const put = await publishPage({ name: chatProject(ref), folder, what: "chat page" }, { ask, say, wrangler, home, env });
  // Where the own domain isn't ready, the pages are still up at pages.dev, so the agents' addresses are given there.
  const site = await ownDomain({ ref, project: chatProject(ref), pagesHost: new URL(put.site).host, accountId: put.accountId, token: put.token, given: domain,
    folder, deploy: put.deploy },
    { ask, say, home, ...domains }).catch(err => {
    if (!(err instanceof DomainNotReady)) throw err;
    // An address fabrik put back on Pages is still the chat's address.
    if (err.site) { say(err.message); return err.site; }
    say(`${err.message} Meanwhile the pages are at ${put.site}.`);
    return put.site;
  });
  try { await savePage(site); }
  catch (err) { say(`fabrik couldn't save the address for AGENTS.md: ${err instanceof Error ? err.message : err}. The agents can't give each other's addresses until chat-page runs again.`); }
  return { site, agents: agents.map(a => ({ slug: a.slug, name: a.name, page: `${site}/${a.slug}/`, widget: widgetLine(site, a.slug) })), folder };
}
