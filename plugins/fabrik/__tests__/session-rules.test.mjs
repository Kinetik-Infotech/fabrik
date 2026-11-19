// The fabrik plugin's session-rules hook, run as Claude Code runs a SessionStart hook: the hook's input on stdin, and the
// card rules as additionalContext on stdout for a session on fabrik's agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = fileURLToPath(new URL("..", import.meta.url));
const HOOK = join(PLUGIN, "hooks", "session-rules.mjs");
const RULES = join(PLUGIN, "card-rules.md");

/** A session folder whose .claude/settings.json names the agent, or a folder with no settings. */
function folder(agent) {
  const dir = mkdtempSync(join(tmpdir(), "fabrik-rules-"));
  if (agent) {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ agent }));
  }
  return dir;
}

/** The hook's stdout for one SessionStart input, run with the plugin's own command line. */
function run(input) {
  const out = spawnSync(process.execPath, [HOOK, RULES], { input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", ...input }), encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}

test("a session on fabrik's agent starts with the card rules, named by agent_type or by the folder's settings", () => {
  const rules = readFileSync(RULES, "utf8");
  const expected = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: rules } });
  assert.equal(run({ agent_type: "fabrik:assistant", cwd: folder() }), expected);
  assert.equal(run({ cwd: folder("fabrik:assistant") }), expected);
});

test("another agent's session, and a session with no agent, start with nothing added", () => {
  assert.equal(run({ agent_type: "general-purpose", cwd: folder("fabrik:assistant") }), "");
  assert.equal(run({ cwd: folder("general-purpose") }), "");
  assert.equal(run({ cwd: folder() }), "");
});

test("the plugin registers the hook at SessionStart with the rules file, and the Stop hook beside it", () => {
  const hooks = JSON.parse(readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8")).hooks;
  const commands = event => hooks[event].flatMap(h => h.hooks.map(c => c.command));
  assert.ok(commands("SessionStart").includes('node "${CLAUDE_PLUGIN_ROOT}/hooks/session-rules.mjs" "${CLAUDE_PLUGIN_ROOT}/card-rules.md"'));
  assert.ok(commands("Stop").includes('node "${CLAUDE_PLUGIN_ROOT}/hooks/question-asked.mjs"'));
});

test("the agent is found in settings.local.json, and from a subfolder the session moved into", () => {
  const rules = readFileSync(RULES, "utf8");
  const expected = JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: rules } });
  const local = folder();
  mkdirSync(join(local, ".claude"));
  writeFileSync(join(local, ".claude", "settings.local.json"), JSON.stringify({ agent: "fabrik:assistant" }));
  assert.equal(run({ cwd: local }), expected);
  const sub = join(folder("fabrik:assistant"), "notes", "2026");
  mkdirSync(sub, { recursive: true });
  assert.equal(run({ cwd: sub }), expected);
});
