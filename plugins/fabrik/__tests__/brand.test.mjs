// The brand module's reads and styles, and the card kits' check that text in the brand's accent reads on the chat's
// background.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brandOf, printStyle, readBrand } from "../cli/lib/brand.mjs";
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

test("a deck's title slide takes the logo whatever the order of its class's names", async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-brand-")));
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
  const dom = execFileSync(BROWSER, ["--headless=new", "--disable-gpu", "--use-mock-keychain", "--password-store=basic", `--user-data-dir=${join(work, "profile")}`, "--dump-dom", `file://${page}`], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  return dom.match(/<p id="out">\[([^\]]*)\]<\/p>/)[1];
}

test("text in the brand's accent that reads on the chat's background keeps the accent", { skip: !BROWSER }, () => {
  assert.equal(accentAfterCheck("#ffffff", "#1f6b41"), "rgb(31, 107, 65)");
});

test("text in the brand's accent that does not read on the chat's background takes the chat's own text colour", { skip: !BROWSER }, () => {
  // The light accent_text, darkened for white paper, on a dark chat: 2.9 to 1.
  assert.equal(accentAfterCheck("#262624", "#1f6b41"), "rgb(1, 2, 3)");
});
