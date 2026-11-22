// The chat files: one Markdown file per chat, `whatsapp/<chat name>.md`, each day under its own heading. A check adds
// each chat's new messages to its file. A message whose id the file already holds is skipped, so a check that takes a
// message twice leaves it in the file once.
//
// No file passes FILE_LIMIT. When a chat's messages would take its file past that, its older days move to part files,
// `whatsapp/<chat name> <year>-<month>.md`, each within one month, and the newest days stay in
// `whatsapp/<chat name>.md`. A part file is held to the same rule as a chat file: one that names another chat, or that
// this computer didn't write, is never added to, and the part takes the next name free.
//
// Every file name is a key Supabase Storage accepts. Storage takes letters and digits of the English alphabet, spaces
// and _ / ! . * ' ( ) & $ = @ ; : + , ? - alone, so a name loses its accents, emoji and curly quotes, and the chat's
// full name stays in the file's first line.
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { jidUser, mediaNote, cleanName } from "./handler.mjs";

export const FOLDER = "whatsapp";
const CHATS = "chats.json";
export const MONTHS = "months.json";
/** The groups whose files were first saved under the group's id, and have since been given its name. */
export const TITLED = "titled.json";
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

/** Who sent a message, as the file shows them: their name or number, else the id WhatsApp knows them by, never as a
 * phone number. */
export function senderName(m) {
  if (m.from) return m.from;
  const id = jidUser(m.sender);
  return id ? `Unknown (WhatsApp id ${id})` : "Unknown";
}

/** One message as the list item it is in the file. Lines after the first are indented under it. */
export function entry(m, timeZone) {
  const body = plain([m.text && !m.media ? m.text : "", m.media ? mediaNote(m.media) : ""].filter(Boolean).join(" ").trim()) || "(no text)";
  const [first, ...rest] = body.split("\n");
  return [`- ${when(m.at, timeZone).time} **${oneLine(senderName(m))}:** ${first} <!-- wa:${safeId(m.id)} -->`, ...rest.map(line => `  ${line}`)].join("\n");
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

/** The keys Supabase Storage accepts, as its own check (isValidKey in supabase/storage) has them. */
export const STORAGE_KEY = /^[A-Za-z0-9_/!.*'() &$=@;:+,?-]+$/;
export const validKey = path => typeof path === "string" && STORAGE_KEY.test(path);

/** A name that is safe as one part of a file path and in a Storage key, or "" when nothing of it is. Accents are
 * dropped from their letters, curly quotes become straight ones, and every other character Storage refuses becomes a
 * space. A name Storage always took comes out as it went in. */
export function fileName(name) {
  return String(name ?? "").normalize("NFKD").replace(/\p{M}+/gu, "")
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'").replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[^A-Za-z0-9_!.'() &$=@;+,-]+/g, " ").replace(/\s+/g, " ").replace(/^[ .]+|[ .]+$/g, "").slice(0, 80).replace(/[ .]+$/, "");
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
  const named = existing === null ? existing : nameUnknown(existing, records);
  const fresh = [...records].filter(m => !have.has(safeId(m.id))).sort((a, b) => a.at - b.at);
  const unique = fresh.filter((m, i) => fresh.findIndex(o => o.id === m.id) === i);
  if (!unique.length && existing !== null) return { text: named, added: 0 };
  existing = named;
  const { head, days } = parseChat(existing ?? newFile(title, chat));
  for (const m of unique) {
    const { day } = when(m.at, timeZone);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(...entry(m, timeZone).split("\n"));
  }
  return { text: renderChat(head, days), added: unique.length };
}

/** The file with each line saved as Unknown given its sender's name, when the same message comes again with one. */
export function nameUnknown(text, records) {
  const known = new Map();
  // A name, or the WhatsApp id of a sender known only by one. A record with neither names nobody.
  for (const m of records) { const who = senderName(m); if (m.from || who !== "Unknown") known.set(safeId(m.id), { who, named: !!m.from }); }
  if (!known.size) return text;
  return String(text).replace(/^(- \d{2}:\d{2} \*\*)(Unknown(?: \(WhatsApp id [^)]*\))?)(:\*\* .*<!-- wa:([A-Za-z0-9_.-]+) -->)$/gm,
    (line, start, label, rest, id) => {
      const k = known.get(id);
      // A name replaces any Unknown; an id fills in only a bare Unknown.
      if (!k || (!k.named && label !== "Unknown")) return line;
      return `${start}${oneLine(k.who)}${rest}`;
    });
}

