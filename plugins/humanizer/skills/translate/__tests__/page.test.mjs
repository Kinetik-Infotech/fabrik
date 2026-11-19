import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, checkPage, pageText } from "../references/checks.mjs";

const rules = (html, options) => checkPage(html, options).map((x) => x.rule);
const page = (body) => `<!doctype html><html><head><style>:root { --bg: #fff; --text: rgba(0,0,0,.9); --line: rgba(0,0,0,.1); } body { margin: 0; padding: 24px; font: 16px system-ui; }</style></head><body>${body}</body></html>`;

test("markup, styles and scripts are not read as prose", () => {
  // Run over a published report, check() read its CSS and its runtime script as
  // 21 overlong sentences. The reader sees none of that.
  const html = page(
    "<script>window.__FRAME_PREAMBLE={\"v\":1,\"cred\":\"cookie\",\"capabilities\":{\"artifact\":\"artifact.js\",\"assets\":\"assets.js\"}};</script>" +
    "<!-- frame-runtime -->" +
    "<div class=\"meta\">Monthly update · October 2026 · From Alex to Dana · 3 decisions for Monday</div>" +
    "<h1>MRR is up 24% since the August price rise</h1>",
  );
  assert.ok(check(html).some((x) => x.rule === "sentence-too-long"));
  assert.deepEqual(checkPage(html), []);
  assert.equal(
    pageText(html),
    "Monthly update · October 2026 · From Alex to Dana · 3 decisions for Monday\n\nMRR is up 24% since the August price rise",
  );
});

test("a label and the count beside it are two lines, not a plan number", () => {
  // From a support cheat sheet: a row read "Change plan" and "288" in two spans.
  const html = page('<div class="row"><span class="q">Change plan</span><span class="n">288</span></div>');
  assert.equal(pageText(html), "Change plan\n\n288");
  assert.deepEqual(checkPage(html), []);
  assert.ok(check("See plan 288 for why.").some((x) => x.rule === "internal-reference"));
  assert.deepEqual(check("Change plan\n\n288"), []);
});

test("inline markup inside a sentence keeps the sentence whole", () => {
  const html = page("<div>Dana, I need <b>3 yes or no answers</b> at our Monday 1:1.</div>");
  assert.equal(pageText(html), "Dana, I need 3 yes or no answers at our Monday 1:1.");
});

test("code shown on a page is not prose", () => {
  const html = page('<pre>&lt;meta property="og:image" content="{{ WEBSITE_URL }}socials/og-landscape-main.png"&gt;\n&lt;meta name="twitter:card" content="summary_large_image"&gt;</pre>');
  assert.deepEqual(checkPage(html), []);
});

test("the prose rules still run on the visible text", () => {
  assert.ok(rules(page('<a class="cta">Unlock AI Insights</a>')).includes("flourish"));
});

test("a second table is caught", () => {
  const table = "<table><tr><th>Store</th><th>Cases</th></tr><tr><td>Leeds</td><td>12</td></tr></table>";
  assert.deepEqual(checkPage(page(table)), []);
  assert.deepEqual(checkPage(page(table + table)), [{ rule: "too-many-tables", at: "2 tables" }]);
});

test("a sentence in a table cell is caught, and a short label is not", () => {
  const html = page(
    "<table><tr><td>Order 4</td><td>Line 4 must be amended to 12 cases before the supplier ships it on Friday.</td></tr></table>",
  );
  const found = checkPage(html);
  assert.deepEqual(found.map((x) => x.rule), ["cell-too-long"]);
  assert.match(found[0].at, /^15 words: Line 4 must be amended/);
});

test("more than four sections is caught, except in a guide or slides", () => {
  const sections = (n) => page(Array.from({ length: n }, (_, i) => `<section><h2>Step ${i + 1} is to send the receipt</h2></section>`).join(""));
  assert.deepEqual(checkPage(sections(4)), []);
  assert.deepEqual(rules(sections(5)), ["too-many-sections"]);
  assert.deepEqual(rules(sections(8), { form: "report" }), ["too-many-sections"]);
  assert.deepEqual(checkPage(sections(5), { form: "guide" }), []);
  assert.deepEqual(checkPage(sections(8), { form: "slides" }), []);
});

test("a list over five items is caught, and a nested list counts its own items", () => {
  const li = (n) => Array.from({ length: n }, (_, i) => `<li>Item ${i + 1}</li>`).join("");
  assert.deepEqual(checkPage(page(`<ul>${li(5)}</ul>`)), []);
  assert.deepEqual(checkPage(page(`<ol>${li(6)}</ol>`)), [{ rule: "list-too-long", at: "6 items in one list" }]);
  // Four items outside and four inside are two lists of four, not one of eight.
  assert.deepEqual(checkPage(page(`<ul>${li(3)}<li>Item 4<ul>${li(4)}</ul></li></ul>`)), []);
});

// The repository that holds this file, or null in an installed copy. Asked from
// the working directory instead, an installed copy under ~/.claude answered with
// that directory's own repository, and read its pages.
const here = dirname(fileURLToPath(import.meta.url));
const ownRepository = () => {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", fileURLToPath(import.meta.url)], { cwd: here, stdio: "pipe" });
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here }).toString().trim();
  } catch {
    return null;
  }
};

test("no page in this repository has its markup reported as prose", (t) => {
  const root = ownRepository();
  if (!root) return t.skip("not inside the repository that holds this plugin");
  const files = execSync("git ls-files '*.html'", { cwd: root }).toString().trim().split("\n")
    .filter((f) => f && existsSync(join(root, f)));
  assert.ok(files.length > 0);
  for (const f of files) {
    for (const x of checkPage(readFileSync(join(root, f), "utf8"))) {
      assert.doesNotMatch(x.at, /^\s*</, `${f}: ${x.rule}: ${x.at}`);
    }
  }
});
