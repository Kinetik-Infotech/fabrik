import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const marketplace = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf-8"));

test("each plugin is listed once", () => {
  const names = marketplace.plugins.map((plugin) => plugin.name);
  assert.deepEqual(names.filter((name, i) => names.indexOf(name) !== i), []);
});

test("each listed source folder holds a plugin manifest of the same name", () => {
  for (const plugin of marketplace.plugins) {
    const manifest = join(ROOT, plugin.source, ".claude-plugin", "plugin.json");
    assert.ok(existsSync(manifest), `${plugin.name}: ${manifest} is missing`);
    assert.equal(JSON.parse(readFileSync(manifest, "utf-8")).name, plugin.name);
  }
});