/** A part file with the days of `more` added, each message once: { text, added }. */
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

/** A day's size in a file, in bytes, with its heading. */
const daySize = (day, lines) => Buffer.byteLength(`## ${day}\n\n${lines.join("\n")}\n`, "utf8");

/** Days, in order, packed into runs that each stay under `room` bytes and within one month. A day bigger than `room`
 * makes a run of its own. */
export function packDays(days, room) {
  const runs = [];
  let run = null;
  let size = 0;
  for (const [day, lines] of days) {
    const n = daySize(day, lines);
    if (!run || size + n > room || run[0][0].slice(0, 7) !== day.slice(0, 7)) { run = []; size = 0; runs.push(run); }
    run.push([day, lines]);
    size += n;
  }
  return runs;
}

/**
 * The chat a message is saved under: a name `map` already holds for it, else its phone number's name, else its own.
 * When `map` holds both of a direct chat's names, the one it gained first wins: that chat took the plain file name, and
 * the other, saved before the two were known as one, took the name with the number added.
 */
export function chatKey(m, map) {
  const names = [m.chat, m.alt].filter(Boolean);
  const order = Object.keys(map);
  const mapped = names.filter(n => map[n]).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return mapped[0] ?? names.find(n => n.endsWith("@s.whatsapp.net")) ?? m.chat;
}

/** A group file's text with the group's name in its first line, when that line still holds only the group's id. */
export function withGroupName(text, chat, name) {
  const named = cleanName(name);
  const bare = `# WhatsApp group: ${jidUser(chat)}`;
  if (!named || typeof text !== "string") return text;
  const [first, ...rest] = text.split("\n");
  if (first !== bare && !first.startsWith(`${bare}, `)) return text;
  return [`# WhatsApp group: ${oneLine(named)}${first.slice(bare.length)}`, ...rest].join("\n");
}

/** Whether a group saved under its id has a name now known and not yet in its first line. */
export function namesToGive(dir, groupNames) {
  const done = readJson(join(dir, TITLED));
  return Object.entries(readChats(dir)).some(([chat, path]) =>
    chat.endsWith("@g.us") && cleanName(groupNames?.[chat]) && !done[chat] && path.startsWith(`${FOLDER}/group ${jidUser(chat)}`));
}

/**
 * Saves the records, chat by chat, through `files` ({ read(path) → text or null, write(path, text) }). Answers
 * { saved: [records], chats: [{ file, added }], failed: [{ file, problem }], joined: [{ file, into }],
 * titled: [{ file, name }] }. A chat whose file can't be read or written is left for the next check, and the others are
 * still saved.
 *
 * A direct chat's messages carry its other name in `alt` when WhatsApp gives it, its LID or its phone number, and both
 * names lead to one file. A chat saved in two files before its two names were known as one is joined: the second
 * file's messages are added to the first, every later message goes to the first, and `joined` names the second.
 *
 * A group first saved under its id keeps its file once its name is known, and the name goes in the first line of the
 * file and its parts. titled.json keeps the groups done.
 *
 * No file passes `limit`. A chat's older days move to part files, `whatsapp/<chat name> <year>-<month>.md` and then
 * `... <year>-<month> 2.md`, each within one month, and the newest days stay in `whatsapp/<chat name>.md`. months.json
 * keeps, per chat, the first day each part holds and the first day the chat file holds, so every later message goes to
 * the file that holds its day.
 */
