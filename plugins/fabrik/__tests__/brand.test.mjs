// The brand module's reads and styles, and the card kits' check that text in the brand's accent reads on the chat's
// background.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brandOf, headLogoHtml, LOGO_CSS, LOGO_SWITCH, logoHtml, MAX_LOGO, printStyle, readBrand } from "../cli/lib/brand.mjs";
import { buildChatPage, pageStyle } from "../cli/chat-page.mjs";
import { createTools } from "../cli/lib/pages.mjs";

const RECORD = JSON.parse(readFileSync(new URL("./widgets/brand-record.json", import.meta.url), "utf-8"));
const GENERAL = { scope_id: "0b6c1f5e-0000-4000-8000-0000000000aa", code: "general" };

/** A fake fabrik: General, then pages of model records whose titles hold the word, the Brand record on the page given. */
function fabrikWith({ brandOnPage = 1, pages = 1, version = RECORD.version_id } = {}) {
  const calls = [];
  const call = async (fn, args) => {
    calls.push(fn);
    if (fn === "fabrik_get_scopes") return { items: [GENERAL], next_cursor: null };
    if (fn === "fabrik_find_records") {
      const page = args.p_cursor === null ? 1 : args.p_cursor;
      const items = Array.from({ length: 100 }, (_, i) => ({ record_id: `r${page}-${i}`, title: `Brand review ${page}-${i}`, version_id: `v${page}-${i}` }));
      if (page === brandOnPage) items[50] = { record_id: RECORD.record_id, title: "Brand", version_id: version };
      return { items, next_cursor: page < pages ? page + 1 : null };
    }
    if (fn === "fabrik_show_record") return RECORD;
    throw new Error(`no ${fn}`);
  };
  return { call, calls };
}

test("readBrand reads each page of title matches until the Brand record, past the first 100", async () => {
  const { call } = fabrikWith({ brandOnPage: 2, pages: 3 });
  const brand = await readBrand(call);
  assert.equal(brand?.name, "Smith Joinery");
});

test("readBrand gives no brand, soon, where fabrik never answers", async () => {
  const started = Date.now();
  const brand = await readBrand(() => new Promise(() => {}), { wait: 100 });
  assert.equal(brand, null);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test("strict, readBrand throws where fabrik refuses or never answers, and gives null only where there is no Brand record", async () => {
  await assert.rejects(readBrand(() => Promise.reject(new Error("refused")), { strict: true }), /refused/);
  await assert.rejects(readBrand(() => new Promise(() => {}), { wait: 100, strict: true }), /in time/);
  const none = await readBrand(async fn => fn === "fabrik_get_scopes" ? { items: [{ code: "general", scope_id: "g" }] } : { items: [] }, { strict: true });
  assert.equal(none, null);
});

test("with a person's cache, a second read of the same version skips General and the record, and a new version reads it", async () => {
  const cache = {};
  const first = fabrikWith();
  await readBrand(first.call, { cache });
  assert.deepEqual(first.calls, ["fabrik_get_scopes", "fabrik_find_records", "fabrik_show_record"]);
  const again = fabrikWith();
  assert.equal((await readBrand(again.call, { cache }))?.name, "Smith Joinery");
  assert.deepEqual(again.calls, ["fabrik_find_records"]);
  const changed = fabrikWith({ version: "another-version" });
  await readBrand(changed.call, { cache });
  assert.deepEqual(changed.calls, ["fabrik_find_records", "fabrik_show_record"]);
});

test("a font's fallbacks are each quoted, so a name starting with a digit keeps the stack valid", () => {
  const brand = brandOf({ payload: { graph: { nodes: [{ type: "brand", label: "X", attributes: { fonts: { body: { family: "Inter", fallback: "3Dumb, Arial, serif" } } } }] } } });
  assert.match(printStyle(brand), /--body-font: "Inter", "3Dumb", "Arial", serif;/);
});

test("a deck's title slide takes the logo whatever the order of its class's names", async t => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-brand-")));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  writeFileSync(join(work, "deck.html"), '<!doctype html><html><head><title>Deck</title></head><body><section class="title slide"><h1>Harbour</h1></section>' +
    '<section class="slide"><footer class="x band"><span>2026</span></footer></section><section class="subtitle slide"></section></body></html>');
  const tools = createTools({ agentFolder: work, readBrand: async () => brandOf(RECORD) });
  const made = JSON.parse((await tools.callTool("embed_pictures", { page_file: join(work, "deck.html"), new_file: join(work, "deck-print.html"), style: "deck" })).content[0].text);
  assert.equal(made.look, "brand", JSON.stringify(made));
  const html = readFileSync(join(work, "deck-print.html"), "utf-8");
  assert.match(html, /<section class="title slide">\n<img class="brand-logo"/);
  assert.match(html, /<footer class="x band"><img class="brand-logo"/);
  assert.match(html, /<section class="subtitle slide"><\/section>/, "subtitle is not title");
});

