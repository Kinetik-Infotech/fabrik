// Sends back a turn of fabrik's agent that asked a question outside the next-step box, showed rows as a table,
// described a card the person already sees, used yes as a noun, or said what the agent hasn't done.
// Runs as a Stop hook, with the hook's input on stdin as Claude Code gives it, and reads the turn from
// `transcript_path`, from the person's last message to the end. A compaction summary is not a message of theirs.
//
// In a session whose tool list holds wrap_up, a turn is sent back when no wrap_up call in it was carried out, and it
// drew a question card with the fabrik command's draw_widget, or ends its reply on a question or an offer. In a session
// whose tool list holds the connector's show_records, a turn is sent back when a connector read in it returned two
// records or more, its reply holds a table of 2 to 50 rows outside fenced code, and no show_records call or list card
// in it was carried out. A turn that read nothing, such as one that lists a skill's steps, keeps its table. A turn is sent
// back when a save's preview was carried out in it, its reply holds a table outside fenced code, and it drew no question
// card. A turn is sent back when any of its text, or the question a wrap_up call in it asks, uses yes as a noun, such
// as "Save lesson 3 with your yes", by the humanizer's check of that form. A turn is sent back when any of its text, or a wrap_up call's recap or
// question, says what the agent hasn't done or won't do until the person agrees, by NOT_DONE's closed list of openers.
//
// Each turn is sent back once for each reason: a turn whose transcript already holds this hook's block for that reason
// goes ahead on it. A turn Claude Code marks stop_hook_active, carried on after a Stop hook's block, always goes ahead,
// so the hook never sends a turn back twice in a row. Every other session's turn goes ahead, and its transcript is
// never read.
import { readFileSync, realpathSync } from "node:fs";
import { argv, stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { EXTENDED, sessionAgent } from "./session-rules.mjs";

/** Whether a text uses yes as a noun, by the humanizer's check of that form. Without the humanizer's file the hook
 *  still loads, and no text uses it. */
let yesAsANoun = () => false;
try { ({ yesAsANoun } = await import("../cli/lib/humanizer-checks.mjs")); } catch {}

export const WRAP_UP = "mcp__ccd_turn__wrap_up";
export const REASON = `You asked a question outside the next-step box. Ask it with ${WRAP_UP}, and leave it out of the reply. ` +
  "Where it is about rows or records, show them first on a question card with the fabrik command's draw_widget, and ask its question word for word. " +
  "Where it has two answers, give them as the two buttons. Where it has more, or none, ask it in the box with no buttons.";
export const LIST_REASON = "You showed rows as a table in the reply. Show records on the connector's show_records card, and any other rows, " +
  "such as scopes, on a list card with the fabrik command's draw_widget. Leave the table out.";

export const PREVIEW_REASON = "You showed a save's preview as a table in the reply. Show the record on a question card with the fabrik command's " +
  "draw_widget, ask its question in the box with " + WRAP_UP + ", and leave the table out.";

export const CARD_REASON = "Your reply describes a card, which the person sees for themselves. Leave out each sentence about the card " +
  "or about your own steps, and say only what changed and what you need from them.";
export const YES_REASON = "You wrote yes as a noun, such as \"your yes\" or \"on the person's yes\", which nobody says. " +
  "Say approval or approve instead. Ask the plain question, such as \"Save lesson 3?\", and never say what pressing a button does.";

export const NOT_DONE_REASON = "Your reply says what you haven't done or won't do until the person agrees, such as \"Nothing has been saved yet\". " +
  "The question in the box already asks for their approval. Leave that sentence out, and say only what changed and what you need from them.";

/** The openers of a sentence, or of a clause after "and", "but" or "so", that says what the agent hasn't done or won't
 *  do until the person agrees. A refusal fabrik gave, such as "Nothing was saved", is left out: it reports what happened. */
export const NOT_DONE = ["Nothing has been saved", "Nothing has been moved", "Nothing has been changed", "Nothing's been saved",
  "Nothing is saved", "Nothing is moved", "Nothing is changed", "Nothing will be saved", "Nothing gets saved",
  "Nothing moves", "Nothing changes", "I haven't saved", "I haven't moved", "I haven't changed", "I have not saved",
  "I have not moved", "I have not changed", "I'll save nothing", "I'll move nothing", "I'll change nothing",
  "I will save nothing", "I won't save", "I won't move", "I won't change", "I will not save"];
/** Phrases that say it anywhere in a sentence, such as "The note is ready, and nothing is saved until you approve it". */
const NOT_DONE_ANYWHERE = ["nothing is saved until", "nothing moves until", "nothing changes until", "nothing is saved before"];

/** Whether a text holds a sentence or clause that says what the agent hasn't done or won't do until the person agrees. */
export function saysNotDone(text) {
  const plain = String(text ?? "").replace(/[*_`]/g, "").replace(/[\u2018\u2019]/g, "'").toLowerCase();
  if (NOT_DONE_ANYWHERE.some(p => plain.includes(p))) return true;
  const clauses = plain.split(/(?<=[.!?:;]|[.!?]["')\]])\s+|\n+|,\s*(?:and|but|so)\s+|\s+(?:and|but|so)\s+(?=i\b|nothing\b)/);
  return clauses.some(c => NOT_DONE.some(o => c.trim().startsWith(o.toLowerCase())));
}

/** A sentence that points at a card on the screen, such as "The card above shows" or "on the records card above". */
const POINTS_AT_CARD = /\bcard (above|below)\b/i;
/** Whether the reply holds a sentence that points at a card. */
export const describesCard = text => POINTS_AT_CARD.test(String(text ?? ""));

/** The openers of a sentence that offers to do something, which is a question asked without a question mark. */
export const OFFERS = ["If you'd like", "If you want", "Want me to", "Shall I", "Should I", "Would you like", "Let me know if"];

// The connector's tools that return a list of records. Each is named mcp__<connector>__<tool> in a session. A tool that
// returns one record, such as get_record or project_get, is left out: a list inside that record is not records.
const READS = ["search", "list_records", "lookup_by_name", "list_scopes", "project_list", "task_list", "task_ready",
  "contact_list", "contact_lookup", "workflow_list", "get_reference"];

/** Whether a line is a message the person wrote, rather than a tool result, a compaction summary or a note from Claude Code. */
function personWrote(line) {
  if (line?.type !== "user" || line.isMeta || line.isSidechain || line.isCompactSummary) return false;
  const content = line.message?.content;
  if (typeof content === "string") return true;
  return Array.isArray(content) && content.some(b => b?.type === "text") && !content.some(b => b?.type === "tool_result");
}

/** The session's lines, each parsed, with the lines that are not JSON left out. */
export function lines(text) {
  return String(text ?? "").split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** The lines since the person's last message. */
const turnLines = parsed => parsed.slice(parsed.findLastIndex(personWrote) + 1).filter(l => !l.isSidechain);

/** The agent's blocks since the person's last message, in order. */
const turnBlocks = parsed => turnLines(parsed).filter(l => l.type === "assistant")
  .flatMap(l => Array.isArray(l.message?.content) ? l.message.content : []);

/** A tool result's text, whether it came as a string or as blocks. */
const resultText = b => typeof b.content === "string" ? b.content
  : Array.isArray(b.content) ? b.content.map(c => c?.text ?? "").join("\n") : "";

/** The results' texts of the calls in the turn whose name and input pass the test, for each call carried out: its
 *  result is there, and is no refusal. */
function results(parsed, test) {
  const ids = turnBlocks(parsed).filter(b => b?.type === "tool_use" && test(String(b.name ?? ""), b.input ?? {})).map(b => b.id);
  return turnLines(parsed).filter(l => l.type === "user")
    .flatMap(l => Array.isArray(l.message?.content) ? l.message.content : [])
    .filter(b => b?.type === "tool_result" && ids.includes(b.tool_use_id) && !b.is_error).map(resultText);
}

/** The kind of card a Bash call draws with the fabrik command's draw_widget, question where it names none, or null. */
function widgetKind(name, input) {
  const command = String(input.command ?? "");
  if (name !== "Bash" || !/\bfabrik\.mjs\b[^\n]*\sdraw_widget\b/.test(command)) return null;
  return command.match(/\skind=["']?(\w+)/)?.[1] ?? "question";
}

/** Whether a wrap_up call in the turn was carried out. */
export const asked = parsed => results(parsed, name => name === WRAP_UP).length > 0;

/** Whether a draw_widget call in the turn drew a card of the kind given: it was carried out, and not refused. */
const drew = (parsed, kind) => results(parsed, (name, input) => widgetKind(name, input) === kind).length > 0;

/** The connector's prefix, mcp__<connector>__, from its show_records tool in the session's tool list, or null. */
export function connector(text) {
  return String(text ?? "").match(/"(mcp__[^"]+__)show_records"/)?.[1] ?? null;
}

/** The number of records a connector's answer holds: its own list, or the longest list among its fields. */
function recordCount(text) {
  let value;
  try { value = JSON.parse(text); } catch { return 0; }
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  return Math.max(0, ...Object.values(value).map(v => Array.isArray(v) ? v.length : 0));
}

/** Whether a connector read carried out in the turn returned two records or more. */
const readRecords = (parsed, prefix) => results(parsed, name => READS.some(r => name === prefix + r)).some(t => recordCount(t) >= 2);

// The connector's tools that save, each of which shows what it would save when called with preview true.
const SAVES = ["save_record", "link_records", "unlink_records", "save_term", "save_relation_type"];

/** Whether a save's preview, a save tool called with preview true, was carried out in the turn. */
const previewed = (parsed, prefix) => results(parsed, (name, input) => input.preview === true && SAVES.some(s => name === prefix + s)).length > 0;

/** Whether a show_records call in the turn was carried out. */
const shownOnCard = (parsed, prefix) => results(parsed, name => name === `${prefix}show_records`).length > 0;

/** Whether this hook already sent the turn back for the reason given, since the person's last message. */
export function sentBack(parsed, reason) {
  return turnLines(parsed).some(l => l.attachment?.type === "hook_blocking_error" && l.attachment.blockingError?.blockingError === reason);
}

/** The Markdown tables in a text outside fenced code, each as its count of rows under the header. A table is a line
 *  holding | followed by a line of |, -, : and spaces with a - in it. */
export function tables(text) {
  let fence = null;
  const rows = String(text ?? "").split("\n").map(l => l.trim()).map(l => {
    const opens = l.match(/^(```|~~~)/)?.[1];
    if (fence) { if (opens === fence) fence = null; return ""; }
    if (opens) { fence = opens; return ""; }
    return l;
  });
  const found = [];
  rows.forEach((l, i) => {
    const rule = rows[i + 1] ?? "";
    if (!l.includes("|") || !rule.includes("|") || !/^\|?[\s|:-]*-[\s|:-]*$/.test(rule)) return;
    let n = 0;
    while ((rows[i + 2 + n] ?? "").includes("|")) n++;
    found.push(n);
  });
  return found;
}

