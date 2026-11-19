// The fabrik plugin's hooks, run as Claude Code runs them: the tool call on stdin, and a refusal on stdout when any agent
// writes or edits an actor file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = fileURLToPath(new URL("../hooks/", import.meta.url));
const EDIT_HOOK = join(HOOKS, "actor-file-edit.mjs");
const runEdit = input => spawnSync(process.execPath, [EDIT_HOOK], { input: JSON.stringify(input), encoding: "utf8" });
const refusal = out => out.stdout === "" ? null : JSON.parse(out.stdout).hookSpecificOutput;

test("no agent, and no session without one, writes or edits an actor file, in any letter case", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-actor-")));
  for (const agent_type of ["fabrik:assistant", "general-purpose", undefined]) {
    for (const tool_name of ["Write", "Edit"]) {
      for (const name of [".fabrik-actor.json", ".FABRIK-ACTOR.JSON"]) {
        const out = runEdit({ tool_name, agent_type, cwd: dir, tool_input: { file_path: join(dir, name) } });
        assert.equal(out.status, 0, out.stderr);
        assert.equal(refusal(out)?.permissionDecision, "deny", `${agent_type} ${tool_name} ${name}`);
        assert.match(refusal(out).permissionDecisionReason, /names the person a session on its folder signs in as\. The person makes it with fabrik sign-in/);
      }
    }
  }
});

test("fabrik's agent writes and edits any other file, in any folder", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-actor-")));
  for (const file of [join(dir, "notes.md"), join(dir, "inner", "report.xlsx"), join(tmpdir(), "elsewhere.md"), join(dir, ".hidden.md")]) {
    for (const tool_name of ["Write", "Edit"]) {
      const out = runEdit({ tool_name, agent_type: "fabrik:assistant", cwd: dir, tool_input: { file_path: file } });
      assert.equal(out.status, 0, out.stderr);
      assert.equal(out.stdout, "", file);
    }
  }
});

test("hooks.json runs only hook files the plugin ships", () => {
  const config = JSON.parse(readFileSync(join(HOOKS, "hooks.json"), "utf8"));
  const commands = Object.values(config.hooks).flat().flatMap(entry => entry.hooks.map(hook => hook.command));
  assert.ok(commands.length > 0);
  for (const command of commands) {
    const file = /hooks\/([\w-]+\.mjs)/.exec(command)?.[1];
    assert.ok(file && existsSync(join(HOOKS, file)), command);
  }
  assert.deepEqual(Object.keys(config.hooks).sort(), ["PreToolUse", "SessionStart", "Stop"]);
});
