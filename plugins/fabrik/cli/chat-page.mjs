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

/** The button that opens an agent page's nav on a phone. page.html shows it only at phone width, and only once
 * MENU_SCRIPT has run, so without JavaScript the nav shows as it does at desktop width. */
const MENU = '<button class="menu" type="button" aria-expanded="false" aria-controls="agent-nav" aria-label="Menu">' +
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M4 7h16M4 12h16M4 17h16"/></svg></button>';
/** Opens and closes the nav from the button, and closes it on Escape. Escape gives the button back its focus only where
 * the focus was in the nav or on the button, so a visitor typing in the chat box keeps their place. */
const MENU_SCRIPT = `<script>(function () { var b = document.querySelector("header button.menu"), n = document.getElementById("agent-nav");
  if (!b || !n) return;
  b.parentNode.classList.add("has-menu");
  function set(open) { b.setAttribute("aria-expanded", String(open)); n.classList.toggle("open", open); }
  b.addEventListener("click", function () { set(b.getAttribute("aria-expanded") !== "true"); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && b.getAttribute("aria-expanded") === "true") { var inside = b === document.activeElement || n.contains(document.activeElement); set(false); if (inside) b.focus(); } });
})();</script>`;

const SLUG = /^[a-z0-9-]{1,40}$/;
/** The most agents an agent's page links to by name. Past it, the page links to the list of agents alone. */
export const MOST_LINKED = 12;

const byText = (a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true }) || (a < b ? -1 : a > b ? 1 : 0);
const topicOf = a => String(a?.topic ?? "").replace(/\s+/g, " ").trim();
/** An agent's greeting, which chat.js draws as the first message of a new conversation: empty for none. Its line breaks
 * stay, as chat.js keeps them. */
const greetingOf = a => String(a?.greeting ?? "").replace(/\r\n?/g, "\n").trim();
/** Text escaped for a double-quoted attribute, where only & and " need it, so a page's parser gives back the text
 * exactly: & becomes &amp; and " becomes &quot;. */
