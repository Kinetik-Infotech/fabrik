#!/usr/bin/env node
// The WhatsApp plugin's MCP server over stdio. It reads the person's WhatsApp as a linked device, and saves each chat
// in their private fabrik scope. It has no tool that sends: it links, waits for the link, says how the link stands,
// checks for new messages, and removes the link.
//
// The link's keys stay on this computer, in ~/.config/fabrik/whatsapp/<fabrik email>, a folder only the person can
// read. They never go to fabrik, and no tool's answer holds them.
//
// The protocol on stdio is newline-delimited JSON-RPC, written directly as fabrik's relay does, so the server needs
// Node and Baileys alone. Baileys loads on the first call that connects.
//
// whatsapp_timer hands the check to launchd on a Mac (timer.mjs), which runs timed-check.mjs every few hours with no
// Claude session.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { halfLinked, pullWhatsApp } from "./baileys.mjs";
import { CHATS_PER_CHECK, chatsIn, createWhatsAppPull, GROUPS, LIDS, NAMES, PENDING, readPending } from "./pull.mjs";
import { MONTHS, TITLED } from "./archive.mjs";
import { normalizeE164 } from "./normalize.mjs";
import { whichSignIn } from "./fabrik.mjs";
import { archiveFor, countHistory, credsOf, keysPath, lockDown, makeKeysFolder, saveSettings, settingsOf, stateOf } from "./keys.mjs";
import { DEFAULT_HOURS, timerPaths, timerStatus, turnOff, turnOn } from "./timer.mjs";

const SERVER = { name: "whatsapp", version: "1" };
const DEFAULT_PROTOCOL = "2025-06-18";
const folder = process.env.FABRIK_SESSION_FOLDER || process.cwd();
/** Stand-ins the tests pass, through the environment, for the connection and for fabrik. */
const hooks = process.env.WHATSAPP_TEST_HOOKS ? await import(process.env.WHATSAPP_TEST_HOOKS) : {};

const INSTRUCTIONS = "Reads the person's WhatsApp and saves each chat in their private fabrik scope, as whatsapp/<chat>.md. "
  + "It never sends, replies, reacts or marks a message read, and has no tool that could: Meta, which owns WhatsApp, bans numbers that send automated messages. Use the whatsapp skill to link, check and read.";

const send = msg => process.stdout.write(JSON.stringify(msg) + "\n");
const log = (op, fields = {}) => process.stderr.write(`[whatsapp] op=${op} ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(" ")}\n`);
const text = value => ({ content: [{ type: "text", text: value }] });
const refused = value => ({ content: [{ type: "text", text: value }], isError: true });

/** What the keys folder keeps when a link is dropped: the messages waiting to be saved, the chats' files and group
 * names, the LID and phone pairs, people's names, the scope. */
const KEPT = new Set([PENDING, "chats.json", MONTHS, GROUPS, TITLED, LIDS, NAMES, "settings.json"]);

/** Deletes the link's keys and keeps the rest of the folder. */
function clearKeys(dir) {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) if (!KEPT.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
}

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
const waits = n => (n === 1 ? "waits" : "wait");

/** The messages waiting on this computer, and their chats, as one sentence. */
function waitingLine(messages, chats, end) {
  const more = chats > CHATS_PER_CHECK ? ` Each check saves ${CHATS_PER_CHECK} chats.` : "";
  return `${plural(messages, "message")} from ${plural(chats, "chat")} ${waits(messages)} ${end}${more}`;
}
const BUSY = "A check is under way. Try again once it ends, in under a minute.";
const WAIT_MS = hooks.waitMs ?? 60_000;
/** What the link's history choice brought, from the count kept after each connection. */
function historyLine(settings) {
  if (!settings.history) return "Recent history wasn't chosen at linking. The phone sends it only at linking, so linking again with relink brings it.";
  const n = settings.historyMessages ?? 0;
  return n ? `Recent history was chosen at linking, and brought ${plural(n, "message")}.` : "Recent history was chosen at linking, and none has come.";
}

const historyCount = h => `${plural(h.messages, "message")} from ${plural(h.chats, "chat")}`;

