// The fabrik plugin's question-asked hook, run as Claude Code runs a Stop hook: the hook's input on stdin, with a small
// transcript in a scratch folder, and a block on stdout when fabrik's agent asks outside the next-step box or shows
// records as a table. The lines' shapes are a desktop Code session's own, on ~/fabrik: the box's tool in an
// api-request-shape line, the connector's tools as names in a deferred_tools_delta line, the connector's answers as
// {"items": [...]}, a refusal as a tool result with is_error, and this hook's block as a hook_blocking_error attachment.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CARD_REASON, LIST_REASON, NOT_DONE_REASON, REASON, WRAP_UP, YES_REASON } from "../hooks/question-asked.mjs";

const HOOK = fileURLToPath(new URL("../hooks/question-asked.mjs", import.meta.url));
const CONNECTOR = "mcp__50641524-8f56-472f-b730-0b5230bf4743__";
const BOX = { type: "api-request-shape", shape: { tools: [{ name: WRAP_UP }, { name: "Bash" }] } };
const CARDS = { type: "attachment", attachment: { type: "deferred_tools_delta", addedNames: [`${CONNECTOR}list_scopes`, `${CONNECTOR}show_records`] } };
const person = text => ({ type: "user", message: { role: "user", content: text } });
let n = 0;
/** A tool call and its result, refused or carried out. */
const call = (name, { input = {}, answer = "ok", refused = false } = {}) => {
  const id = `t${++n}`;
  return [{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: refused ? "refused" : answer, ...(refused ? { is_error: true } : {}) }] } }];
};
const says = text => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const blocked = reason => ({ type: "attachment", attachment: { type: "hook_blocking_error", hookName: "Stop", blockingError: { blockingError: reason } } });
const items = count => JSON.stringify({ items: Array.from({ length: count }, (_, i) => ({ id: `scope-${i}`, name: `Scope ${i}` })) });
/** The question card drawn with the fabrik command, as the agent runs it with Bash, and one the command refused. */
const COMMAND = "node ~/.claude/plugins/marketplaces/fabrik/plugins/fabrik/cli/fabrik.mjs draw_widget kind=question data_file=question-2026-11-18-103012.json";
const drew = () => call("Bash", { input: { command: COMMAND }, answer: '{\n  "kind": "question",\n  "count": 3,\n  "widget_code": "<section>"\n}' });
const notDrawn = () => call("Bash", { input: { command: COMMAND }, answer: "question-2026-11-18-103012.json lacks rows[0].name. Nothing was drawn.", refused: true });

/** The hook's stdout for a turn of these lines, after the person's message, in a session folder set to the agent. */
function run(turn, { agent = "fabrik:assistant", typed, tools = [BOX, CARDS], extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "question-asked-"));
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ agent }));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, [...tools, person("What is my status?"), ...turn.flat()].map(l => JSON.stringify(l)).join("\n") + "\n");
  const input = { hook_event_name: "Stop", stop_hook_active: false, cwd: dir, transcript_path: file, ...(typed ? { agent_type: typed } : {}), ...extra };
  const out = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout;
}
const BLOCK = JSON.stringify({ decision: "block", reason: REASON });
const LIST_BLOCK = JSON.stringify({ decision: "block", reason: LIST_REASON });

// A desktop Code session answered "What is my status?" with this reply, after two
// connector reads that found nothing, and asked its question in the reply's last line.
const STATUS = "You're signed in to fabrik as Sam Carter, an administrator, and nothing is waiting on you.\n\n" +
  "| Item | Status |\n|---|---|\n| Tasks assigned to you | None |\n| Open projects | None |\n| Business profile | None yet |\n\n" +
  "fabrik holds no business profile yet. Do you want to get started?";
const statusReads = () => [call(`${CONNECTOR}project_list`, { answer: '{"items":[]}' }),
  call(`${CONNECTOR}list_records`, { input: { kind: "model", title: "Business profile" }, answer: '{"items":[],"cutoff":1,"next_cursor":null}' })];
