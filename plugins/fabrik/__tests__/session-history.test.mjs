// The session history hook: each session with the database operator copied as Markdown into the agent folder's
// sessions/ folder, holding only what the person and the agent wrote, and the upload's choice of scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { copySession } from "../hooks/session-copy.mjs";
import { run } from "../hooks/session-history.mjs";
import { sessionsScope } from "../hooks/session-upload.mjs";
import { cpSync } from "node:fs";

const HOOK = fileURLToPath(new URL("../hooks/session-history.mjs", import.meta.url));
const ID = "f3f32ac1-9ea0-4a5e-b4f5-abff4a7998f1";

// One line of each kind, in the shapes Claude Code writes them, as read from the agent folder's sessions.
const LINES = [
  { type: "user", sessionId: ID, isSidechain: false, timestamp: "2026-10-05T13:01:04.340Z", message: { role: "user", content: "draw project warehouse map" } },
  { type: "assistant", sessionId: ID, isSidechain: false, timestamp: "2026-10-05T13:01:10.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET THINKING" }] } },
  { type: "assistant", sessionId: ID, isSidechain: false, timestamp: "2026-10-05T13:01:11.000Z", message: { role: "assistant", content: [{ type: "text", text: "Still reading the audit log." }, { type: "tool_use", id: "t1", name: "rpc", input: { function: "fabrik_get_audit" } }] } },
  { type: "user", sessionId: ID, isSidechain: false, timestamp: "2026-10-05T13:01:12.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "TOOL OUTPUT" }] } },
  { type: "assistant", sessionId: ID, isSidechain: false, timestamp: "2026-10-05T13:01:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "I've drawn the map." }] } },
  { type: "user", sessionId: ID, isSidechain: false, isMeta: true, timestamp: "2026-10-05T13:02:00.000Z", message: { role: "user", content: [{ type: "text", text: "META LINE" }] } },
  { type: "user", sessionId: ID, isSidechain: true, timestamp: "2026-10-05T13:02:01.000Z", message: { role: "user", content: "SUBAGENT TURN" } },
  { type: "user", sessionId: ID, isSidechain: false, timestamp: "2026-10-05T13:02:02.000Z", message: { role: "user", content: "<bash-input>cat secrets.env</bash-input>" } },
  { type: "attachment", sessionId: ID, attachment: { type: "file", content: "ATTACHMENT" } },
  { type: "user", sessionId: ID, isSidechain: false, timestamp: "2026-10-05T13:04:19.538Z", message: { role: "user", content: "show me what's blocking 1.3<system-reminder>REMINDER</system-reminder>" } },
  { type: "custom-title", customTitle: "Project warehouse map", sessionId: ID },
];

function session(dir, lines = LINES, id = ID) {
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

const folders = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-sessions-")));
  const agent = join(root, "agent"), project = join(root, "project");
  mkdirSync(agent); mkdirSync(project);
  return { root, agent, project, options: { CLAUDE_PLUGIN_OPTION_AGENT_FOLDER: agent } };
};

test("the copy holds only what the person and the agent wrote, with the title and times", () => {
  const { project } = folders();
  const copy = copySession(session(project));
  assert.match(copy.name, /^2026-10-05-project-warehouse-map-f3f32ac1\.md$/);
  assert.match(copy.text, /^# Project warehouse map\n/);
  assert.match(copy.text, /## Person · 2026-10-05 \d\d:01\n\ndraw project warehouse map/);
  assert.match(copy.text, /## Agent · 2026-10-05 \d\d:01\n\nStill reading the audit log\.\n\nI've drawn the map\./);
  assert.match(copy.text, /show me what's blocking 1\.3\n/);
  for (const left of ["SECRET THINKING", "TOOL OUTPUT", "META LINE", "SUBAGENT TURN", "secrets.env", "ATTACHMENT", "REMINDER", "fabrik_get_audit"]) assert.ok(!copy.text.includes(left), left);
  assert.equal(copy.text.match(/^## /gm).length, 3);
});

test("a session start copies each session in the project folder and starts one upload", () => {
  const { agent, project, options } = folders();
  const first = session(project);
  session(project, LINES.map(l => ({ ...l, sessionId: "0a1b2c3d-0000-0000-0000-000000000000" })).filter(l => l.type !== "custom-title"), "0a1b2c3d-0000-0000-0000-000000000000");
  const uploads = [];
  const out = run({ hook_event_name: "SessionStart", cwd: agent, transcript_path: first }, options, (...a) => uploads.push(a));
  assert.deepEqual(readdirSync(join(agent, "sessions")).sort(), ["2026-10-05-project-warehouse-map-f3f32ac1.md", "2026-10-05-session-0a1b2c3d.md"]);
  assert.equal(out.written.length, 2);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0][1], "settings");
});

test("a copy newer than its session is left, and a renamed session replaces its old copy", () => {
  const { agent, project, options } = folders();
  const file = session(project, LINES.filter(l => l.type !== "custom-title"));
  run({ hook_event_name: "Stop", cwd: agent, transcript_path: file }, options, () => {});
  const again = run({ hook_event_name: "Stop", cwd: agent, transcript_path: file }, options, () => {});
  assert.equal(again.written.length, 0);
  session(project);
  const later = new Date(Date.now() + 5000);
  utimesSync(file, later, later);
  const renamed = run({ hook_event_name: "Stop", cwd: agent, transcript_path: file }, options, () => {});
  assert.deepEqual(renamed.replaced, ["2026-10-05-session-f3f32ac1.md"]);
  assert.deepEqual(readdirSync(join(agent, "sessions")), ["2026-10-05-project-warehouse-map-f3f32ac1.md"]);
});

test("at a session start, a copy whose upload is not noted goes up again", () => {
  const { agent, project, options } = folders();
  const file = session(project);
  run({ hook_event_name: "Stop", cwd: agent, transcript_path: file }, options, () => {});
  const uploads = [];
  run({ hook_event_name: "SessionStart", cwd: agent, transcript_path: file }, options, (...a) => uploads.push(a));
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0][2].written.map(f => f.split(/[\\/]/).at(-1)), ["2026-10-05-project-warehouse-map-f3f32ac1.md"]);
});

test("a session on any other folder writes nothing", () => {
  const { root, agent, project, options } = folders();
  const out = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: "Stop", cwd: root, transcript_path: session(project) }), encoding: "utf8", env: { ...process.env, ...options } });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, "");
  assert.ok(!existsSync(join(agent, "sessions")));
});