// ---- The dark-mode logo ----

const ATTRIBUTES = RECORD.payload.graph.nodes[0].attributes;
const DARK = "data:image/png;base64,ZGFyaw==";
/** The Brand record with its logo's attributes changed as given. */
const withLogo = logo => ({ ...RECORD, payload: { ...RECORD.payload, graph: { ...RECORD.payload.graph, nodes: [{ ...RECORD.payload.graph.nodes[0], attributes: { ...ATTRIBUTES, logo } }] } } });
const DARK_RECORD = withLogo({ ...ATTRIBUTES.logo, dark: { path: "brand/logo-dark.png", data_address: DARK } });

test("brandOf takes a dark-mode logo by the logo's own rules, and only beside a logo", () => {
  assert.equal(brandOf(DARK_RECORD).logo.dark, DARK);
  assert.equal(brandOf(RECORD).logo.dark, undefined, "a brand with no dark-mode logo has none");
  for (const data_address of ["data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "javascript:alert(1)", `data:image/png;base64,${"A".repeat(MAX_LOGO)}`, 7]) {
    const brand = brandOf(withLogo({ ...ATTRIBUTES.logo, dark: { path: "brand/logo-dark.png", data_address } }));
    assert.equal(brand.logo.dark, undefined, `${String(data_address).slice(0, 30)} is no dark-mode logo`);
    assert.ok(brand.logo.src, "the logo stays");
  }
  const alone = brandOf(withLogo({ dark: { path: "brand/logo-dark.png", data_address: DARK } }));
  assert.equal(alone.logo, null, "with no logo, the dark-mode copy is left out");
});

test("a card's header takes both logos, the dark one hidden, while paper takes the light logo only", () => {
  const brand = brandOf(DARK_RECORD);
  const head = headLogoHtml(brand, "fk-logo");
  assert.match(head, /^<img class="fk-logo" data-scheme="light" alt="[^"]*" src="data:image\/png;base64,[^"]+"><img class="fk-logo" data-scheme="dark" alt="[^"]*" src="data:image\/png;base64,ZGFyaw==" hidden>$/);
  assert.equal(logoHtml(brand, "brand-logo"), `<img class="brand-logo" alt="${brand.logo.alt}" src="${brand.logo.src}">`);
  assert.doesNotMatch(headLogoHtml(brandOf(RECORD), "fk-logo"), /data-scheme/, "with no dark-mode logo, one <img> as before");
});

test("a deck takes the light logo, even where the brand has a dark-mode one", async t => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-brand-")));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  writeFileSync(join(work, "deck.html"), '<!doctype html><html><head><title>Deck</title></head><body><section class="slide title"><h1>Harbour</h1></section></body></html>');
  const tools = createTools({ agentFolder: work, readBrand: async () => brandOf(DARK_RECORD) });
  await tools.callTool("embed_pictures", { page_file: join(work, "deck.html"), new_file: join(work, "deck-print.html"), style: "deck" });
  const html = readFileSync(join(work, "deck-print.html"), "utf-8");
  assert.match(html, /<img class="brand-logo"/);
  assert.doesNotMatch(html, /ZGFyaw==|data-scheme/);
});

test("a question card ends its code with the logo switch only where the brand has a dark-mode logo", async t => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-brand-")));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  writeFileSync(join(work, "question.json"), readFileSync(new URL("./widgets/question-data.json", import.meta.url)));
  const draw = async record => {
    const tools = createTools({ agentFolder: work, readBrand: async () => brandOf(record) });
    return JSON.parse((await tools.callTool("draw_widget", { kind: "question", data_file: join(work, "question.json") })).content[0].text).widget_code;
  };
  const dark = await draw(DARK_RECORD);
  assert.match(dark, /<img class="wk-logo" data-scheme="light"[^>]*><img class="wk-logo" data-scheme="dark"[^>]*hidden>/);
  assert.ok(dark.includes(LOGO_SWITCH.trim()), "the switch is in the card's code");
  assert.equal(dark.match(/<\/script>/g).length, 2, "in the card's one script");
  const plain = await draw(RECORD);
  assert.ok(!plain.includes("img[data-scheme]"), "no switch without a dark-mode logo");
});

test("a chat page's style shows the dark-mode logo in dark mode only where the brand has one", () => {
  assert.ok(pageStyle(brandOf(DARK_RECORD)).includes(LOGO_CSS.trim()));
  assert.ok(!pageStyle(brandOf(RECORD)).includes("data-scheme"));
  assert.ok(!pageStyle(null).includes("data-scheme"));
});