export async function saveChats(records, groupNames, { dir, files, timeZone, limit = FILE_LIMIT }) {
  const map = readChats(dir);
  const months = readJson(join(dir, MONTHS));
  // A name Storage refused was never saved, so the chat is given one it takes.
  for (const [chat, path] of Object.entries(map)) if (!validKey(path)) delete map[chat];
  for (const [chat, v] of Object.entries(months)) if (Array.isArray(v?.parts) && v.parts.some(p => !validKey(p.file))) delete months[chat];
  const keepMonths = () => writeJson(join(dir, MONTHS), months);
  const dayOf = m => when(m.at, timeZone).day;
  const partsOf = chat => (Array.isArray(months[chat]?.parts) ? months[chat] : (months[chat] = { until: "", parts: [] }));
  // The chat files and part files other chats hold.
  const takenBy = chat => new Set([
    ...Object.entries(map).filter(([other, file]) => other !== chat && file !== map[chat]).map(([, file]) => file),
    ...Object.entries(months).filter(([other]) => other !== chat).flatMap(([, v]) => (Array.isArray(v?.parts) ? v.parts.map(p => p.file) : [])),
  ]);
  // A new part file for the chat's month: the first name free whose file is missing or names this chat.
  const newPart = async (chat, path, month) => {
    const taken = takenBy(chat);
    taken.add(path);
    for (const p of partsOf(chat).parts) taken.add(p.file);
    const base = path.replace(/\.md$/, "");
    const stems = [base, `${base} ${jidUser(chat)}`];
    const names = [...stems.map(stem => `${stem} ${month}`), ...Array.from({ length: 30 }, (_, i) => stems.map(stem => `${stem} ${month} ${i + 2}`)).flat()];
    for (const file of names.map(n => `${n}.md`)) {
      if (taken.has(file)) continue;
      const there = await files.read(file);
      if (there === null || chatIn(there) === chat) return { file, existing: there };
    }
    throw new Error(`no free file name for ${month} of the chat ${chat}`);
  };
  // Writes days into new parts, one a run, and records each part in months.json before the files are written.
  const addParts = async (chat, path, title, runs) => {
    for (const run of runs) {
      const month = run[0][0].slice(0, 7);
      const { file, existing } = await newPart(chat, path, month);
      const book = partsOf(chat);
      book.parts.push({ from: run[0][0], file });
      book.parts.sort((a, b) => a.from.localeCompare(b.from));
      keepMonths();
      const merged = mergeDays(existing, `${title}, ${month}`, new Map(run), { chat });
      if (merged.added || existing === null) await files.write(file, merged.text);
    }
  };
  // The part that holds a day before the chat file's first day: the last whose first day is on or before it.
  const partFor = (chat, day) => {
    const { until, parts } = partsOf(chat);
    if (!parts.length || day >= until) return null;
    return [...parts].reverse().find(p => p.from <= day) ?? parts[0];
  };

  const byChat = new Map();
  // The other files each chat is to be joined with: chat → Map(other name → its file).
  const joins = new Map();
  for (const m of records) {
    const key = chatKey(m, map);
    if (!byChat.has(key)) byChat.set(key, []);
    byChat.get(key).push(m);
    for (const other of [m.chat, m.alt]) {
      if (!other || other === key || !map[key] || !map[other] || map[other] === map[key]) continue;
      if (!joins.has(key)) joins.set(key, new Map());
      joins.get(key).set(other, map[other]);
    }
  }
  const saved = [];
  const chats = [];
  const failed = [];
  const joined = [];
  const titled = [];
  for (const [chat, list] of byChat) {
    const { title, name } = chatTitle(list, groupNames?.[chat]);
    let path = map[chat];
    try {
      let existing = path ? await files.read(path) : null;
      // A file holds one chat, named on its own line. A file another chat holds, or one this computer didn't write, is
      // never added to: the chat takes the next name free, its own id added to it.
      if (!path || (existing !== null && chatIn(existing) !== chat)) {
        const taken = takenBy(chat);
        // The chat's id is added to its name once: a name that holds it already, such as the person's own number, gets
        // a count instead.
        const id = jidUser(chat);
        const base = fileName(name) || `${list[0].kind === "group" ? "group" : "chat"} ${id}`;
        const stem = base.includes(id) ? base : `${base} ${id}`;
        const names = [base, ...(stem === base ? [] : [stem]), ...Array.from({ length: 20 }, (_, i) => `${stem} ${i + 2}`)];
        path = null;
        for (const candidate of names.map(n => `${FOLDER}/${n}.md`)) {
          if (taken.has(candidate)) continue;
          const there = await files.read(candidate);
          if (there === null || chatIn(there) === chat) { path = candidate; existing = there; break; }
        }
        if (!path) throw new Error(`no free file name for the chat ${name}`);
        map[chat] = path;
        writeChats(dir, map);
      }
      const before = existing;
      if (list[0].kind === "group") existing = withGroupName(existing, chat, groupNames?.[chat]);
      // The messages of another file this chat was saved in, each once.
      const joining = [...(joins.get(chat) ?? [])].filter(([, file]) => file !== path);
      for (const [, file] of joining) {
        const other = await files.read(file);
        if (other !== null) existing = mergeDays(existing, title, parseChat(other).days, { chat }).text;
      }
      let added = 0;
      // A message of a day a part holds goes to that part. A part that would pass the limit splits into more.
      const toParts = new Map();
      const toMain = [];
      for (const m of list) {
        const part = partFor(chat, dayOf(m));
        if (!part) { toMain.push(m); continue; }
        if (!toParts.has(part.file)) toParts.set(part.file, []);
        toParts.get(part.file).push(m);
      }
      for (const [file, recs] of toParts) {
        const was = await files.read(file);
        const merged = mergeChat(was, `${title}, ${dayOf(recs[0]).slice(0, 7)}`, recs, { timeZone, chat });
        if (!merged.added && merged.text === was) continue;
        added += merged.added;
        if (Buffer.byteLength(merged.text, "utf8") <= limit) { await files.write(file, merged.text); continue; }
        const { head, days } = parseChat(merged.text);
        const [first, ...rest] = packDays([...days].sort((a, b) => a[0].localeCompare(b[0])), limit - Buffer.byteLength(head.join("\n")) - 256);
        await addParts(chat, path, title, rest);
        await files.write(file, renderChat(head, new Map(first)));
      }
      // The chat file keeps its newest days, within one month and half the limit, so it has room to grow. The days
      // before them move to new parts.
      let { text, added: fresh } = mergeChat(existing, title, toMain, { timeZone, chat });
      const changed = fresh > 0 || existing !== before || text !== existing;
      if (changed && Buffer.byteLength(text, "utf8") > limit) {
        const { head, days } = parseChat(text);
        const sorted = [...days].sort((a, b) => a[0].localeCompare(b[0]));
        const room = limit - Buffer.byteLength(head.join("\n")) - 256;
        let cut = sorted.length - 1;
        let size = daySize(...sorted[cut]);
        while (cut > 0 && sorted[cut - 1][0].slice(0, 7) === sorted[cut][0].slice(0, 7) && size + daySize(...sorted[cut - 1]) <= room / 2) {
          cut -= 1;
          size += daySize(...sorted[cut]);
        }
        if (cut > 0) {
          partsOf(chat).until = sorted[cut][0];
          await addParts(chat, path, title, packDays(sorted.slice(0, cut), room));
          text = renderChat(head, new Map(sorted.slice(cut)));
        }
      }
      if (changed) await files.write(path, text);
      added += fresh;
      if (joining.length) {
        for (const [other, file] of joining) { map[other] = path; joined.push({ file, into: path }); }
        writeChats(dir, map);
      }
      saved.push(...list);
      chats.push({ file: path, added });
    } catch (err) {
      failed.push({ file: path ?? `${FOLDER}/${fileName(name) || "chat"}.md`, problem: err instanceof Error ? err.message : String(err) });
    }
  }

  // Each group saved under its id whose name is now known: its name goes in the first line of its file and parts.
  const done = readJson(join(dir, TITLED));
  for (const [chat, path] of Object.entries(map)) {
    const name = cleanName(groupNames?.[chat]);
    if (!chat.endsWith("@g.us") || !name || done[chat] || !path.startsWith(`${FOLDER}/group ${jidUser(chat)}`)) continue;
    try {
      for (const file of [path, ...(Array.isArray(months[chat]?.parts) ? months[chat].parts.map(p => p.file) : [])]) {
        const text = await files.read(file);
        const named = withGroupName(text, chat, name);
        if (text !== null && named !== text) await files.write(file, named);
      }
      done[chat] = name;
      writeJson(join(dir, TITLED), done);
      titled.push({ file: path, name });
    } catch (err) {
      failed.push({ file: path, problem: err instanceof Error ? err.message : String(err) });
    }
  }
  return { saved, chats, failed, joined, titled };
}