test("input it cannot read writes nothing and lets the session go on", () => {
  const out = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(out.status, 0);
  assert.equal(out.stdout, "");
});

test("the upload, run from the plugin cache as the hook starts it, loads the fabrik plugin's own library and runs to its end", () => {
  // Claude Code installs each plugin under its own version: cache/fabrik/fabrik/<version>.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fabrik-cache-")));
  const fabrik = join(root, "cache", "fabrik", "fabrik", "0.1.0"), config = join(root, "config");
  const plugin = fileURLToPath(new URL("..", import.meta.url));
  cpSync(join(plugin, "hooks"), join(fabrik, "hooks"), { recursive: true });
  cpSync(join(plugin, "cli"), join(fabrik, "cli"), { recursive: true });
  mkdirSync(config, { recursive: true });
  const sessions = join(root, "sessions"); mkdirSync(sessions);
  const out = spawnSync(process.execPath, [join(fabrik, "hooks", "session-upload.mjs"), sessions, "settings", "x.md"], { encoding: "utf8", env: { ...process.env, HOME: root, USERPROFILE: root, CLAUDE_CONFIG_DIR: config } });
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stderr, /Cannot find module/);
  assert.ok(!existsSync(join(sessions, "upload-problems.log")), "no sign-in, so nothing is tried and nothing logged");
});

test("the sessions scope is the one the actor's own live, standing, whole-scope grant with create gives", () => {
  const scopes = [{ scope_id: "a", code: "general" }, { scope_id: "b", code: "sessions_sam" }, { scope_id: "c", code: "sessions_alex" }];
  const grant = (scope_id, extra = {}) => ({ scope_id, executor_actor_id: "sam", mode: "standing_permission", record_id: null, own_records: false, revoked_at: null, expires_at: null, allowed_actions: ["read", "create", "edit", "delete"], ...extra });
  assert.equal(sessionsScope([grant("a"), grant("b")], scopes, "sam"), "sessions_sam");
  assert.equal(sessionsScope([grant("b", { revoked_at: "2026-10-01T00:00:00Z" }), grant("b", { expires_at: "2026-01-01T00:00:00Z" })], scopes, "sam"), null);
  assert.equal(sessionsScope([grant("b", { record_id: "r" }), grant("b", { allowed_actions: ["read"] }), grant("b", { own_records: true }), grant("b", { mode: "explicit_approval" })], scopes, "sam"), null);
  assert.equal(sessionsScope([grant("b")], scopes, undefined), null);
});

test("an administrator, who sees the grants they approved for others, uploads to their own sessions scope alone", () => {
  // The order an administrator's fabrik_get_authorisations can give: another person's grant before the actor's own.
  const scopes = [{ scope_id: "j", code: "sessions_alex" }, { scope_id: "o", code: "sessions_sam" }];
  const grant = (scope_id, executor_actor_id) => ({ scope_id, executor_actor_id, mode: "standing_permission", record_id: null, own_records: false, revoked_at: null, expires_at: null, allowed_actions: ["read", "create", "edit", "delete"] });
  assert.equal(sessionsScope([grant("j", "alex"), grant("o", "sam")], scopes, "sam"), "sessions_sam");
  assert.equal(sessionsScope([grant("j", "alex")], scopes, "sam"), null);
});

test("a session on a folder with an actor file keeps its copies there, and uploads as the file's account", async () => {
  const { root, project, options } = folders();
  const actor = join(root, "test-agent");
  mkdirSync(actor);
  writeFileSync(join(actor, ".fabrik-actor.json"), JSON.stringify({ project_ref: "abcdefghijklmnopqrst", auth_email: "test@example.com", upload_folder: "" }));
  const uploads = [];
  const out = run({ hook_event_name: "Stop", cwd: actor, transcript_path: session(project) }, options, (...a) => uploads.push(a));
  assert.deepEqual(out.written.map(f => f.split(/[\\/]/).at(-1)), ["2026-10-05-project-warehouse-map-f3f32ac1.md"]);
  assert.equal(out.written[0].startsWith(join(actor, "sessions")), true);
  assert.equal(uploads[0][1], "actor");
  const { actorConnection } = await import("../hooks/session-upload.mjs");
  assert.deepEqual(actorConnection(join(actor, "sessions")), { ref: "abcdefghijklmnopqrst", email: "test@example.com" });
  writeFileSync(join(actor, ".fabrik-actor.json"), "{");
  assert.deepEqual(run({ hook_event_name: "Stop", cwd: actor, transcript_path: session(project) }, options, (...a) => uploads.push(a)), { written: [], replaced: [] });
  assert.equal(actorConnection(join(actor, "sessions")), null);
});
