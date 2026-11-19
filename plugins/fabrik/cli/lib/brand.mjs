// The business's brand, as fabrik keeps it: one model record in General titled Brand. Its brand node's attributes hold
// the palette, six tokens each with a light and a dark value, the heading and body fonts, and the logo, a small copy as
// a data address. readBrand reads it as the signed-in person; brandOf keeps only the values that are a colour, a font's
// name or a picture's data address, so no value can carry markup or a style of its own into a card or a page.
// widgetStyle dresses the question and list cards' kit, and printStyle the printed pages and decks. This file is the one
// source of all of it: plugins/fabrik/cards/make-card.ts copies it to the fabrik-apps connector as brand-core.mjs, and
// the connector's brand.ts dresses its cards with it.

/** The palette's tokens. accent_text is the accent deepened for legible text on paper. */
export const TOKENS = ["ink", "paper", "muted", "rule", "accent", "accent_text"];
const COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const FONT = /^[A-Za-z0-9][A-Za-z0-9 -]{0,59}$/;
const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace"]);
const PICTURE = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
/** The longest logo copy a card or page takes, in characters of its data address: a picture 200 pixels across. */
export const MAX_LOGO = 300_000;
/** Where a card may load the brand's Google Fonts from. */
export const FONT_DOMAINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];
/** How long a card or page waits for the brand before it takes its plain look. */
export const BRAND_WAIT_MS = 5000;

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** A font's fallbacks: each a font's name or a generic family, ending in a generic one. */
function fallbackOf(text) {
  const names = String(text ?? "").split(",").map(n => n.trim()).filter(n => FONT.test(n));
  return names.some(n => GENERIC.has(n)) ? names : [...names, "sans-serif"];
}

/** The brand from fabrik_show_record's answer for the Brand record, or null where it holds nothing a card can use. */
export function brandOf(record) {
  const nodes = record?.payload?.graph?.nodes;
  const node = Array.isArray(nodes) ? nodes.find(n => n?.type === "brand") : null;
  const a = node?.attributes;
  if (!a || typeof a !== "object") return null;
  const palette = { light: {}, dark: {} };
  for (const mode of ["light", "dark"]) {
    for (const token of TOKENS) {
      const c = a.palette?.[mode]?.[token];
      if (typeof c === "string" && COLOUR.test(c.trim())) palette[mode][token] = c.trim().toLowerCase();
    }
  }
  const fonts = {};
  for (const role of ["heading", "body"]) {
    const f = a.fonts?.[role];
    if (typeof f?.family === "string" && FONT.test(f.family.trim())) fonts[role] = { family: f.family.trim(), google: f.source === "google", fallback: fallbackOf(f.fallback) };
  }
  const l = a.logo;
  const logo = typeof l?.data_address === "string" && l.data_address.length <= MAX_LOGO && PICTURE.test(l.data_address)
    ? { src: l.data_address, alt: typeof l.alt === "string" && l.alt.trim() ? l.alt.trim() : String(node.label ?? "") } : null;
  if (!Object.keys(palette.light).length && !Object.keys(palette.dark).length && !Object.keys(fonts).length && !logo) return null;
  return { name: String(node.label ?? ""), palette, fonts, logo };
}

/** A font's family and fallbacks as CSS gives them: a generic family as it is, and every font's name in quotes. */
export const stack = f => [`"${f.family}"`, ...f.fallback.map(n => GENERIC.has(n) ? n : `"${n}"`)].join(", ");
/** A token in light and dark, each taking the other's value where the brand gives one only. */
export const both = (brand, token) => {
  const light = brand.palette.light[token] ?? brand.palette.dark[token], dark = brand.palette.dark[token] ?? light;
  return light ? `light-dark(${light}, ${dark})` : null;
};
/** The @import of the brand's Google Fonts, or nothing. */
export function fontImport(brand) {
  const families = [...new Set(["heading", "body"].map(r => brand.fonts[r]).filter(f => f?.google).map(f => f.family))];
  return families.length ? `@import url("https://fonts.googleapis.com/css2?${families.map(f => `family=${f.replace(/ /g, "+")}:wght@400;600`).join("&")}&display=swap");\n` : "";
}
const declarations = pairs => pairs.filter(([, v]) => v).map(([k, v]) => `  ${k}: ${v};`).join("\n");

/** The question and list cards' brand: the accent on the rows' edge, the header's rule and the links, and the fonts. The
 * text and background stay the chat's own, so the card reads in light and dark mode. */