/** The Chromium browser the print skill finds, or null. */
function chromium() {
  const check = fileURLToPath(new URL("../skills/board/", import.meta.url));
  const ran = spawnSync("python3", ["-c", `import sys; sys.path.insert(0, ${JSON.stringify(check)}); import page_check; print(page_check.browser() or "")`], { encoding: "utf-8" });
  return ran.status === 0 && ran.stdout.trim() ? ran.stdout.trim() : null;
}
const BROWSER = chromium();

/** What legibleAccent, from fabrik's cards' kit, leaves the accent text as, on a background, in the browser. */
function accentAfterCheck(background, accentText) {
  const kit = readFileSync(new URL("../cards/kit.html", import.meta.url), "utf-8");
  const fn = kit.match(/\nfunction legibleAccent\(el, prop, fallback\) \{\n[\s\S]*?\n\}\n/)[0];
  const work = mkdtempSync(join(tmpdir(), "fabrik-brand-"));
  const page = join(work, "page.html");
  writeFileSync(page, `<!doctype html><html><head><style>:root { --color-background-primary: ${background}; --fg: rgb(1, 2, 3); --fk-accent-text: ${accentText}; }</style></head>` +
    `<body><p id="out"></p><script>${fn}legibleAccent(document.documentElement, "--fk-accent-text", "var(--fg)");` +
    `var s = document.createElement("span"); s.style.color = "var(--fk-accent-text)"; document.body.appendChild(s);` +
    `document.getElementById("out").textContent = "[" + getComputedStyle(s).color + "]";</script></body></html>`);
  try {
    // No copy of Chrome left in the temporary folder: Chrome on macOS removes that copy only when it quits by itself.
    // Past its time, spawnSync sends SIGTERM and waits for Chrome to end. Under load Chrome can end with status 2
    // after writing the page, so the page is read whatever the status.
    const ran = spawnSync(BROWSER, ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", `--user-data-dir=${join(work, "profile")}`,
      "--disable-features=MacAppCodeSignClone", "--dump-dom", `file://${page}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, killSignal: "SIGTERM" });
    const found = (ran.stdout ?? "").match(/<p id="out">\[([^\]]*)\]<\/p>/);
    assert.ok(found, `Chrome wrote no page: status ${ran.status}, signal ${ran.signal}, ${ran.error ?? ""} ${(ran.stderr ?? "").slice(-500)}`);
    return found[1];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("text in the brand's accent that reads on the chat's background keeps the accent", { skip: !BROWSER }, () => {
  assert.equal(accentAfterCheck("#ffffff", "#1f6b41"), "rgb(31, 107, 65)");
});

test("text in the brand's accent that does not read on the chat's background takes the chat's own text colour", { skip: !BROWSER }, () => {
  // The light accent_text, darkened for white paper, on a dark chat: 2.9 to 1.
  assert.equal(accentAfterCheck("#262624", "#1f6b41"), "rgb(1, 2, 3)");
});

/** Which logo LOGO_SWITCH shows, in the browser, on a card whose root first has the colour scheme given and is then set
 * to the next one, as Claude sets a card's mode: "light" or "dark" for each. */
function logosShown(first, next) {
  const work = mkdtempSync(join(tmpdir(), "fabrik-brand-"));
  const page = join(work, "page.html");
  const shown = "Array.prototype.filter.call(document.querySelectorAll('img[data-scheme]'), function (i) { return !i.hidden; }).map(function (i) { return i.getAttribute('data-scheme'); }).join(',')";
  writeFileSync(page, `<!doctype html><html style="color-scheme: ${first}"><head></head><body><div class="head">` +
    `<img data-scheme="light" alt="x" src="${DARK}"><img data-scheme="dark" alt="x" src="${DARK}" hidden></div><p id="out"></p>` +
    `<script>${LOGO_SWITCH}window.before = ${shown}; document.documentElement.style.colorScheme = ${JSON.stringify(next)};</script>` +
    `<script>document.getElementById("out").textContent = "[" + window.before + "|" + ${shown} + "]";</script></body></html>`);
  try {
    const ran = spawnSync(BROWSER, ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", `--user-data-dir=${join(work, "profile")}`,
      "--disable-features=MacAppCodeSignClone", "--dump-dom", `file://${page}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, killSignal: "SIGTERM" });
    const found = (ran.stdout ?? "").match(/<p id="out">\[([^\]]*)\]<\/p>/);
    assert.ok(found, `Chrome wrote no page: status ${ran.status}, signal ${ran.signal}, ${ran.error ?? ""} ${(ran.stderr ?? "").slice(-500)}`);
    return found[1];
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("a card shows its dark-mode logo in dark mode and its light logo in light mode, and swaps them when its mode changes", { skip: !BROWSER }, () => {
  assert.equal(logosShown("light", "dark"), "light|dark");
  assert.equal(logosShown("dark", "light"), "dark|light");
});

/** Which logos each page shows in the browser, with the computer in light or dark mode, in one run of Chrome: for each
 * page, its <img>s of the class given, each as its data-scheme or "one" where it has none, only those the page shows. */
function logosOnPages(pages, mode) {
  const work = mkdtempSync(join(tmpdir(), "fabrik-brand-"));
  const page = join(work, "page.html");
  const frames = pages.map(({ html }, n) => `<iframe id="f${n}" srcdoc="${html.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe>`).join("");
  const classes = JSON.stringify(pages.map(p => p.cls));
  writeFileSync(page, `<!doctype html><html><body>${frames}<p id="out"></p><script>window.onload = function () {` +
    `document.getElementById("out").textContent = "[" + ${classes}.map(function (cls, n) { var d = document.getElementById("f" + n).contentDocument;` +
    `return Array.prototype.filter.call(d.querySelectorAll("img." + cls), function (i) { return d.defaultView.getComputedStyle(i).display !== "none"; })` +
    `.map(function (i) { return i.getAttribute("data-scheme") || "one"; }).join(","); }).join("|") + "]"; };</script></body></html>`);
  try {
    const ran = spawnSync(BROWSER, ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", `--user-data-dir=${join(work, "profile")}`,
      "--disable-features=MacAppCodeSignClone", `--blink-settings=preferredColorScheme=${mode === "dark" ? 0 : 1}`, "--virtual-time-budget=5000", "--dump-dom", `file://${page}`],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000, killSignal: "SIGTERM" });
    const found = (ran.stdout ?? "").match(/<p id="out">\[([^\]]*)\]<\/p>/);
    assert.ok(found, `Chrome wrote no page: status ${ran.status}, signal ${ran.signal}, ${ran.error ?? ""} ${(ran.stderr ?? "").slice(-500)}`);
    return found[1].split("|");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test("the question card draw_widget draws, and the chat page, show the dark-mode logo in dark mode only, and a brand without one shows its logo in both", { skip: !BROWSER }, async t => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-brand-")));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  writeFileSync(join(work, "question.json"), readFileSync(new URL("./widgets/question-data.json", import.meta.url)));
  const pages = [];
  for (const record of [DARK_RECORD, RECORD]) {
    const brand = brandOf(record), folder = join(work, `chat-${pages.length}`);
    const tools = createTools({ agentFolder: work, readBrand: async () => brand });
    const { widget_code } = JSON.parse((await tools.callTool("draw_widget", { kind: "question", data_file: join(work, "question.json") })).content[0].text);
    buildChatPage({ brand, address: "https://x.example/functions/v1/public-agent", folder, agents: [{ slug: "help", name: "Help", purpose: "" }] });
    pages.push({ html: `<!doctype html><html><head><meta charset="utf-8"></head><body>${widget_code}</body></html>`, cls: "wk-logo" },
      { html: readFileSync(join(folder, "index.html"), "utf-8"), cls: "logo" });
  }
  // The card and the chat page with a dark-mode logo, then the two without.
  assert.deepEqual(logosOnPages(pages, "light"), ["light", "light", "one", "one"]);
  assert.deepEqual(logosOnPages(pages, "dark"), ["dark", "dark", "one", "one"]);
});