const OFFER = { recap: "Nothing is waiting on you.", ask: "Start getting started now?", actions: [{ label: "Start" }, { label: "Not now" }] };

test("the status reply that asked its question in the reply is sent back, and its rewrite in the box goes ahead", () => {
  assert.equal(run([...statusReads(), says(STATUS)]), BLOCK);
  assert.equal(run([...statusReads(), says(STATUS), blocked(REASON), ...statusReads(), call(WRAP_UP, { input: OFFER }), says(STATUS.replace(/\n\nfabrik holds no[\s\S]*$/, ""))]), "");
});

test("the agent is read from agent_type, or else from the session folder's settings", () => {
  assert.equal(run([says(STATUS)], { agent: "general-purpose", typed: "fabrik:assistant" }), BLOCK);
  assert.equal(run([says(STATUS)], { agent: "general-purpose" }), "");
});

test("a turn is sent back once for a question: a second try with the question still in the reply goes ahead", () => {
  assert.equal(run([says(STATUS), blocked(REASON), says(STATUS)]), "");
});

test("a turn that draws a question card and calls no wrap_up is sent back, and one whose wrap_up was refused is too", () => {
  assert.equal(run([drew(), call("mcp__visualize__show_widget"), says("The scopes are on the card.")]), BLOCK);
  assert.equal(run([drew(), call("mcp__visualize__show_widget"), call(WRAP_UP, { input: OFFER }), says("The scopes are on the card.")]), "");
  assert.equal(run([call(WRAP_UP, { refused: true }), says(STATUS)]), BLOCK);
});

test("another agent, a session with no next-step box, and a reply with no question go ahead", () => {
  assert.equal(run([says(STATUS)], { agent: "general-purpose" }), "");
  assert.equal(run([says(STATUS)], { tools: [CARDS] }), "");
  assert.equal(run([says("Nothing is waiting on you.")]), "");
});

const SCOPES = "You have three scopes.\n\n| Scope | Records |\n|---|---|\n| General | 12 |\n| Clients | 4 |\n| Private | 2 |";
const scopes = (count = 3) => call(`${CONNECTOR}list_scopes`, { answer: items(count) });

test("records the connector returned, shown as a table with no show_records card, are sent back once", () => {
  assert.equal(run([scopes(), says(SCOPES)]), LIST_BLOCK);
  assert.equal(run([scopes(), says(SCOPES), blocked(LIST_REASON), says(SCOPES)]), "");
  assert.equal(run([scopes(), call(`${CONNECTOR}show_records`), says("Your three scopes are on the card.")]), "");
  assert.match(LIST_REASON, /show_records/);
});

// A desktop Code session answered "Show me my scopes" with a table of four scopes after
// list_scopes, and ended on an offer.
const FOUR = "You have four scopes.\n\n| Scope | Records |\n|---|---|\n| General | 12 |\n| Clients | 4 |\n| Private | 2 |\n| Archive | 0 |";
const LIST_COMMAND = "node ~/.claude/plugins/marketplaces/fabrik/plugins/fabrik/cli/fabrik.mjs draw_widget kind=list data_file=list-2026-11-18-112004.json";
const listed = () => call("Bash", { input: { command: LIST_COMMAND }, answer: '{\n  "kind": "list",\n  "count": 4,\n  "question": null,\n  "widget_code": "<section>"\n}' });

test("scopes read with list_scopes and shown as a 4-row table with no card are sent back, naming both cards", () => {
  assert.equal(LIST_REASON, "You showed rows as a table in the reply. Show records on the connector's show_records card, and any other rows, " +
    "such as scopes, on a list card with the fabrik command's draw_widget. Leave the table out.");
  assert.equal(run([scopes(4), says(FOUR)]), LIST_BLOCK);
});

test("the same turn with a list card drawn goes ahead", () => {
  assert.equal(run([scopes(4), listed(), call("mcp__visualize__show_widget"), says(FOUR)]), "");
});