/** The timer's launchctl, the tests' stand-in when they give one. */
const timerOptions = () => ({ ...(hooks.launchctl ? { run: hooks.launchctl } : {}) });
/** A time as the person reads it, such as "Sun 22 Nov, 19:54". */
const when = iso => new Date(iso).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
/** How the timer stands, in a line or two. */
function timerLines(t = timerStatus(timerOptions())) {
  const lines = [t.on
    ? `The timer checks WhatsApp every ${t.hours === 1 ? "hour" : `${t.hours} hours`}, with no Claude session. Next run: about ${when(t.next)}.`
    : "The timer is off."];
  if (t.last) lines.push(`Last timed check: ${t.last}`);
  return lines;
}

/** The person fabrik signs in as, and their keys folder: { ok, ref, email, dir } or { ok: false, problem }. */
function who() {
  const signIn = whichSignIn(folder);
  if (signIn.problem) return { ok: false, problem: signIn.problem };
  return { ok: true, ...signIn, dir: keysPath(signIn.email) };
}

const pulls = new Map();
/** The one check per keys folder, so two connections never share its keys. */
function pullFor(person) {
  if (!pulls.has(person.dir)) {
    const archive = archiveFor(person, hooks);
    const pullImpl = hooks.pullWhatsApp ?? pullWhatsApp;
    pulls.set(person.dir, createWhatsAppPull({ authDir: person.dir, archive, log, pullImpl }));
  }
  return pulls.get(person.dir);
}

/** What a check did, in a few lines for the person. */
function summary(r) {
  const lines = [];
  if (r.reason === "busy") lines.push("Another check is connected to WhatsApp with this link, from another Claude session or the timer. Try again in a minute.");
  else if (r.reason === "not-linked" || r.reason === "logged-out") lines.push("WhatsApp isn't linked on this computer. Link it with whatsapp_link.");
  else if (r.reason === "connect-timeout") lines.push("WhatsApp didn't answer within 20 seconds. Check the computer is online, then check again.");
  else if (r.reason === "drain-timeout") lines.push("WhatsApp kept sending for longer than 30 seconds, so the check stopped. Check again for the rest.");
  else if (r.reason === "closed") lines.push("WhatsApp closed the connection. Check again in a minute.");
  const report = r.report;
  if (report?.problem) lines.push(`The messages weren't saved in fabrik: ${report.problem}`);
  if (report?.scope) {
    const changed = (report.chats ?? []).filter(c => c.added);
    if (changed.length) lines.push(`Saved in ${report.scope.name} (${report.scope.code}):`, ...changed.map(c => `- ${c.file}: ${c.added} new`));
    for (const f of report.titled ?? []) lines.push(`- ${f.file} is the group ${f.name}, and now says so in its first line.`);
    for (const j of report.joined ?? []) lines.push(`- ${j.file} was the same chat as ${j.into}. Its messages are now in ${j.into} too, so it can be deleted.`);
    for (const f of report.failed ?? []) lines.push(`- ${f.file} wasn't saved: ${f.problem}`);
  }
  const added = (report?.chats ?? []).reduce((n, c) => n + c.added, 0);
  if (!r.reason && !added && !report?.problem && !report?.failed?.length && !report?.titled?.length && !report?.joined?.length) lines.push("No new messages.");
  if (r.waiting) lines.push(waitingLine(r.waiting, r.chatsWaiting ?? 1, "on this computer to be saved at the next check."));
  return lines.join("\n");
}

/** The link under way, while the person types the code and the phone sends the history: { run, history }. */
const links = new Map();
/** A link's answer once it has ended, kept for the whatsapp_link_wait that comes after it. */
const linkEnded = new Map();