export function widgetStyle(brand) {
  const accent = both(brand, "accent");
  return `${fontImport(brand)}.wk {\n  color-scheme: light dark;\n${declarations([
    ["--wk-key", accent], ["--wk-head-rule", accent], ["--wk-accent", both(brand, "accent_text")],
    ["--wk-font", brand.fonts.body && stack(brand.fonts.body)], ["--wk-heading-font", brand.fonts.heading && stack(brand.fonts.heading)],
  ])}\n}\n`;
}

/** The connector's cards' brand: the @import of its fonts, which goes first in the card's style, and the tokens, which go
 * after the kit's, so they win. */
export function cardStyle(brand) {
  const accent = both(brand, "accent");
  return {
    imports: fontImport(brand),
    css: `:root {\n${declarations([
      ["--fk-accent", accent], ["--fk-accent-text", both(brand, "accent_text")],
      ["--fk-heading-font", brand.fonts.heading && stack(brand.fonts.heading)], ["--fk-body-font", brand.fonts.body && stack(brand.fonts.body)],
      ["--fk-head-rule", accent && "2px"], ["--fk-head-gap", accent && "6px"],
    ])}\n}\n`,
  };
}

/** A printed page's or a deck's brand: paper, so the light palette whole, and the fonts. The print skill's report.css,
 * deck.css and A4 pages read these tokens. */
export function printStyle(brand) {
  const p = brand.palette.light;
  return `${fontImport(brand)}:root {\n${declarations([
    ["--ink", p.ink], ["--paper", p.paper], ["--muted", p.muted], ["--rule", p.rule], ["--accent", p.accent], ["--accent-text", p.accent_text],
    ["--heading-font", brand.fonts.heading && stack(brand.fonts.heading)], ["--body-font", brand.fonts.body && stack(brand.fonts.body)],
  ])}\n}\n`;
}

/** The brand's logo as an <img> of the class given, or nothing. */
export const logoHtml = (brand, cls) => brand?.logo ? `<img class="${cls}" alt="${esc(brand.logo.alt)}" src="${brand.logo.src}">` : "";

/** The value of work, or null where work fails or takes longer than ms. The timer never keeps the process alive. */
async function within(ms, work) {
  let timer;
  const late = new Promise(done => {
    timer = setTimeout(() => done(null), ms);
    if (typeof timer === "object") timer?.unref?.();
    else if (typeof Deno !== "undefined") Deno.unrefTimer?.(timer);
  });
  try { return await Promise.race([Promise.resolve().then(work).catch(() => null), late]); } finally { clearTimeout(timer); }
}

/**
 * The Brand record in General, read with call(fn, args), which runs one fabrik function as the signed-in person and
 * gives its result or throws. The newest model record in General titled Brand, in any case, is the brand. With none, no
 * grant to read General, a refusal, or no answer within BRAND_WAIT_MS, there is no brand, and the card or page keeps its
 * plain look.
 *
 * cache, where it is given, is one person's own: it keeps General's scope and the Brand version last read, so a later
 * read with the same version in force makes two calls, and skips the record, whose logo is the bulk of it.
 */
export function readBrand(call, { cache = null, wait = BRAND_WAIT_MS } = {}) {
  return within(wait, async () => {
    let general = cache?.general ?? null;
    if (!general) {
      let cursor = null;
      do {
        const page = await call("fabrik_get_scopes", { p_cursor: cursor, p_limit: 100 });
        general = (page?.items ?? []).find(s => s.code === "general") ?? null;
        cursor = page?.next_cursor ?? null;
      } while (cursor && !general);
      if (!general) return null;
      if (cache) cache.general = general;
    }
    // The title search matches any title holding the word, newest first, so each page is read until the Brand record.
    let hit = null, cursor = null;
    do {
      const found = await call("fabrik_find_records", { p_kind: "model", p_scope_id: general.scope_id, p_title: "Brand", p_cutoff: null, p_cursor: cursor, p_limit: 100 });
      hit = (found?.items ?? []).find(r => String(r.title ?? "").trim().toLowerCase() === "brand") ?? null;
      cursor = found?.next_cursor ?? null;
    } while (cursor && !hit);
    if (!hit) return null;
    if (cache?.version_id && cache.version_id === hit.version_id) return cache.brand;
    const brand = brandOf(await call("fabrik_show_record", { p_record: hit.record_id }));
    if (cache) Object.assign(cache, { version_id: hit.version_id, brand });
    return brand;
  });
}