test("a reply that ends on an offer, with no wrap_up, is sent back as a question", () => {
  const offer = "Your four scopes are on the card.\n\nIf you'd like, I can show a scope's records on the card instead.";
  assert.equal(run([scopes(4), listed(), call("mcp__visualize__show_widget"), says(offer)]), BLOCK);
  for (const opener of ["If you'd like,", "If you want", "Want me to", "Shall I", "Should I", "Would you like", "Let me know if"])
    assert.equal(run([says(`Nothing is waiting on you. ${opener} show the records on a card.`)]), BLOCK, opener);
  assert.equal(run([says("Nothing is waiting on you. I can show the records on a card.")]), "");
});

test("a refused show_records call or a refused question card is no card", () => {
  assert.equal(run([scopes(), call(`${CONNECTOR}show_records`, { refused: true }), says(SCOPES)]), LIST_BLOCK);
  assert.equal(run([scopes(), notDrawn(), call(WRAP_UP, { input: OFFER }), says(SCOPES)]), LIST_BLOCK);
});

test("a table after a read of fewer than two records, a table of over 50 rows, and a session with no show_records go ahead", () => {
  assert.equal(run([scopes(1), says(SCOPES)]), "");
  assert.equal(run([call(`${CONNECTOR}list_scopes`, { answer: items(3), refused: true }), says(SCOPES)]), "");
  const long = "| Scope | Records |\n|---|---|\n" + Array.from({ length: 51 }, (_, i) => `| Scope ${i} | 1 |`).join("\n");
  assert.equal(run([scopes(51), says(long)]), "");
  assert.equal(run([scopes(), says(SCOPES)], { tools: [BOX] }), "");
});

test("a turn Claude Code carried on after a Stop hook's block goes ahead, whatever its transcript holds", () => {
  assert.equal(run([says(STATUS)], { extra: { stop_hook_active: true } }), "");
  assert.equal(run([scopes(), says(SCOPES)], { extra: { stop_hook_active: true } }), "");
});

test("a read of one record, whose own fields hold a list, is one record: its fields as a table go ahead", () => {
  const project = JSON.stringify({ id: "p1", title: "Launch", tasks: [{ id: "t1" }, { id: "t2" }, { id: "t3" }] });
  const fields = "The Launch project.\n\n| Field | Value |\n|---|---|\n| Title | Launch |\n| Tasks | 3 |";
  assert.equal(run([call(`${CONNECTOR}project_get`, { answer: project }), says(fields)]), "");
});

test("a question card the command refused is no card: a reply with no question then goes ahead", () => {
  assert.equal(run([notDrawn(), says("The card's data lacked a row's name, so nothing was drawn.")]), "");
});

test("a table outside the reply, or inside fenced code in it, goes ahead", () => {
  assert.equal(run([scopes(), says(SCOPES), call(`${CONNECTOR}show_records`, { refused: true }), says("Your three scopes are General, Clients and Private.")]), "");
  assert.equal(run([scopes(), says("The file holds:\n\n```\n| Scope | Records |\n|---|---|\n| General | 12 |\n| Clients | 4 |\n```")]), "");
});

test("another agent's session goes ahead without its transcript being read", () => {
  const dir = mkdtempSync(join(tmpdir(), "question-asked-"));
  const fifo = join(dir, "session.jsonl");
  execFileSync("mkfifo", [fifo]);
  // A read of a pipe nobody writes to never ends, so the hook only finishes in time if it never reads the transcript.
  const out = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: "Stop", cwd: dir, transcript_path: fifo, agent_type: "general-purpose" }), encoding: "utf8", timeout: 5000 });
  assert.equal(out.status, 0, "the hook read the transcript of a session not on fabrik's agent");
  assert.equal(out.stdout, "");
});

