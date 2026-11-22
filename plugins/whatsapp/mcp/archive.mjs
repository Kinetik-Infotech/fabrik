// The chat files: one Markdown file per chat, `whatsapp/<chat name>.md`, each day under its own heading. A check adds
// each chat's new messages to its file. A message whose id the file already holds is skipped, so a check that takes a
// message twice leaves it in the file once.
//
// A chat file stays under FILE_LIMIT. When a chat's messages would take its file past that, its older months move to
// `whatsapp/<chat name> <year>-<month>.md`, one file a month, and the newest month stays in `whatsapp/<chat name>.md`.
// months.json in the keys folder names each chat's month files, so a later message of a month that moved goes to its
// month's file. A month file is held to the same rule as a chat file: one that names another chat, or that this
// computer didn't write, is never added to, and the month takes the next name free.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { jidUser, mediaNote, cleanName } from "./handler.mjs";

export const FOLDER = "whatsapp";
const CHATS = "chats.json";
export const MONTHS = "months.json";
export const FILE_LIMIT = 1024 * 1024;
// A message's id, read only at the end of a list item's first line, where entry() writes it.
const ID = /^- .* <!-- wa:([A-Za-z0-9_.-]+) -->$/gm;
// The chat a file belongs to, read only on its own line, where mergeChat writes it.
const CHAT = /^<!-- wa-chat:(\S+) -->$/m;
const DAY = /^## (\d{4}-\d{2}-\d{2})\s*$/;

/** The day and time a message was sent, in the computer's time zone unless one is given: { day, time }. */
export function when(at, timeZone) {
  const text = new Date(at).toLocaleString("sv-SE", { timeZone, hour12: false });
  const [day, clock] = text.split(" ");
  return { day, time: clock.slice(0, 5) };
}

/** A sender's text made safe inside a list item: every kind of line break becomes one, and an HTML comment can't open
 * or close, so no text can pass for a marker the file relies on. */
export function plain(text) {
  return String(text).replace(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/g, "\n").replace(/<!--/g, "<!- -").replace(/-->/g, "- ->");
}

/** A name or title made safe on one line: every kind of line break becomes a space. */
export const oneLine = text => plain(text).replace(/\n+/g, " ");

/** A message id as the file holds it: letters, digits and _ . - only. */
export const safeId = id => String(id).replace(/[^A-Za-z0-9_.-]/g, "_");

/** One message as the list item it is in the file. Lines after the first are indented under it. */
export function entry(m, timeZone) {
  const body = plain([m.text && !m.media ? m.text : "", m.media ? mediaNote(m.media) : ""].filter(Boolean).join(" ").trim()) || "(no text)";
  const [first, ...rest] = body.split("\n");
  return [`- ${when(m.at, timeZone).time} **${oneLine(m.from)}:** ${first} <!-- wa:${safeId(m.id)} -->`, ...rest.map(line => `  ${line}`)].join("\n");
}

/** The chat a file says it belongs to, or null for a file with no such line. */
export const chatIn = text => CHAT.exec(String(text ?? ""))?.[1] ?? null;

/** The ids a chat file already holds. */
export const idsIn = text => new Set([...String(text ?? "").matchAll(ID)].map(x => x[1]));

/** A chat's title: a group's name, or the other person's name and number. */
export function chatTitle(records, groupName) {
  const first = records[0];
  if (first.kind === "group") return { title: `WhatsApp group: ${cleanName(groupName) || jidUser(first.chat)}`, name: cleanName(groupName) || `group ${jidUser(first.chat)}` };
  const theirs = records.find(r => !r.fromMe && r.from && !r.from.startsWith("+"))?.from;
  const number = records.find(r => r.number)?.number;
  const name = theirs || (number ? `+${number}` : `chat ${jidUser(first.chat)}`);
  return { title: `WhatsApp: ${name}${theirs && number ? ` (+${number})` : ""}`, name };
}

