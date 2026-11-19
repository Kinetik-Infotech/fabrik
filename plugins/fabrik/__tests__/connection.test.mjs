// One folder works in one project as one person: the folder's actor file names the person, the actor-file-edit hook
// refuses every write to the actor file, the sign-in's --folder leaves the settings' email out, and the fabrik command
// signs in as the file's person.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIRM = "abcdefghijklmnopqrst";
const OTHER_FIRM = "tsrqponmlkjihgfedcba";
const ACTOR = ".fabrik-actor.json";
const folders = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-folders-")));
  for (const name of ["settings-agent", "elsewhere"]) mkdirSync(join(dir, name));
  writeFileSync(join(dir, "settings-agent", "settings.md"), "# Settings\n");
  return dir;
};

/** A folder with an actor file for the test person, beside the settings' folders. */
const actorFolder = dir => {
  const folder = join(dir, "negotiator");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, ACTOR), JSON.stringify({ project_ref: FIRM, auth_email: "negotiator@example.com" }));
  writeFileSync(join(folder, "notes.md"), "# Notes\n");
  return folder;
};

const EDIT_HOOK = join(ROOT, "hooks", "actor-file-edit.mjs");
const edit = (cwd, file_path, agent_type = "fabrik:assistant") => {
  const out = spawnSync(process.execPath, [EDIT_HOOK], { input: JSON.stringify({ tool_name: "Write", ...(agent_type ? { agent_type } : {}), cwd, tool_input: { file_path } }), encoding: "utf8", env: { PATH: process.env.PATH } });
  return out.stdout === "" ? null : JSON.parse(out.stdout).hookSpecificOutput.permissionDecisionReason;
};

test("no agent, and no session, writes an actor file", () => {
  const dir = folders();
  const folder = actorFolder(dir);
  for (const agent of ["fabrik:assistant", "general-purpose", null]) {
    for (const where of [folder, join(dir, "elsewhere")]) {
      assert.match(edit(where, join(where, ACTOR), agent), /\.fabrik-actor\.json names the person a session on its folder signs in as\. The person makes it with fabrik sign-in/, `${agent} in ${where}`);
    }
  }
});

test("sign-in --folder leaves the settings' email out, so the folder's person gives their own", async () => {
  const { signInArgs } = await import("../cli/fabrik.mjs");
  assert.deepEqual(signInArgs(["--folder", "/x", "--email", "test@example.com"], "admin@example.com").slice(1), ["--folder", "/x", "--email", "test@example.com"]);
  assert.ok(!signInArgs(["--folder", "/x"], "admin@example.com").includes("admin@example.com"));
});

test("the fabrik command in a folder with an actor file signs in as the file's person, beside other saved sign-ins", async () => {
  const { account } = await import("../cli/fabrik.mjs");
  const dir = folders();
  const folder = actorFolder(dir);
  const home = mkdtempSync(join(tmpdir(), "fabrik-cli-home-"));
  for (const [ref, email] of [[FIRM, "negotiator@example.com"], [OTHER_FIRM, "admin@example.com"]]) {
    mkdirSync(join(home, ".config", "supabase-auth", ref), { recursive: true });
    writeFileSync(join(home, ".config", "supabase-auth", ref, `${email}.json`), "{}");
  }
  assert.deepEqual(account(undefined, undefined, home, folder), { ref: FIRM, email: "negotiator@example.com" });
  assert.throws(() => account(undefined, undefined, home, join(dir, "elsewhere")), /More than one sign-in is saved/);
  writeFileSync(join(folder, ACTOR), "{");
  assert.throws(() => account(undefined, undefined, home, folder), /is not JSON/);
});