// The replies a desktop Code session gave, each after a card it drew, with the box asked.
const CARD_BLOCK = JSON.stringify({ decision: "block", reason: CARD_REASON });
const boxed = () => call(WRAP_UP, { input: OFFER });
test("a reply that describes a card on the screen is sent back once, and its rewrite goes ahead", () => {
  for (const text of ["The card above shows the Card test note as it will be saved in General. I haven't saved anything yet.",
    "The Card test note is now saved in General. It's on the records card above.",
    "I haven't moved anything yet. The card above shows the three scopes it could go to."]) {
    assert.equal(run([drew(), says(text), boxed()]), CARD_BLOCK, text);
  }
  const again = [drew(), says("The card above shows the note."), boxed(), blocked(CARD_REASON), says("The card above shows the note."), boxed()];
  assert.equal(run(again), "");
  assert.equal(run([drew(), says("The note needs its text."), boxed()]), "");
});
test("a reply that names a card in passing, with no word for where it is, goes ahead", () => {
  assert.equal(run([drew(), says("The mail setup card asks for the password, so it never goes in the chat."), boxed()]), "");
});

// fabrik's agent asked an owner this in the next-step box, after showing lesson 3's save.
const SAVE = { recap: "Lesson 3 is ready to save.", ask: "Save lesson 3 with your yes", actions: [{ label: "Yes" }, { label: "No" }] };
const YES_BLOCK = JSON.stringify({ decision: "block", reason: YES_REASON });

test("a question in the box that says your yes is sent back once, and the plain question goes ahead", () => {
  assert.equal(run([call(WRAP_UP, { input: SAVE }), says("Lesson 3 is ready.")]), YES_BLOCK);
  assert.equal(run([call(WRAP_UP, { input: SAVE }), says("Lesson 3 is ready."), blocked(YES_REASON), call(WRAP_UP, { input: SAVE }), says("Lesson 3 is ready.")]), "");
  assert.equal(run([call(WRAP_UP, { input: { ...SAVE, ask: "Save lesson 3?" } }), says("Lesson 3 is ready.")]), "");
});

test("a reply that says the person's yes is sent back once, and Yes as a button goes ahead", () => {
  assert.equal(run([call(WRAP_UP, { input: { ...SAVE, ask: "Save lesson 3?" } }), says("I save lesson 3 on your yes.")]), YES_BLOCK);
  assert.equal(run([call(WRAP_UP, { input: { ...SAVE, ask: "Save lesson 3?" } }), says("Lesson 3 is ready. Press Yes to save it.")]), "");
  assert.match(YES_REASON, /approval/);
  assert.match(YES_REASON, /Save lesson 3\?/);
});

test("an earlier text block of the turn that says your yes is sent back too", () => {
  assert.equal(run([says("I'll save lesson 3 on your yes."), call(`${CONNECTOR}show_records`), says("Here it is."),
    call(WRAP_UP, { input: { ...SAVE, ask: "Save lesson 3?" } })]), YES_BLOCK);
});

