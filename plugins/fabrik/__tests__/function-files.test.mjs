// Every file a hosted function imports is in the list setup and update deploy it with. A file left off the list stays
// on the computer, and Supabase refuses the deploy with "Module not found".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FUNCTIONS } from "../../../setup/build.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, "../../../setup/functions");
const LOCAL = /(?:from\s*|import\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;

for (const f of FUNCTIONS) {
  test(`${f.name} deploys every file it imports`, () => {
    const listed = new Set(f.files.map(normalize));
    const missing = new Set();
    for (const file of f.files.filter((x) => /\.(m?[jt]s)$/.test(x) && !x.endsWith(".d.ts"))) {
      const text = readFileSync(join(SOURCE, f.name, file), "utf-8");
      for (const [, path] of text.matchAll(LOCAL)) {
        const wanted = normalize(join(dirname(file), path));
        if (!listed.has(wanted)) missing.add(wanted);
      }
    }
    assert.deepEqual([...missing], []);
  });
}