/** The questions a text asks in its own prose: each question mark ending a sentence, outside fenced code, block quotes,
 *  table rows and inline code. */
export function questions(text) {
  let fence = null, count = 0;
  for (const line of String(text ?? "").split("\n")) {
    const opens = line.match(/^\s*(```|~~~)/)?.[1];
    if (fence) { if (opens === fence) fence = null; continue; }
    if (opens) { fence = opens; continue; }
    if (/^\s*(>|\|)/.test(line)) continue;
    count += (line.replace(/`[^`]*`/g, "").match(/\?(?=\s|$|["')\]*_])/g) ?? []).length;
  }
  return count;
}

const texts = parsed => turnBlocks(parsed).filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text);

/** The turn's reply: its last text block. */
const reply = parsed => texts(parsed).at(-1) ?? "";

/** The questions the turn's wrap_up calls put in the box. */
const asks = parsed => turnBlocks(parsed).filter(b => b?.type === "tool_use" && b.name === WRAP_UP).map(b => String(b.input?.ask ?? ""));

/** The recaps and questions the turn's wrap_up calls put in the box. */
const boxTexts = parsed => turnBlocks(parsed).filter(b => b?.type === "tool_use" && b.name === WRAP_UP)
  .flatMap(b => [String(b.input?.recap ?? ""), String(b.input?.ask ?? "")]);

/** The reply's last line. */
const lastLine = parsed => reply(parsed).trim().split("\n").filter(l => l.trim()).at(-1) ?? "";

/** Whether the turn's reply ends on a line that asks a question. */
export function endsOnQuestion(parsed) {
  return questions(lastLine(parsed)) > 0;
}

/** Whether a text's last sentence offers to do something: it opens with one of OFFERS. */
export function offers(text) {
  const last = String(text ?? "").trim().replace(/[*_`]/g, "").split(/(?<=[.!?])\s+/).at(-1) ?? "";
  return OFFERS.some(o => last.toLowerCase().startsWith(o.toLowerCase()));
}

/** Whether the session has the desktop app's next-step box: its tool list, in the transcript, names wrap_up. */
export const hasBox = text => String(text ?? "").includes(`"name":"${WRAP_UP}"`);

/** The hook's answer for one input and its transcript's text: the block with its reason, or null when the turn goes ahead. */
export function decide(input, text) {
  if (input?.stop_hook_active === true || !EXTENDED.includes(sessionAgent(input))) return null;
  const parsed = lines(text);
  if (hasBox(text) && !asked(parsed) && !sentBack(parsed, REASON) && (drew(parsed, "question") || endsOnQuestion(parsed) || offers(lastLine(parsed))))
    return { decision: "block", reason: REASON };
  if (!sentBack(parsed, YES_REASON) && [...texts(parsed), ...asks(parsed)].some(t => yesAsANoun(t))) return { decision: "block", reason: YES_REASON };
  const prefix = connector(text);
  if (prefix && !sentBack(parsed, LIST_REASON) && !shownOnCard(parsed, prefix) && !drew(parsed, "list") && readRecords(parsed, prefix)
    && tables(reply(parsed)).some(n => n >= 2 && n <= 50)) return { decision: "block", reason: LIST_REASON };
  if (prefix && !sentBack(parsed, PREVIEW_REASON) && !drew(parsed, "question") && previewed(parsed, prefix) && tables(reply(parsed)).length > 0)
    return { decision: "block", reason: PREVIEW_REASON };
  if (!sentBack(parsed, CARD_REASON) && describesCard(reply(parsed))) return { decision: "block", reason: CARD_REASON };
  if (!sentBack(parsed, NOT_DONE_REASON) && [...texts(parsed), ...boxTexts(parsed)].some(saysNotDone))
    return { decision: "block", reason: NOT_DONE_REASON };
  return null;
}

const real = file => { try { return realpathSync(file); } catch { return file; } };
// Any failure here lets the turn go ahead: the hook guards where a question is asked and how rows are shown, and nothing else.
if (argv[1] && real(fileURLToPath(import.meta.url)) === real(argv[1])) {
  try {
    let text = "";
    for await (const chunk of stdin) text += chunk;
    const input = JSON.parse(text);
    // Another agent's session goes ahead before its transcript, which can run to megabytes, is read.
    const ours = input?.transcript_path && input.stop_hook_active !== true && EXTENDED.includes(sessionAgent(input));
    const block = ours ? decide(input, readFileSync(input.transcript_path, "utf-8")) : null;
    if (block) stdout.write(JSON.stringify(block));
  } catch {}
  process.exit(0);
}
