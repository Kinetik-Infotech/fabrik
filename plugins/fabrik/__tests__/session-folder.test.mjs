// reconnectCommand, the command whoami offers a person to sign a folder in again.
import test from "node:test";
import assert from "node:assert/strict";

test("the reconnect command quotes every value and drops a malformed account or agent from a transcript", async () => {
  const { reconnectCommand } = await import("../cli/lib/session-folder.mjs");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  // A space or a semicolon is no account: no command is offered.
  assert.equal(reconnectCommand("/x/fabrik", { earlier: { email: "a@b.c; touch pwn" }, platform: "darwin" }).command, null);
  const hostile = { earlier: { email: "a$(touch${IFS}pwn)`id`@b.c", agent: "x; rm -rf ~" }, platform: "darwin" };
  const r = reconnectCommand("/x/it's;$(touch pwn)", hostile);
  assert.equal(r.agent, "fabrik:assistant");
  // Run the arguments through a shell as a person pasting it would: each value arrives whole, and nothing runs.
  const dir = mkdtempSync(join(tmpdir(), "fabrik-quote-"));
  const args = r.command.slice(r.command.indexOf("--folder"));
  const out = execFileSync("/bin/sh", ["-c", `printf '%s\\n' ${args}`], { cwd: dir, encoding: "utf-8" }).trim().split("\n");
  assert.deepEqual(out, ["--folder", "/x/it's;$(touch pwn)", "--email", "a$(touch${ifs}pwn)`id`@b.c", "--agent", "fabrik:assistant"]);
  assert.deepEqual(readdirSync(dir), []);
  const w = reconnectCommand("/x/it's", { ...hostile, platform: "win32" }).command;
  assert.ok(w.includes("--folder '/x/it''s' --email 'a$(touch${ifs}pwn)`id`@b.c'"), w);
});

test("the reconnect command runs fabrik.mjs from Claude Code's copy of the fabrik marketplace", async () => {
  const { reconnectCommand } = await import("../cli/lib/session-folder.mjs");
  const { existsSync, readFileSync } = await import("node:fs");
  const { dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const name = JSON.parse(readFileSync(join(root, ".claude-plugin", "marketplace.json"), "utf-8")).name;
  const prefix = "node ~/.claude/plugins/marketplaces/";
  const command = reconnectCommand("/x/fabrik", { earlier: { email: "a@b.c" }, platform: "darwin" }).command;
  assert.ok(command.startsWith(`${prefix}${name}/plugins/fabrik/cli/fabrik.mjs setup --folder `), command);
  // Claude Code clones the marketplace whole, so the path inside the clone is the path inside this repository.
  const inside = command.slice(prefix.length + name.length + 1, command.indexOf(" setup "));
  assert.ok(existsSync(join(root, inside)), inside);
  assert.ok(command.endsWith("--agent 'fabrik:assistant'"), command);
  const windows = reconnectCommand("/x/fabrik", { earlier: { email: "a@b.c" }, platform: "win32" }).command;
  assert.ok(windows.startsWith(`node "$env:USERPROFILE\\.claude\\plugins\\marketplaces\\${name}\\plugins\\fabrik\\cli\\fabrik.mjs" setup `), windows);
});

test("the reconnect command names fabrik's assistant when the folder named another marketplace's agent", async () => {
  const { reconnectCommand } = await import("../cli/lib/session-folder.mjs");
  const r = reconnectCommand("/x/acme", { setting: "acme:database-operator", earlier: { email: "a@b.c", agent: "acme:assistant" }, configDir: "/nonexistent", platform: "darwin" });
  assert.equal(r.agent, "fabrik:assistant");
  assert.equal(r.agentFrom, "fabrik's own agent");
});

test("the reconnect command names fabrik's assistant when the folder named another plugin of the fabrik marketplace", async t => {
  const { reconnectCommand } = await import("../cli/lib/session-folder.mjs");
  const { workingAgents } = await import("../cli/setup.mjs");
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { dirname, join, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const configDir = mkdtempSync(join(tmpdir(), "fabrik-config-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  mkdirSync(join(configDir, "plugins"));
  const installed = name => [{ scope: "user", installPath: join(root, "plugins", name), version: "1.0.0" }];
  writeFileSync(join(configDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "fabrik@fabrik": installed("fabrik"), "trip-agent@fabrik": installed("trip-agent"), "animator@fabrik": installed("animator") } }));
  for (const agent of ["trip-agent:travel-agent", "animator:animator"]) {
    const r = reconnectCommand("/x/trips", { setting: agent, earlier: { email: "a@b.c", agent }, configDir, platform: "darwin" });
    assert.equal(r.agent, "fabrik:assistant");
    assert.equal(r.agentFrom, "fabrik's own agent");
  }
  // The agent the command names is one setup takes.
  assert.ok(workingAgents(root).includes(reconnectCommand("/x/trips", { setting: "fabrik:assistant", configDir, platform: "darwin" }).agent));
});
