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
  for (const plugin of marketplace.plugins.filter((p) => typeof p.source === "string")) {
    const manifest = join(ROOT, plugin.source, ".claude-plugin", "plugin.json");
    assert.ok(existsSync(manifest), `${plugin.name}: ${manifest} is missing`);
    assert.equal(JSON.parse(readFileSync(manifest, "utf-8")).name, plugin.name);
  }
});

// A plugin kept in its own repository is listed by where Claude Code fetches it from, on Kinetik's GitHub.
test("each plugin kept elsewhere comes from a Kinetik-Infotech repository on GitHub", () => {
  for (const plugin of marketplace.plugins.filter((p) => typeof p.source !== "string")) {
    const { source, repo, url, path } = plugin.source;
    if (source === "github") assert.match(repo, /^Kinetik-Infotech\/[\w.-]+$/, plugin.name);
    else if (source === "git-subdir") {
      assert.match(url, /^Kinetik-Infotech\/[\w.-]+$/, plugin.name);
      assert.equal(path, `plugins/${plugin.name}`, plugin.name);
    } else assert.fail(`${plugin.name}: source ${source} isn't github or git-subdir`);
  }
});
