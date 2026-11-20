// fabrik chat-page: builds the public agent's chat page in the business's brand, and puts it up on Cloudflare Pages.
//
//   node fabrik.mjs chat-page [--project <ref> --email <email>]
//
// It reads the Brand record as the signed-in person, and the public-agent function's address from the sign-in's project.
// It writes index.html, chat.js and widget.js into ~/.config/fabrik/chat/<ref>, a folder of fabrik's own outside the
// owner's folder, made again each run. It puts them up with Wrangler as the Pages project fabrik-chat-<ref>, on the same
// Cloudflare sign-in as the sign-in page, and prints the page's address and the line that puts the chat button on a
// website. With no Brand record, the page takes fabrik's own look. The page holds no key: chat.js asks public-agent for
// the Turnstile site key.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { both, fontImport, headLogoHtml, stack } from "./lib/brand.mjs";
import { putUpPage, WRANGLER } from "./sign-in-page.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The folder that holds chat.js, widget.js and page.html, the template of index.html. */
export const SOURCE = resolve(HERE, "..", "public-agent");
/** The folder fabrik chat-page builds one project's chat page in. */
export const chatFolder = (ref, home = homedir()) => join(home, ".config", "fabrik", "chat", ref);
/** The Pages project of one fabrik project's chat page. */
export const chatProject = ref => `fabrik-chat-${ref}`;
/** The line that puts the chat button on any website. */
export const widgetLine = site => `<script src="${site}/widget.js" async></script>`;

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
function token(brand, name) {
  const light = brand?.palette.light[name] ?? brand?.palette.dark[name];
  const dark = brand?.palette.dark[name] ?? light;
  return light ? [light, dark] : FABRIK[name];
}

/** The page's style: the fonts' @import, then its tokens in light and dark. */
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
}`;
}

/** Writes the chat page into folder: index.html in the brand, chat.js, and widget.js with the brand's accent. */
export function buildChatPage({ brand, address, folder }) {
  if (!/^https?:\/\/[^\s"'<>]+$/.test(String(address))) throw new Error(`${address} is not the public-agent function's address.`);
  const name = brand?.name?.trim() || "Ask a question";
  const fill = (text, values) => text.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => values[k]);
  const page = fill(readFileSync(join(SOURCE, "page.html"), "utf8"), {
    TITLE: esc(name), NAME: esc(name), STYLE: pageStyle(brand), LOGO: headLogoHtml(brand, "logo"), ADDRESS: esc(address),
  });
  const [accent] = token(brand, "accent");
  const widget = fill(readFileSync(join(SOURCE, "widget.js"), "utf8"), { ACCENT: accent, ON_ACCENT: onColour(accent) });
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  writeFileSync(join(folder, "index.html"), page);
  writeFileSync(join(folder, "chat.js"), readFileSync(join(SOURCE, "chat.js")));
  writeFileSync(join(folder, "widget.js"), widget);
  return ["index.html", "chat.js", "widget.js"];
}

/**
 * Builds the chat page for the project ref and puts it up. url is the project's address, and readBrand() gives the
 * brand or null. The options are putUpPage's. Returns { site, widget, folder }.
 */
export async function chatPage({ ref, url, readBrand }, { ask, say, wrangler = WRANGLER, home = homedir(), env = process.env } = {}) {
  const brand = await readBrand();
  const folder = chatFolder(ref, home);
  buildChatPage({ brand, address: `${url}/functions/v1/public-agent`, folder });
  say(brand ? `Built the chat page in ${brand.name || "the business"}'s brand.` : "Built the chat page in fabrik's own look, since fabrik holds no Brand record.");
  const site = await putUpPage({ name: chatProject(ref), folder, what: "chat page" }, { ask, say, wrangler, home, env });
  return { site, widget: widgetLine(site), folder };
}
