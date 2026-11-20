// fabrik's look in the desktop and mobile apps: the hooks module hooks.json names, and colours Desktop paints.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { definition } from "../hooks/look.ts";
import { checkColors, makeColors } from "../hooks/make-colors.js";

const HOOKS = fileURLToPath(new URL("../hooks", import.meta.url));

test("Desktop paints fabrik's look", () => {
  const { theme, problems } = makeColors(definition);
  assert.deepEqual(problems.filter(line => line.startsWith("Desktop won't paint")), []);
  assert.deepEqual(checkColors(theme).filter(line => line.startsWith("Desktop won't paint")), []);
});

test("hooks.json names the look's module beside the command hooks", () => {
  const config = JSON.parse(readFileSync(join(HOOKS, "hooks.json"), "utf8"));
  assert.deepEqual(config.modules, ["./look.ts"]);
  assert.ok(config.hooks.SessionStart.length > 0);
});