/** A name that is safe as one part of a file path. */
export function fileName(name) {
  const safe = String(name).replace(/[\u0000-\u001f/\\:*?"<>|#%]+/g, " ").replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "").slice(0, 80);
  return safe || "chat";
}

/** Each item of a day's section, as text, with the time it starts with for sorting. */
function items(lines) {
  const out = [];
  for (const line of lines) {
    if (line.startsWith("- ")) out.push([line]);
    // A message's own lines are indented under it, its blank ones too, so a blank line in a message stays.
    else if (out.length && (line.trim() || line.startsWith("  "))) out[out.length - 1].push(line);
  }
  return out.map(lines => ({ time: /^- (\d{2}:\d{2})/.exec(lines[0])?.[1] ?? "", text: lines.join("\n") }));
}

/** A chat file's lines before its first day, and each day's lines: { head, days }. */
function parseChat(text) {
  const head = [];
  const days = new Map();
  let current = null;
  for (const line of String(text).split("\n")) {
    const day = DAY.exec(line);
    if (day) { current = day[1]; if (!days.has(current)) days.set(current, []); continue; }
    if (current) days.get(current).push(line);
    else head.push(line);
  }
  return { head, days };
}

/** A chat file from its head and days, each day's messages in time order. */
function renderChat(head, days) {
  const top = [...head];
  while (top.length && !top[top.length - 1].trim()) top.pop();
  const out = [...top, ""];
  for (const day of [...days.keys()].sort()) {
    const sorted = items(days.get(day)).map((x, i) => ({ ...x, i })).sort((a, b) => a.time.localeCompare(b.time) || a.i - b.i);
    out.push(`## ${day}`, "", ...sorted.map(x => x.text), "");
  }
  return out.join("\n");
}

const newFile = (title, chat) => `# ${oneLine(title)}\n${chat ? `<!-- wa-chat:${chat} -->\n` : ""}`;

/**
 * The chat file with `records` added: { text, added }. `existing` is the file as fabrik holds it, or null for a new one.
 * What the file held stays as it was; each new message goes under its day's heading, in time order.
 */
export function mergeChat(existing, title, records, { timeZone, chat } = {}) {
  const have = idsIn(existing);
  const fresh = [...records].filter(m => !have.has(safeId(m.id))).sort((a, b) => a.at - b.at);
  const unique = fresh.filter((m, i) => fresh.findIndex(o => o.id === m.id) === i);
  if (!unique.length && existing !== null) return { text: existing, added: 0 };
  const { head, days } = parseChat(existing ?? newFile(title, chat));
  for (const m of unique) {
    const { day } = when(m.at, timeZone);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(...entry(m, timeZone).split("\n"));
  }
  return { text: renderChat(head, days), added: unique.length };
}

/**
 * A chat file split by month: { text, months: Map(month → { [day]: lines }) }. `text` keeps the file's head and its
 * newest month; `months` holds each older month's days. A file of one month comes back whole, with no months.
 */
export function splitByMonth(text) {
  const { head, days } = parseChat(text);
  const all = [...new Set([...days.keys()].map(d => d.slice(0, 7)))].sort();
  if (all.length < 2) return { text, months: new Map() };
  const newest = all[all.length - 1];
  const months = new Map();
  const kept = new Map();
  for (const [day, lines] of days) {
    const month = day.slice(0, 7);
    if (month === newest) { kept.set(day, lines); continue; }
    if (!months.has(month)) months.set(month, new Map());
    months.get(month).set(day, lines);
  }
  return { text: renderChat(head, kept), months };
}

/** A month file with the days of `more` added, each message once: { text, added }. */
export function mergeDays(existing, title, more, { chat } = {}) {
  const have = idsIn(existing);
  const { head, days } = parseChat(existing ?? newFile(title, chat));
  let added = 0;
  for (const [day, lines] of more) {
    const fresh = items(lines).filter(x => { const id = /<!-- wa:([A-Za-z0-9_.-]+) -->$/m.exec(x.text)?.[1]; return !id || !have.has(id); });
    if (!fresh.length) continue;
    if (!days.has(day)) days.set(day, []);
    for (const x of fresh) days.get(day).push(...x.text.split("\n"));
    added += fresh.length;
  }
  return { text: added || existing === null ? renderChat(head, days) : existing, added };
}


function readJson(file) {
  try { const map = JSON.parse(readFileSync(file, "utf8")); return map && typeof map === "object" ? map : {}; }
  catch { return {}; }
}

function writeJson(file, map) {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(map, null, 1), { mode: 0o600 });
  renameSync(temp, file);
}

/** The file each chat keeps, from chats.json in the keys folder, so a chat stays in one file when a name changes. */
export const readChats = dir => readJson(join(dir, CHATS));
const writeChats = (dir, map) => writeJson(join(dir, CHATS), map);

/**
 * Saves the records, chat by chat, through `files` ({ read(path) → text or null, write(path, text) }). Answers
 * { saved: [records], chats: [{ file, added }], failed: [{ file, problem }] }. A chat whose file can't be read or written
 * is left for the next check, and the others are still saved.
 */
export async function saveChats(records, groupNames, { dir, files, timeZone, limit = FILE_LIMIT }) {
  const map = readChats(dir);
  const months = readJson(join(dir, MONTHS));
  const monthOf = m => when(m.at, timeZone).day.slice(0, 7);
  // The chat files and month files other chats hold.
  const takenBy = chat => new Set([
    ...Object.entries(map).filter(([other]) => other !== chat).map(([, file]) => file),
    ...Object.entries(months).filter(([other]) => other !== chat).flatMap(([, files]) => Object.values(files ?? {})),
  ]);
  // A month's file for the chat, and what it holds: the one months.json names, else the first free name whose file is
  // missing or names this chat. Throws when none is free.
  const monthFile = async (chat, path, month) => {
    const known = months[chat]?.[month];
    if (known) return { file: known, existing: await files.read(known) };
    const taken = takenBy(chat);
    const base = path.replace(/\.md$/, "");
    const names = [base, `${base} ${jidUser(chat)}`, ...Array.from({ length: 20 }, (_, i) => `${base} ${jidUser(chat)} ${i + 2}`)];
    for (const file of names.map(n => `${n} ${month}.md`)) {
      if (taken.has(file) || file === path) continue;
      const there = await files.read(file);
      if (there === null || chatIn(there) === chat) {
        months[chat] = { ...(months[chat] ?? {}), [month]: file };
        writeJson(join(dir, MONTHS), months);
        return { file, existing: there };
      }
    }
    throw new Error(`no free file name for ${month} of the chat ${chat}`);
  };
  const byChat = new Map();
  for (const m of records) { if (!byChat.has(m.chat)) byChat.set(m.chat, []); byChat.get(m.chat).push(m); }
  const saved = [];
  const chats = [];
  const failed = [];
  for (const [chat, list] of byChat) {
    const { title, name } = chatTitle(list, groupNames?.[chat]);
    let path = map[chat];
    try {
      let existing = path ? await files.read(path) : null;
      // A file holds one chat, named on its own line. A file another chat holds, or one this computer didn't write, is
      // never added to: the chat takes the next name free, its own id added to it.
      if (!path || (existing !== null && chatIn(existing) !== chat)) {
        const taken = takenBy(chat);
        const names = [name, `${name} ${jidUser(chat)}`, ...Array.from({ length: 20 }, (_, i) => `${name} ${jidUser(chat)} ${i + 2}`)];
        path = null;
        for (const candidate of names.map(n => `${FOLDER}/${fileName(n)}.md`)) {
          if (taken.has(candidate)) continue;
          const there = await files.read(candidate);
          if (there === null || chatIn(there) === chat) { path = candidate; existing = there; break; }
        }
        if (!path) throw new Error(`no free file name for the chat ${name}`);
        map[chat] = path;
        writeChats(dir, map);
      }
      // A message of a month that has its own file goes there.
      const split = new Set(Object.keys(months[chat] ?? {}));
      let added = 0;
      const byMonth = new Map();
      for (const m of list.filter(m => split.has(monthOf(m)))) { const k = monthOf(m); if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(m); }
      for (const [month, recs] of byMonth) {
        const { file, existing: there } = await monthFile(chat, path, month);
        const merged = mergeChat(there, `${title}, ${month}`, recs, { timeZone, chat });
        if (merged.added) await files.write(file, merged.text);
        added += merged.added;
      }
      let { text, added: fresh } = mergeChat(existing, title, list.filter(m => !split.has(monthOf(m))), { timeZone, chat });
      if (fresh && Buffer.byteLength(text, "utf8") > limit) {
        const parts = splitByMonth(text);
        if (parts.months.size) {
          for (const [month, days] of parts.months) {
            const { file, existing: there } = await monthFile(chat, path, month);
            const merged = mergeDays(there, `${title}, ${month}`, days, { chat });
            if (merged.added) await files.write(file, merged.text);
          }
          text = parts.text;
        }
      }
      if (fresh) await files.write(path, text);
      added += fresh;
      saved.push(...list);
      chats.push({ file: path, added });
    } catch (err) {
      failed.push({ file: path ?? `${FOLDER}/${fileName(name)}.md`, problem: err instanceof Error ? err.message : String(err) });
    }
  }
  return { saved, chats, failed };
}