test("a chat page hides a heading that is the business's own name beside its logo, and shows every other heading", t => {
  const work = mkdtempSync(join(tmpdir(), "fabrik-chat-heading-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const agents = [{ slug: "joinery", name: "smith JOINERY", purpose: "" }, { slug: "help", name: "Help", purpose: "" }];
  const headings = (brand, folder) => {
    buildChatPage({ brand, address: "https://x.example/functions/v1/public-agent", folder, agents });
    return ["index.html", "joinery/index.html", "help/index.html"].map(f => readFileSync(join(folder, f), "utf-8").match(/<h1[^>]*>[^<]*<\/h1>/)[0]);
  };
  assert.deepEqual(headings(brandOf(RECORD), join(work, "logo")),
    ['<h1 class="in-logo">Smith Joinery</h1>', '<h1 class="in-logo">smith JOINERY</h1>', "<h1>Help</h1>"]);
  const alt = { ...brandOf(RECORD), logo: { ...brandOf(RECORD).logo, alt: "Smith & Sons" } };
  buildChatPage({ brand: alt, address: "https://x.example/functions/v1/public-agent", folder: join(work, "alt"), agents: [{ slug: "sons", name: "smith & sons", purpose: "" }] });
  assert.equal(readFileSync(join(work, "alt", "sons", "index.html"), "utf-8").match(/<h1[^>]*>[^<]*<\/h1>/)[0], '<h1 class="in-logo">smith &amp; sons</h1>');
  const plain = { ...brandOf(RECORD), logo: null };
  assert.deepEqual(headings(plain, join(work, "plain")), ["<h1>Smith Joinery</h1>", "<h1>smith JOINERY</h1>", "<h1>Help</h1>"]);
});
