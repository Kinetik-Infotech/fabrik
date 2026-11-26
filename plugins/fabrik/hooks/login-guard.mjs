// Refuses every agent, and every session without one, the calls that open or save a shared login's password. A person
// opens, types and generates a password on the Login card alone, which the connector's show_logins shows, and no
// password ever passes through the model. Reads the tool call from stdin, as Claude Code's PreToolUse hooks receive it.
//
// loginCall names the calls refused:
// - the rpc tool, on any server, of fabrik_open_login or fabrik_save_login, in any schema and case;
// - the Login card's login_open, login_save and login_remove, on any server, and card_call of any of them;
// - any other tool on a server, call_function, execute_sql and a deploy among them, whose arguments match LOGIN_TEXT;
// - a Bash or PowerShell command, and an Agent or Task prompt, that match LOGIN_TEXT.
// LOGIN_TEXT names the two functions, the card's tools, Vault's decrypted secrets and Vault's secret tables and functions.
// Every other call goes ahead.
import { realpathSync } from "node:fs";
import { argv, stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

export const LOGIN_REFUSED = "A shared login's password is opened, typed and generated on the Login card alone. Show the Login card with the fabrik connector's show_logins.";
const LOGIN_FUNCTIONS = ["fabrik_open_login", "fabrik_save_login"];
const LOGIN_TOOLS = ["login_open", "login_save", "login_remove"];
export const LOGIN_TEXT = /fabrik_(open|save)_login|login_(open|save)|login_secret_|decrypted_secret|_crypto_aead|\bvault\b"?\s*\.\s*"?[a-z_]/i;

/** Each string in a call's input as given, and again with SQL's block comments and double quotes taken out, so a
 * quoted or commented name is read as the database reads it. */
export function textsOf(input) {
  const out = [];
  (function walk(v) {
    if (typeof v === "string") out.push(v, v.replace(/\/\*[\s\S]*?\*\//g, "").replaceAll('"', ""));
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  })(input);
  return out;
}
const namesRoute = input => textsOf(input).some(s => LOGIN_TEXT.test(s));

/** A tool's server and name: mcp__<server>__<tool>, or a built-in tool by its own name, with no server. */
export function toolOf(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name ?? ""));
  return m ? { server: m[1], tool: m[2] } : { server: null, tool: String(name ?? "") };
}

/** Whether the call opens or saves a shared login's password, by any route the hook sees. */
export function loginCall(toolName, input = {}) {
  const { server, tool } = toolOf(toolName);
  if (server) {
    const fn = String(input?.function ?? "").trim().toLowerCase().replaceAll('"', "").replace(/^[a-z_][a-z0-9_]*\./, "");
    if (tool === "rpc" && LOGIN_FUNCTIONS.includes(fn)) return true;
    if (LOGIN_TOOLS.includes(tool)) return true;
    if (tool === "card_call") return LOGIN_TOOLS.includes(String(input?.name ?? "").trim());
    // Any other tool, such as call_function, execute_sql or a deploy, is refused when its arguments name a route.
    return namesRoute(input);
  }
  if (["Bash", "PowerShell"].includes(tool)) return namesRoute(input?.command ?? "");
  if (["Agent", "Task"].includes(tool)) return namesRoute(input?.prompt ?? "");
  return false;
}

const real = file => { try { return realpathSync(file); } catch { return file; } };
if (argv[1] && real(fileURLToPath(import.meta.url)) === real(argv[1])) {
  let text = "";
  for await (const chunk of stdin) text += chunk;
  let call;
  try { call = JSON.parse(text); } catch { process.exit(0); }
  if (loginCall(call?.tool_name, call?.tool_input)) {
    stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: LOGIN_REFUSED } }));
  }
}