test("a hook whose humanizer checks are missing lets the turn go ahead", () => {
  const dir = mkdtempSync(join(tmpdir(), "question-asked-bare-"));
  mkdirSync(join(dir, "hooks"));
  for (const f of ["question-asked.mjs", "session-rules.mjs"]) copyFileSync(new URL(`../hooks/${f}`, import.meta.url), join(dir, "hooks", f));
  const out = spawnSync(process.execPath, [join(dir, "hooks", "question-asked.mjs")], { input: "{}", encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout, "");
});

// Replies fabrik's agent gave in desktop Code sessions, each with its question asked in the box.
const NOT_DONE_BLOCK = JSON.stringify({ decision: "block", reason: NOT_DONE_REASON });
const NOT_DONE = [
  ["I haven't saved anything yet.", ""],
  ["Card test is still in General. The scopes you can move it to are on the card, and I haven't moved anything yet.",
    "Card test is still in General. The scopes you can move it to are on the card."],
  ["The Card test note is ready to save in General, with the text \"A test of the save question.\" Nothing has been saved yet.",
    "The Card test note is ready to save in General, with the text \"A test of the save question.\""],
];

test("a reply that says what the agent hasn't done is sent back once, and its rewrite without the line goes ahead", () => {
  for (const [text, rewrite] of NOT_DONE) {
    assert.equal(run([boxed(), says(text)]), NOT_DONE_BLOCK, text);
    assert.equal(run([boxed(), says(text), blocked(NOT_DONE_REASON), boxed(), says(text)]), "", text);
    if (rewrite) assert.equal(run([boxed(), says(rewrite)]), "", rewrite);
  }
});

test("each shape of the line is sent back, in the reply or in the box's recap or question", () => {
  for (const line of ["Nothing has been saved.", "Nothing is saved until you agree.", "Nothing moves until you agree.",
    "I haven't changed the note.", "I'll save nothing until you agree to it.", "I won't save it until you say so.",
    "The note is ready, and nothing is saved until you approve it.", "I have not saved it yet."])
    assert.equal(run([boxed(), says(`Lesson 3 is ready. ${line}`)]), NOT_DONE_BLOCK, line);
  assert.equal(run([call(WRAP_UP, { input: { ...OFFER, recap: "Lesson 3 is ready. Nothing has been saved yet." } }), says("Lesson 3 is ready.")]), NOT_DONE_BLOCK);
  assert.equal(run([call(WRAP_UP, { input: { ...OFFER, ask: "Nothing is saved yet: save lesson 3?" } }), says("Lesson 3 is ready.")]), NOT_DONE_BLOCK);
});

test("a reply that reports a real refusal, or what changed, goes ahead", () => {
  assert.equal(run([boxed(), says("Supabase refused the save: the title is taken.")]), "");
  assert.equal(run([boxed(), says("Lesson 3 is saved in General, and nothing else changed.")]), "");
  assert.equal(run([boxed(), says("The scope has nothing in it yet.")]), "");
  assert.match(NOT_DONE_REASON, /what changed/);
});

// A getting-started turn in a desktop Code session previewed its save with save_record, then showed the previewed
// record's fields as a table, where the card rules ask for a question card and a question in the box.
const PREVIEWED = "Here's the record I'll save in General.\n\n| Field | Value |\n|---|---|\n" +
  "| Title | Getting started: who fabrik is for |\n| Summary | fabrik is for both a business and the person's own life. |";
const WHO = { scope: "General", kind: "evidence", title: "Getting started: who fabrik is for",
  fields: { summary: "fabrik is for both a business and the person's own life." }, reason: "Getting started", preview: true };
const previewed = () => call(`${CONNECTOR}save_record`, { input: WHO, answer: '{"preview":true,"request":{"scope":"General"}}' });
const PREVIEW_BLOCK = reason => JSON.stringify({ decision: "block", reason });

test("a save's preview shown as a table is sent back once, and the same turn with a question card goes ahead", async () => {
  assert.equal(JSON.parse(run([previewed(), says(PREVIEWED)]) || "{}").decision, "block");
  const { PREVIEW_REASON } = await import("../hooks/question-asked.mjs");
  assert.match(PREVIEW_REASON ?? "", /question card/);
  assert.match(PREVIEW_REASON, /draw_widget/);
  assert.match(PREVIEW_REASON, /box/);
  assert.equal(run([previewed(), says(PREVIEWED)]), PREVIEW_BLOCK(PREVIEW_REASON));
  assert.equal(run([previewed(), says(PREVIEWED), blocked(PREVIEW_REASON), says(PREVIEWED)]), "");
  assert.equal(run([previewed(), drew(), call(WRAP_UP, { input: { recap: "The record is ready.", ask: "Save it?" } }), says(PREVIEWED)]), "");
});

test("a save without preview, shown as a table, goes ahead", () => {
  const saved = call(`${CONNECTOR}save_record`, { input: { ...WHO, preview: false }, answer: '{"record_id":"r1","version_id":"v1"}' });
  assert.equal(run([saved, says(PREVIEWED)]), "");
});