const TOOLS = [
  {
    name: "whatsapp_status",
    description: "Says whether WhatsApp is linked on this computer, and the linked number. Also names the private fabrik scope the chats go in, how many messages wait to be saved, whether the timer is on, and what the last timed check did. Reads only this computer.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(person) {
      const { linked, number } = stateOf(person.dir);
      const pending = readPending(person.dir);
      const waiting = pending.length;
      const settings = settingsOf(person.dir);
      const link = links.get(person.dir);
      return text([
        linked ? `WhatsApp is linked as +${number}.` : "WhatsApp isn't linked on this computer.",
        `fabrik sign-in: ${person.email}.`,
        settings.scope ? `Chats go in the private scope ${settings.scope}.` : "Chats go in your private fabrik scope.",
        ...(linked ? [historyLine(settings)] : []),
        ...(settings.lastCheck ? [`Last check: ${settings.lastCheck}.`] : []),
        ...(waiting ? [waitingLine(waiting, chatsIn(pending), "to be saved.")] : []),
        ...(link && !linked ? ["A link is waiting for the code to be typed on the phone."] : []),
        ...(link && linked ? [`The phone is sending recent history: ${historyCount(link.history)} so far.`] : []),
        ...timerLines(),
      ].join("\n"));
    },
  },
  {
    name: "whatsapp_link",
    description: "Starts linking the person's WhatsApp as a device on this computer. Takes the WhatsApp number in international format, and the person's choice whether to bring in recent history. Ask them first: the phone sends recent history only at linking. Answers an 8-character code the person types on their phone, under WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead. Then call whatsapp_link_wait.",
    inputSchema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "The WhatsApp number to link, in international format, such as +44 7700 900123." },
        history: { type: "boolean", description: "The person's answer: true to bring in the recent chats the phone sends at linking, false for new messages only. The phone sends them only at linking, so ask before every link." },
        relink: { type: "boolean", description: "True to drop the link this computer holds and link again." },
      },
      required: ["phone", "history"],
      additionalProperties: false,
    },
    async run(person, { phone, history, relink = false }) {
      if (typeof history !== "boolean") return refused("Ask the person whether to bring in recent history first, and pass their answer as history, true or false. The phone sends it only at linking, so adding it later means linking again.");
      const digits = normalizeE164(phone);
      if (!digits || digits.length < 8) return refused(`${phone} isn't a phone number. Give it in international format, such as +44 7700 900123.`);
      if (links.has(person.dir)) return refused("A link is already waiting for its code. Call whatsapp_link_wait, or wait three minutes for it to end.");
      if (pulls.get(person.dir)?.running()) return refused(BUSY);
      const state = stateOf(person.dir);
      if (state.linked && !relink) return text(`WhatsApp is already linked as +${state.number}. To link again, call whatsapp_link with relink true.`);
      const notes = [];
      if (halfLinked(credsOf(person.dir))) notes.push("The last code was never typed, so this is a fresh link with a new code.");
      if (state.linked || halfLinked(credsOf(person.dir))) clearKeys(person.dir);
      const waiting = readPending(person.dir).length;
      if (waiting) notes.push(`${plural(waiting, "message")} from the old link ${waits(waiting)} to be saved. The first check after the link saves them.`);
      makeKeysFolder(person.dir);
      saveSettings(person.dir, { ...settingsOf(person.dir), history, historyMessages: 0 });
      let gotCode;
      const code = new Promise(resolve => { gotCode = resolve; });
      const link = { run: null, history: { chats: 0, messages: 0 } };
      const run = pullFor(person).run({ trigger: "link", pair: true, selfNumber: digits, onPairingCode: c => gotCode(c), history, onHistory: n => { link.history = n; } });
      link.run = run;
      links.set(person.dir, link);
      linkEnded.delete(person.dir);
      run.then(r => { countHistory(person.dir, r); linkEnded.set(person.dir, r); }, () => {}).finally(() => { links.delete(person.dir); lockDown(person.dir); gotCode(null); });
      const first = await Promise.race([code, run.then(() => null), new Promise(r => setTimeout(() => r(null), 30_000))]);
      if (!first) {
        const r = await Promise.race([run, new Promise(res => setTimeout(() => res(null), 1))]);
        return refused(r ? `WhatsApp gave no code. ${summary(r) || r.reason || ""}`.trim() : "WhatsApp gave no code within 30 seconds. Check the computer is online, then try again.");
      }
      const shown = first.length === 8 ? `${first.slice(0, 4)}-${first.slice(4)}` : first;
      return text(`${notes.length ? notes.join(" ") + "\n\n" : ""}Code: ${shown}\n\nOn the phone with +${digits}, open WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead, and type the code. `
        + "If the phone asks whether someone else asked you for this code, it was you: carry on and approve the link. The code works for about three minutes. Then call whatsapp_link_wait.");
    },
  },
  {
    name: "whatsapp_link_wait",
    description: "Waits up to 60 seconds for the phone to accept the code whatsapp_link gave, and then, when the person chose recent history, for the phone to send it. Call it again while it says it is still waiting.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async run(person) {
      const link = links.get(person.dir) ?? (linkEnded.has(person.dir) ? { run: Promise.resolve(linkEnded.get(person.dir)) } : null);
      linkEnded.delete(person.dir);
      if (!link) {
        const state = stateOf(person.dir);
        return state.linked ? text(`WhatsApp is linked as +${state.number}. Check for messages with whatsapp_check.`) : refused("No link is under way. Start one with whatsapp_link.");
      }
      const r = await Promise.race([link.run, new Promise(res => setTimeout(() => res(null), WAIT_MS))]);
      const state = stateOf(person.dir);
      if (!r && state.linked) return text(`WhatsApp is linked as +${state.number}. The phone is still sending recent history: ${historyCount(link.history)} so far. Call whatsapp_link_wait again.`);
      if (!r) return text("Still waiting for the code to be typed on the phone. Call whatsapp_link_wait again.");
      if (state.linked && settingsOf(person.dir).history) {
        const lines = [`WhatsApp is linked as +${state.number}.`];
        if (r.history?.messages) lines.push(`Recent history brought ${historyCount(r.history)}.`);
        else lines.push("The phone sent no recent history.");
        if (r.historyReason) lines.push(`The connection ended before the phone said the history was complete (${r.historyReason}). The next check takes what's left.`);
        if (r.waiting) lines.push(waitingLine(r.waiting, r.chatsWaiting ?? 1, "on this computer to be saved."));
        lines.push(`Save them with whatsapp_check. Each check saves ${CHATS_PER_CHECK} chats, so check again while it says chats wait.`);
        return text(lines.join("\n"));
      }
      if (state.linked) return text(`WhatsApp is linked as +${state.number}. Check for messages with whatsapp_check.`);
      return refused(r.reason === "connect-timeout" ? "The code ran out before the phone accepted it. Start again with whatsapp_link." : `The link didn't complete. ${summary(r)}`.trim());
    },
  },
  {
    name: "whatsapp_check",
    description: "Connects, takes the WhatsApp messages that arrived since the last check, and saves each chat as whatsapp/<chat>.md in the person's private fabrik scope. Photos, videos, voice notes and documents are noted by kind and name, never downloaded. Sends nothing, and marks nothing read.",
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string", description: "The code of the private scope to save in, only when the person owns more than one. It is kept for later checks." } },
      additionalProperties: false,
    },
    async run(person, { scope } = {}) {
      if (links.has(person.dir)) return refused("A link is waiting for its code. Finish it with whatsapp_link_wait first.");
      if (!stateOf(person.dir).linked) return refused("WhatsApp isn't linked on this computer. Link it with whatsapp_link.");
      if (scope) saveSettings(person.dir, { ...settingsOf(person.dir), scope });
      // The phone can send history chunks after the link's wait ends. Each check takes them, as Baileys acknowledges
      // them to the phone whether or not anything listens.
      const r = await pullFor(person).run({ trigger: "check", history: settingsOf(person.dir).history === true });
      countHistory(person.dir, r);
      lockDown(person.dir);
      if (!r.reason) saveSettings(person.dir, { ...settingsOf(person.dir), lastCheck: new Date().toISOString() });
      const said = summary(r);
      return r.reason || r.report?.problem ? refused(said) : text(said);
    },
  },
  {
    name: "whatsapp_timer",
    description: "Turns on or off the timer that checks WhatsApp with no Claude session open. On a Mac, launchd runs the same check as whatsapp_check every few hours, with no Claude model, so a timed check uses no Claude usage. It only reads, as every check does. Use it only when the person asks for checks without a session. Answers what it did, the next run's time and the last timed check.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["on", "off"], description: "on to turn the timer on, or change its hours; off to turn it off." },
        hours: { type: "integer", minimum: 1, maximum: 24, description: `With on: the hours between checks, a whole number from 1 to 24. ${DEFAULT_HOURS} if left out.` },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async run(person, { action, hours = DEFAULT_HOURS }) {
      if (action === "off") {
        const { wasOn } = turnOff(timerOptions());
        return text([wasOn ? "The timer is off. WhatsApp is checked only in a Claude session now." : "The timer was already off.", ...timerLines().slice(1)].join("\n"));
      }
      if (action !== "on") return refused("action is on or off.");
      if (!stateOf(person.dir).linked) return refused("WhatsApp isn't linked on this computer, so a timed check would have nothing to read. Link it with whatsapp_link first.");
      const on = turnOn({ hours, folder, ...timerOptions() });
      if (!on.ok) return refused(on.problem);
      return text([
        `The timer is on. launchd checks WhatsApp every ${on.hours === 1 ? "hour" : `${on.hours} hours`}, with no Claude session and no Claude usage. Next run: about ${when(on.next)}.`,
        "The Mac has to be awake. A run missed while it sleeps happens once when it wakes.",
        "Each run connects to WhatsApp for a few seconds, as a check in a session does, so more runs a day add a little to the risk of Meta flagging the number.",
        "macOS may say that node added a background item. That's this timer.",
        `Each run adds a line to ${timerPaths().log}.`,
        ...timerLines().slice(1),
      ].join("\n"));
    },
  },
  {
    name: "whatsapp_unlink",
    description: "Removes this computer's WhatsApp link: saves what WhatsApp holds for it first, asks WhatsApp to drop the device, deletes the keys folder and turns the timer off. Ask the person before calling it.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { destructiveHint: true },
    async run(person) {
      if (links.has(person.dir)) return refused("A link is waiting for its code. Let it end first, about three minutes.");
      if (pulls.get(person.dir)?.running()) return refused(BUSY);
      const timer = turnOff(timerOptions());
      let dropped = false;
      let r = null;
      if (stateOf(person.dir).linked) {
        r = await pullFor(person).run({ trigger: "unlink", afterDrain: async sock => { await sock.logout(); dropped = true; } });
        if (r.reason === "busy") return refused(summary(r));
      }
      const lost = readPending(person.dir).length;
      rmSync(person.dir, { recursive: true, force: true });
      pulls.delete(person.dir);
      return text([
        dropped ? "WhatsApp dropped this device, and the keys folder is deleted." : "The keys folder is deleted. WhatsApp couldn't be reached to drop the device, so remove it on the phone under Settings → Linked devices.",
        ...(r ? [summary(r)] : []),
        ...(lost ? [`${plural(lost, "message")} couldn't be saved in fabrik and went with the folder.`] : []),
        ...(timer.wasOn ? ["The timer is off too."] : []),
      ].filter(Boolean).join("\n"));
    },
  },
];

async function call(id, name, args) {
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `No tool named ${name}.` } });
  const person = who();
  if (!person.ok) return send({ jsonrpc: "2.0", id, result: refused(person.problem) });
  let result;
  try { result = await tool.run(person, args ?? {}); }
  catch (err) { result = refused(err instanceof Error ? err.message : String(err)); }
  send({ jsonrpc: "2.0", id, result });
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || method === undefined) return;
  if (method === "initialize")
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? DEFAULT_PROTOCOL, capabilities: { tools: {} }, serverInfo: SERVER, instructions: INSTRUCTIONS } });
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ run: _run, ...t }) => t) } });
  if (method === "tools/call") return call(id, params?.name, params?.arguments);
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let buffer = "";
let inFlight = 0;
let ended = false;
const settle = () => { if (ended && inFlight === 0) process.stdout.write("", () => process.exit(0)); };

async function one(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: the line is not JSON." } }); }
  inFlight += 1;
  try { await handle(msg); }
  catch (err) { if (msg?.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } }); }
  finally { inFlight -= 1; settle(); }
}

process.stdin.setEncoding("utf-8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) one(line);
  }
});
process.stdin.on("end", () => { ended = true; settle(); });
