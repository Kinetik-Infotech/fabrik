// Refuses any agent's Write and Edit of an actor file. The actor file names the person a session on its folder signs in
// as, and the person makes it with fabrik sign-in, so no agent changes which account a folder works as. Every other
// Write and Edit goes ahead. Reads the tool call from stdin, as Claude Code's PreToolUse hooks receive it.
import { basename } from "node:path";
import { stdin, stdout } from "node:process";
import { ACTOR_FILE } from "../cli/lib/actor-file.mjs";

let text = "";
for await (const chunk of stdin) text += chunk;
let call;
try { call = JSON.parse(text); } catch { process.exit(0); }

if (basename(String(call?.tool_input?.file_path ?? "")).toLowerCase() === ACTOR_FILE) {
  stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: `${ACTOR_FILE} names the person a session on its folder signs in as. The person makes it with fabrik sign-in, given the folder.` } }));
}
