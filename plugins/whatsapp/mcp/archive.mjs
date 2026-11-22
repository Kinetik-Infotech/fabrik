// The chat files: one Markdown file per chat, `whatsapp/<chat name>.md`, each day under its own heading. A check adds
// each chat's new messages to its file. A message whose id the file already holds is skipped, so a check that takes a
// message twice leaves it in the file once.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { jidUser, mediaNote, cleanName } from "./handler.mjs";

export const FOLDER = "whatsapp";
const CHATS = "chats.json";
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
    else if (out.length && line.trim()) out[out.length - 1].push(line);
  }
  return out.map(lines => ({ time: /^- (\d{2}:\d{2})/.exec(lines[0])?.[1] ?? "", text: lines.join("\n") }));
}

/**
 * The chat file with `records` added: { text, added }. `existing` is the file as fabrik holds it, or null for a new one.
 * What the file held stays as it was; each new message goes under its day's heading, in time order.
 */
export function mergeChat(existing, title, records, { timeZone, chat } = {}) {
  const have = idsIn(existing);
  const fresh = [...records].filter(m => !have.has(safeId(m.id))).sort((a, b) => a.at - b.at);
  const unique = fresh.filter((m, i) => fresh.findIndex(o => o.id === m.id) === i);
  if (!unique.length && existing !== null) return { text: existing, added: 0 };

  const head = [];
  const days = new Map();
  let current = null;
  for (const line of (existing ?? `# ${oneLine(title)}\n${chat ? `<!-- wa-chat:${chat} -->\n` : ""}`).split("\n")) {
    const day = DAY.exec(line);
    if (day) { current = day[1]; if (!days.has(current)) days.set(current, []); continue; }
    if (current) days.get(current).push(line);
    else head.push(line);
  }
  for (const m of unique) {
    const { day } = when(m.at, timeZone);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(...entry(m, timeZone).split("\n"));
  }
  while (head.length && !head[head.length - 1].trim()) head.pop();
  const out = [...head, ""];
  for (const day of [...days.keys()].sort()) {
    const sorted = items(days.get(day)).map((x, i) => ({ ...x, i })).sort((a, b) => a.time.localeCompare(b.time) || a.i - b.i);
    out.push(`## ${day}`, "", ...sorted.map(x => x.text), "");
  }
  return { text: out.join("\n"), added: unique.length };
}

/** The file each chat keeps, from chats.json in the keys folder, so a chat stays in one file when a name changes. */
export function readChats(dir) {
  try { const map = JSON.parse(readFileSync(join(dir, CHATS), "utf8")); return map && typeof map === "object" ? map : {}; }
  catch { return {}; }
}

function writeChats(dir, map) {
  const file = join(dir, CHATS);
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(map, null, 1), { mode: 0o600 });
  renameSync(temp, file);
}

/**
 * Saves the records, chat by chat, through `files` ({ read(path) → text or null, write(path, text) }). Answers
 * { saved: [records], chats: [{ file, added }], failed: [{ file, problem }] }. A chat whose file can't be read or written
 * is left for the next check, and the others are still saved.
 */
export async function saveChats(records, groupNames, { dir, files, timeZone }) {
  const map = readChats(dir);
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
        const taken = new Set(Object.entries(map).filter(([other]) => other !== chat).map(([, file]) => file));
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
      const { text, added } = mergeChat(existing, title, list, { timeZone, chat });
      if (added) await files.write(path, text);
      saved.push(...list);
      chats.push({ file: path, added });
    } catch (err) {
      failed.push({ file: path ?? `${FOLDER}/${fileName(name)}.md`, problem: err instanceof Error ? err.message : String(err) });
    }
  }
  return { saved, chats, failed };
}
