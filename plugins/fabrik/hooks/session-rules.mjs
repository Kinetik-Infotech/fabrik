// Adds the card rules to a session on fabrik's agent, as SessionStart's additionalContext:
//
//   node "${CLAUDE_PLUGIN_ROOT}/hooks/session-rules.mjs" "${CLAUDE_PLUGIN_ROOT}/card-rules.md"
//
// The session's agent is the hook input's agent_type, or else the agent the nearest .claude/settings.local.json or
// .claude/settings.json names, in the session folder or a folder above it. A session on fabrik's agent gets the rules,
// and any other session gets nothing.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { argv, stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";

export const EXTENDED = ["fabrik:assistant"];

/** The agent a settings file names, or undefined where the file is missing, unreadable or names none. */
function settingsAgent(file) {
  try {
    const agent = JSON.parse(readFileSync(file, "utf8"))?.agent;
    return typeof agent === "string" && agent ? agent : undefined;
  } catch { return undefined; }
}

/** The session's agent: the hook input's agent_type, or else the agent the nearest folder's .claude/settings.local.json
 *  or .claude/settings.json names, from cwd up, so a session that moved into a subfolder still finds it. Or null. */
export function sessionAgent(input, cwd = input?.cwd ?? process.cwd()) {
  if (typeof input?.agent_type === "string" && input.agent_type) return input.agent_type;
  for (let dir = cwd; ; dir = dirname(dir)) {
    const agent = settingsAgent(join(dir, ".claude", "settings.local.json")) ?? settingsAgent(join(dir, ".claude", "settings.json"));
    if (agent) return agent;
    if (dirname(dir) === dir) return null;
  }
}

/** The hook's output for input and the rules file's text: the rules as additionalContext, or null. */
export function output(input, rules) {
  if (!EXTENDED.includes(sessionAgent(input)) || !rules.trim()) return null;
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: rules } };
}

const real = file => { try { return realpathSync(file); } catch { return file; } };
// A failure here adds nothing, and the session starts without the rules.
if (argv[1] && real(fileURLToPath(import.meta.url)) === real(argv[1])) {
  try {
    let text = "";
    for await (const chunk of stdin) text += chunk;
    let input = {};
    try { input = JSON.parse(text); } catch {}
    const out = output(input, readFileSync(argv[2], "utf8"));
    if (out) stdout.write(JSON.stringify(out));
  } catch {}
  process.exit(0);
}
