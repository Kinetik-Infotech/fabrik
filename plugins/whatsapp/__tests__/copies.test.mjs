// The plugin carries copies of fabrik's sign-in code, since an installed plugin can't import another plugin's files.
// Each copy is fabrik's file below its two-line header.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

for (const name of ["session.mjs", "actor-file.mjs"]) {
  test(`mcp/lib/${name} is fabrik's cli/lib/${name}`, () => {
    const copy = readFileSync(join(ROOT, "whatsapp", "mcp", "lib", name), "utf8");
    const source = readFileSync(join(ROOT, "fabrik", "cli", "lib", name), "utf8");
    assert.equal(copy.slice(copy.indexOf("\n\n") + 2), source);
  });
}
