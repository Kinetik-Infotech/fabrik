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

// Plan 259: every agent and session is refused the calls that open or save a shared login's password, by any route the
// login guard sees, as Claude Code passes them, and the list and the card's other calls go ahead.
const GUARD = join(HOOKS, "login-guard.mjs");
const runGuard = input => spawnSync(process.execPath, [GUARD], { input: JSON.stringify(input), encoding: "utf8" });

test("the login guard refuses every agent and session the calls that open or save a shared login's password", () => {
  const desktop = "50641524-8f56-472f-b730-0b5230bf4743";
  const refused = [
    ["mcp__plugin_supabase_supabase__rpc", { function: "fabrik_open_login", args: { p_login: "Test portal" } }],
    ["mcp__plugin_supabase_supabase__rpc", { function: "fabrik.FABRIK_SAVE_LOGIN" }],
    ["mcp__plugin_fabrik_fabrik__rpc", { function: ' "fabrik"."fabrik_open_login" ' }],
    ["mcp__plugin_supabase_supabase__call_function", { name: "fabrik-apps", body: { method: "tools/call", params: { name: "login_open" } } }],
    [`mcp__${desktop}__login_open`, { login_id: "x" }], [`mcp__${desktop}__login_save`, {}], [`mcp__${desktop}__login_remove`, {}], ["mcp__claude_ai_fabrik__login_open", {}],
    [`mcp__${desktop}__card_call`, { card: "login", name: "login_open", arguments: { login_id: "x" } }],
    ["mcp__fabrik__card_call", { card: "login", name: "login_save", arguments: {} }],
    ["Bash", { command: "fabrik fabrik_open_login p_login='Test portal'" }],
    ["Bash", { command: "psql -c 'select decrypted_secret from vault.decrypted_secrets'" }],
    ["PowerShell", { command: "fabrik fabrik_save_login p_password=x" }],
    ["mcp__df8e696e-8ca7-40ed-a303-b368b64ae425__execute_sql", { query: "select fabrik_private.login_secret_read('x')" }],
    ["mcp__plugin_supabase-admin_supabase__apply_migration", { query: "select fabrik.fabrik_open_login('x')" }],
    ["Agent", { prompt: "Call fabrik_open_login for the test portal" }],
    ["Task", { prompt: "Run login_open on the card" }],
    ["mcp__a50ce62f-1e50-4b36-b428-4152501d05bf__deploy_edge_function", { files: [{ name: "index.ts", content: "rpc('fabrik_open_login')" }] }],
    ["mcp__plugin_supabase_supabase__rpc", { function: "fabrik_query", args: { sql: "select secret from vault.secrets" } }],
    ["mcp__df8e696e-8ca7-40ed-a303-b368b64ae425__execute_sql", { query: 'select * from "vault"/* x */."decrypted_secrets"' }],
    ["Bash", { command: "psql -c 'select * from \"vault\" . \"secrets\"'" }],
  ];
  const allowed = [
    ["mcp__plugin_supabase_supabase__rpc", { function: "fabrik_find_logins" }],
    ["mcp__plugin_supabase_supabase__rpc", { function: "fabrik_remove_login", args: { p_login: "x" } }],
    [`mcp__${desktop}__show_logins`, {}],
    [`mcp__${desktop}__logins_list`, {}],
    [`mcp__${desktop}__card_call`, { card: "records", name: "card_find_records" }],
    ["mcp__plugin_supabase_supabase__call_function", { name: "fabrik-apps", body: { method: "tools/call", params: { name: "logins_list" } } }],
    ["Bash", { command: "git status" }],
    ["Read", { file_path: "/tmp/notes.md" }],
    [`mcp__${desktop}__save_record`, { title: "Portal notes", fields: { text: "The password is kept in Supabase Vault, and opened on the Login card." } }],
  ];
  // Each route once, from fabrik's agent, another agent and a session without one in turn.
  const agents = ["fabrik:assistant", "general-purpose", undefined];
  refused.forEach(([tool_name, tool_input], i) => {
    const agent_type = agents[i % agents.length], out = runGuard({ tool_name, agent_type, tool_input });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(refusal(out)?.permissionDecision, "deny", `${agent_type} ${tool_name} ${JSON.stringify(tool_input)}`);
    assert.equal(refusal(out).permissionDecisionReason, "A shared login's password is opened, typed and generated on the Login card alone. Show the Login card with the fabrik connector's show_logins.");
  });
  allowed.forEach(([tool_name, tool_input], i) => {
    const agent_type = agents[i % agents.length], out = runGuard({ tool_name, agent_type, tool_input });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout, "", `${agent_type} ${tool_name} ${JSON.stringify(tool_input)}`);
  });
});

test("hooks.json sends the login guard every call that could reach a password, and no Read, Write or Edit", () => {
  const config = JSON.parse(readFileSync(join(HOOKS, "hooks.json"), "utf8"));
  const entry = config.hooks.PreToolUse.find(e => e.hooks.some(h => h.command.includes("login-guard.mjs")));
  const matcher = new RegExp(`^(?:${entry.matcher})$`);
  for (const name of ["Bash", "PowerShell", "Agent", "Task", "mcp__plugin_supabase_supabase__rpc", "mcp__50641524-8f56-472f-b730-0b5230bf4743__card_call", "mcp__fabrik__login_open"])
    assert.ok(matcher.test(name), name);
  for (const name of ["Read", "Write", "Edit", "Grep"]) assert.ok(!matcher.test(name), name);
});