const escAttribute = v => String(v ?? "").replace(/[&"]/g, c => (c === "&" ? "&amp;" : "&quot;"));

/** The agents in groups by topic: [{ topic, agents }], the topics in alphabetical order and each one's agents by name,
 * then the agents with no topic, whose group's topic is empty. Topics that differ only in capitals are one group, named
 * with the spelling most of its agents have, and on a tie the one that sorts first by code point, so capitals win. */
export function topicGroups(agents) {
  const groups = new Map();
  for (const a of agents) {
    const topic = topicOf(a), key = topic.toLowerCase();
    if (!groups.has(key)) groups.set(key, { topic, agents: [], spellings: new Map() });
    const g = groups.get(key);
    g.agents.push(a);
    g.spellings.set(topic, (g.spellings.get(topic) ?? 0) + 1);
  }
  for (const g of groups.values()) {
    g.agents.sort((x, y) => byText(x.name, y.name) || byText(x.slug, y.slug));
    g.topic = [...g.spellings].sort(([s, n], [t, m]) => m - n || (s < t ? -1 : s > t ? 1 : 0))[0][0];
    delete g.spellings;
  }
  return [...groups.values()].sort((x, y) => (!x.topic) - (!y.topic) || byText(x.topic, y.topic));
}

/** The business's main agent: where some agents have a topic, the one agent that has none, or null where no agent has a
 * topic or more than one has none. */
export function mainAgent(agents) {
  const none = agents.filter(a => !topicOf(a));
  return none.length === 1 && none.length < agents.length ? none[0] : null;
}

/** Writes the chat pages into folder: a page in the brand for each agent at <slug>/index.html, index.html listing the
 * agents under a heading for each topic, with the main agent first, chat.js, and widget.js with the brand's accent. agents is
 * [{ slug, name, purpose, topic, greeting }], at least one, and topic and greeting may be left out. An agent's page gives its
 * greeting to chat.js as data-greeting. */
export function buildChatPage({ brand, address, folder, agents }) {
  if (!/^https?:\/\/[^\s"'<>]+$/.test(String(address))) throw new Error(`${address} is not the public-agent function's address.`);
  if (!Array.isArray(agents) || !agents.length) throw new Error("fabrik has no public agent yet, so there's no chat page to put up. Add an agent first.");
  for (const a of agents) if (!SLUG.test(String(a?.slug))) throw new Error(`${a?.slug} is not an agent's slug.`);
  const business = brand?.name?.trim() || "";
  const fill = (text, values) => text.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => values[k]);
  const template = readFileSync(join(SOURCE, "page.html"), "utf8");
  const style = pageStyle(brand), logo = headLogoHtml(brand, "logo");
  // A page's heading beside a logo that already shows it, the business's own name or the logo's alt text, is kept for
  // screen readers and hidden from view.
  const shown = new Set([business, brand?.logo?.alt ?? ""].map(n => n.trim().toLowerCase()).filter(Boolean));
  const heading = name => `<h1${brand?.logo && shown.has(name.trim().toLowerCase()) ? ' class="in-logo"' : ""}>${esc(name)}</h1>`;
  // The tab's icon: the brand's logo where it has one, and fabrik's mark otherwise.
  const icon = esc(brand?.logo?.src || FABRIK_MARK);
  // The mark beside each answer: the brand's logo, and its dark-mode copy, where it has them. chat.js shows fabrik's mark
  // where it has none.
  const marks = `${brand?.logo?.src ? ` data-mark="${esc(brand.logo.src)}"` : ""}${brand?.logo?.dark ? ` data-mark-dark="${esc(brand.logo.dark)}"` : ""}`;
  const groups = topicGroups(agents), topical = groups.some(g => g.topic), main = mainAgent(agents);
  const items = (list, kind = "agents") => `<ul class="${kind}">${list.map(a => `<li><a href="${a.slug}/"><strong>${esc(a.name)}</strong>` +
    `${a.purpose?.trim() ? `<span>${esc(a.purpose.trim())}</span>` : ""}</a></li>`).join("")}</ul>`;
  // With topics, the main agent comes first, above the headings. Each topic has a heading over its agents, and the
  // agents with none, where there is no main agent, come last, under Other agents.
  const list = !topical ? items(groups[0].agents) : `<div class="topics">${main ? items([main], "agents main") : ""}${groups
    .filter(g => g.topic || !main).map(g => `<section><h2>${esc(g.topic || "Other agents")}</h2>${items(g.agents)}</section>`).join("")}</div>`;
  // The list's close link goes back to the agent page the visitor came from, which the All agents link names in from,
  // or to the main agent. Where there is no main agent, it shows only for a visitor who came from an agent's page.
  const close = `<a class="close" href="${main ? `${main.slug}/` : "./"}"${main ? "" : " hidden"} aria-label="Close the list of agents">` +
    `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>Close</a>`;
  // The logo links home, to the main agent's page, on the list and on every other agent's page, as the Close link does.
  // Where there is no main agent, and on the main agent's own page, it links nowhere.
  // Its name starts with the logo's alt text, the label a visitor sees, so a speech-control user can say it.
  const seen = (brand?.logo?.src ? brand.logo.alt?.trim() || business : "fabrik") || "Logo";
  const logoTo = href => href ? `<a class="home" href="${href}" aria-label="${esc(seen)}: home">${logo}</a>` : logo;
  const slugs = JSON.stringify(agents.map(a => a.slug));
  const back = `<script>(function () { var from = new URLSearchParams(location.search).get("from"), close = document.querySelector("a.close");
  if (close && ${slugs}.indexOf(from) >= 0) { close.href = from + "/"; close.hidden = false; } })();</script>`;
  const root = fill(template, { TITLE: esc(business || "Ask a question"), HEADING: heading(business || "Ask a question"), STYLE: style, LOGO: logoTo(main && `${main.slug}/`), ICON: icon,
    NAV: agents.length > 1 ? close : "", MAIN: list, SCRIPT: agents.length > 1 ? back : "" });
  const [accent] = token(brand, "accent");
  // A widget line from before there were many agents names none, and opens the agent chat, which was that one chat box.
  const fallback = agents.some(a => a.slug === "chat") ? "chat" : "";
  const widget = fill(readFileSync(join(SOURCE, "widget.js"), "utf8"), { ACCENT: accent, ON_ACCENT: onColour(accent), AGENT: fallback });
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, "index.html"), root);
  // An agent's page other than the main agent's links home to the main agent, where there is one. Every agent's page links
  // to the list of agents, naming itself so the list's close link comes back to it, and by name to each other agent of
  // its own topic, or with no topics to each other agent, with its purpose as the link's title. Where those are more than
  // MOST_LINKED, it links to the list alone.
  const groupOf = new Map(groups.flatMap(g => g.agents.map(a => [a.slug, g])));
  const nav = slug => {
    if (agents.length < 2) return "";
    const g = groupOf.get(slug), others = g.agents.filter(o => o.slug !== slug);
    const shown = others.length <= MOST_LINKED ? others : [];
    const label = g.topic ? `${esc(g.topic)}: other agents` : "Other agents";
    const home = main && main.slug !== slug ? `<a href="../${main.slug}/">Home</a>` : "";
    return MENU + `<nav id="agent-nav" aria-label="${label}">${home}<a href="../?from=${slug}">All agents</a>` +
      `${g.topic && shown.length ? `<span class="topic">${esc(g.topic)}</span>` : ""}${shown
        .map(o => `<a href="../${o.slug}/"${o.purpose?.trim() ? ` title="${esc(o.purpose.trim())}"` : ""}>${esc(o.name)}</a>`).join("")}</nav>${MENU_SCRIPT}`;
  };
  for (const a of agents) {
    mkdirSync(join(folder, a.slug), { mode: 0o700 });
    writeFileSync(join(folder, a.slug, "index.html"), fill(template, {
      TITLE: esc(business ? `${a.name} | ${business}` : a.name), HEADING: heading(a.name), STYLE: style, LOGO: logoTo(main && main.slug !== a.slug && `../${main.slug}/`), ICON: icon, NAV: nav(a.slug),
      MAIN: '<div id="fabrik-chat"></div>', SCRIPT: `<script src="../chat.js" data-address="${esc(address)}" data-agent="${a.slug}"${business ? ` data-business="${esc(business)}"` : ""}` +
        `${greetingOf(a) ? ` data-greeting="${escAttribute(greetingOf(a))}"` : ""}${marks}></script>`,
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
