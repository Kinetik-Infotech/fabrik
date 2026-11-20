// fabrik.tech's llms.txt and llms-full.txt are built from README.md and docs/guides/, and kept in step with them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build, guides } from "../build-llms.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("site/llms.txt and site/llms-full.txt match what README.md and the guides build", () => {
  for (const [path, text] of Object.entries(build(ROOT)))
    assert.equal(readFileSync(join(ROOT, path), "utf8"), text, `${path} is out of date: run node scripts/build-llms.mjs`);
});

test("llms.txt links every guide with its first sentence, and llms-full.txt holds every guide whole, with no relative links", () => {
  const files = readdirSync(join(ROOT, "docs", "guides")).filter(f => /^\d+-.+\.md$/.test(f));
  const { "site/llms.txt": llms, "site/llms-full.txt": full } = build(ROOT);
  assert.equal(guides(ROOT).length, files.length);
  for (const g of guides(ROOT)) {
    assert.ok(llms.includes(`/docs/guides/${g.file}): ${g.first}`), g.file);
    assert.ok(!g.first.startsWith("<"), g.file);
    assert.ok(full.includes(`Source: https://raw.githubusercontent.com/Kinetik-Infotech/fabrik/main/docs/guides/${g.file}`), g.file);
  }
  assert.match(llms, /^# fabrik\n\n> /);
  assert.doesNotMatch(full, /\]\((?!https?:|#|mailto:)/);
  assert.doesNotMatch(full, /<img/);
});
