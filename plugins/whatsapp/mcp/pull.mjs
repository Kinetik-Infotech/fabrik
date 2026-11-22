// The check: one connection, then the messages it took handed to `archive`. Lifted from maxy-lite's
// channels/whatsapp/pull.mjs (createWhatsAppPull), with its inbox file replaced by the archive callback and its media
// download removed.
//
// Single flight is the safety rule: two connections on one keys folder corrupt the link, so a run while one is under
// way gets the first one's result rather than opening a second socket.
//
// The guard holds across sessions too. A run takes `check.lock` in the keys folder, holding its process id, and a
// second session finds it taken and connects nothing. A lock whose process has ended is taken over.
//
// WhatsApp forgets a message once this device has taken it, so nothing taken may be lost: not when fabrik can't be
// reached, and not when the session ends during a check. Each message is added to `pending.jsonl` in the keys folder as
// it arrives. archive's answer says which were saved, and the rest wait for the next check.
//
// A check saves at most CHATS_PER_CHECK chats, the ones with the oldest messages first, so the recent history a link
// brings reaches fabrik in batches its search reads in its own time. The other chats wait in the same list. A link
// saves nothing: the first check after it does.
//
// Senders are named before a batch is saved. WhatsApp names many people only by a LID, an internal id that is not a
// phone number, so each LID is looked up in what the check has learnt: lids.json, the LID and phone pairs, and
// names.json, the names from contacts and messages. Both are filled from history, Baileys' events and its own store of
// LIDs, and the person's own LID and number come from the link's keys.
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync, renameSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { formatInbound, chatKind, jidUser, cleanName, isLid, isPhone } from "./handler.mjs";
import { pullWhatsApp as defaultPull } from "./baileys.mjs";
import { namesToGive, readChats } from "./archive.mjs";

export const PENDING = "pending.jsonl";
export const LOCK = "check.lock";
/** The group names read while a socket was open, kept so messages saved at a later check still have them. */
export const GROUPS = "groups.json";
export const CHATS_PER_CHECK = 20;
/** Each direct chat's LID and phone number, learnt from WhatsApp, so a chat named either way leads to one file. */
export const LIDS = "lids.json";
/** The names learnt for people, by JID, from contacts and from the names people gave WhatsApp. */
export const NAMES = "names.json";

const phoneJid = jid => `${jidUser(jid)}@s.whatsapp.net`;
const readMap = (dir, name) => { try { const map = JSON.parse(readFileSync(join(dir, name), "utf8")); return map && typeof map === "object" ? map : {}; } catch { return {}; } };
/** Adds `pairs` to a map in the keys folder. `under` are added only where the map has nothing. */
function addToMap(dir, name, pairs, under = {}) {
  if (!Object.keys(pairs).length && !Object.keys(under).length) return;
  const file = join(dir, name);
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...under, ...readMap(dir, name), ...pairs }, null, 1), { mode: 0o600 });
  renameSync(temp, file);
}
const readLids = dir => readMap(dir, LIDS);
const saveLids = (dir, pairs) => addToMap(dir, LIDS, pairs);

/** The person's own LID and phone number, from the link's keys, as { lid: phone }, or {}. */
export function selfPair(dir) {
  const me = readMap(dir, "creds.json").me;
  return isLid(`${me?.lid ?? ""}`.replace(/:\d+@/, "@")) && isPhone(`${me?.id ?? ""}`.replace(/:\d+@/, "@"))
    ? { [`${jidUser(me.lid)}@lid`]: phoneJid(me.id) } : {};
}

/**
 * The record with its sender named from what was learnt: the name they gave WhatsApp, else a contact's name, else their
 * phone number. A sender known only by a LID keeps an empty `from`, so the file never shows a LID as a number.
 */
export function withSender(r, lids, names) {
  if (r.fromMe) return r;
  // A record from before senders were kept names a LID sender as "+<LID>".
  const old = !r.sender && /^\+(\d+)$/.exec(r.from ?? "");
  const sender = r.sender || (old && (lids[`${old[1]}@lid`] || names[`${old[1]}@lid`]) ? `${old[1]}@lid` : "");
  if (r.from && !old) return r;
  if (r.from && old && !sender) return r;
  const ids = [sender, r.senderAlt].filter(Boolean);
  const all = [...ids, ...ids.filter(isLid).map(l => lids[l]).filter(Boolean)];
  const name = all.map(j => cleanName(names[j])).find(Boolean);
  const phone = all.find(isPhone);
  return { ...r, sender, from: name || (phone ? `+${jidUser(phone)}` : "") };
}

/** The LID and phone pair a record names, as { lid: phone }, or null. */
function pairOf(r) {
  const lid = [r.chat, r.alt].find(j => j?.endsWith("@lid"));
  const pn = [r.chat, r.alt].find(j => j?.endsWith("@s.whatsapp.net"));
  return lid && pn ? { [lid]: phoneJid(pn) } : null;
}

/** The record with its chat's other name and phone number filled in from the pairs learnt. */
export function withAlias(r, lids) {
  if (r.kind !== "direct" || r.alt) return r;
  const pn = lids[r.chat];
  const lid = pn ? null : Object.keys(lids).find(l => lids[l] === r.chat);
  const alt = pn ?? lid;
  if (!alt) return r;
  return { ...r, alt, number: r.number || jidUser(pn ?? r.chat) };
}

/** The chats waiting to be saved. */
export const chatsIn = list => new Set(list.map(m => m.chat)).size;

/** The messages of the `limit` chats whose oldest message is oldest, and how many chats that leaves. */
export function nextBatch(list, limit = CHATS_PER_CHECK) {
  const oldest = new Map();
  for (const m of list) if (!oldest.has(m.chat) || m.at < oldest.get(m.chat)) oldest.set(m.chat, m.at);
  const chosen = new Set([...oldest].sort((a, b) => a[1] - b[1]).slice(0, limit).map(([chat]) => chat));
  return list.filter(m => chosen.has(m.chat));
}

const readGroups = dir => readMap(dir, GROUPS);
const saveGroups = (dir, names) => addToMap(dir, GROUPS, names);

/** The messages waiting to be saved, each once, in the order they came. A line cut short by a crash is skipped. */
export function readPending(authDir) {
  let text = "";
  try { text = readFileSync(join(authDir, PENDING), "utf8"); } catch { return []; }
  const seen = new Set();
  const list = [];
  for (const line of text.split("\n")) {
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (!m?.chat || !m?.id || seen.has(`${m.chat} ${m.id}`)) continue;
    seen.add(`${m.chat} ${m.id}`);
    list.push(m);
  }
  return list;
}

/** Adds one message to the waiting list, on disk at once. */
export function addPending(authDir, record) {
  const file = join(authDir, PENDING);
  appendFileSync(file, JSON.stringify(record) + "\n", { mode: 0o600 });
}

export function writePending(authDir, list) {
  const file = join(authDir, PENDING);
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, list.map(m => JSON.stringify(m) + "\n").join(""), { mode: 0o600 });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch (err) { return err?.code === "EPERM"; } };

/** Takes the keys folder's lock: its release, or null while another live process holds it. */
export function takeLock(authDir) {
  const file = join(authDir, LOCK);
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const holder = Number(readFileSync(file, "utf8").trim());
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) return null;
      rmSync(file, { force: true });
    }
  }
  return null;
}

/** A promise, or a refusal once `ms` have passed. */
async function within(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, no) => { timer = setTimeout(() => no(new Error("timeout")), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Group names, read while the socket is open: queries, never a message. The groups the person is in come in one
 * query. A group that query can't answer is asked alone, each waiting at most `ms`. */
async function groupNames(sock, jids, ms = 5000) {
  const names = {};
  if (typeof sock?.groupFetchAllParticipating === "function") {
    try {
      const all = await within(sock.groupFetchAllParticipating(), 10_000);
      for (const [jid, meta] of Object.entries(all ?? {})) if (typeof meta?.subject === "string" && meta.subject.trim()) names[jid] = meta.subject.trim();
      return names;
    } catch { /* each group is asked alone */ }
  }
  if (typeof sock?.groupMetadata !== "function") return names;
  for (const jid of jids) {
    try {
      const meta = await within(sock.groupMetadata(jid), ms);
      if (typeof meta?.subject === "string" && meta.subject.trim()) names[jid] = meta.subject.trim();
    } catch { /* the file is named by the group's id */ }
  }
  return names;
}

/**
 * A single-flight check bound to one keys folder.
 * archive(records, groupNames) saves the messages and answers { saved: [ids], ...anything else to report }.
 * run({ pair, selfNumber, onPairingCode, afterDrain, history, onHistory }) answers
 * { pullId, count, taken, ignored, saved, waiting, chatsWaiting, history, historyReason, reason, linked, report }.
 * With `history`, recent history is kept, and a link the phone accepts stays connected until the history has come.
 * onHistory({ chats, messages }) hears the running count. `history` in the answer is that count.
 */
export function createWhatsAppPull({ authDir, archive, log = () => {}, pullImpl = defaultPull, now = () => Date.now(), genId = () => randomUUID().slice(0, 8) }) {
  let inflight = null;

  async function once({ trigger = "check", pair = false, selfNumber = "", onPairingCode, afterDrain, history = false, onHistory = () => {} } = {}) {
    const pullId = genId();
    const plog = (op, fields = {}) => log(op, { pullId, ...fields });
    const startAt = now();
    plog("pull-start", { trigger });
    const release = takeLock(authDir);
    if (!release) {
      plog("pull-busy", {});
      const waiting = readPending(authDir);
      return { pullId, count: 0, taken: 0, ignored: 0, saved: 0, waiting: waiting.length, chatsWaiting: chatsIn(waiting), reason: "busy", linked: undefined, report: null };
    }
    try { return await locked(); } finally { release(); }

    async function locked() {
      const taken = [];
      let ignored = 0;
      const fromHistory = { chats: new Set(), messages: 0 };
      // What this run learns of people and groups: pairs, contacts' names, push names, group names.
      const learnt = { lids: {}, names: {}, pushNames: {}, groups: {} };
      const onContacts = ({ lids = {}, names = {}, groups = {} } = {}) => {
        Object.assign(learnt.lids, lids);
        Object.assign(learnt.names, names);
        Object.assign(learnt.groups, groups);
      };
      const keepLearnt = () => {
        saveLids(authDir, learnt.lids);
        addToMap(authDir, NAMES, learnt.names, learnt.pushNames);
        saveGroups(authDir, learnt.groups);
      };
      const onMessage = (waMessage, meta) => {
        let record = formatInbound(waMessage);
        if (!record) { ignored += 1; return; }
        const push = cleanName(waMessage.pushName);
        if (push && !record.fromMe) for (const jid of [record.sender, record.senderAlt]) if (jid) learnt.pushNames[jid] = push;
        if (meta?.alt && !record.alt && record.kind === "direct" && meta.alt !== record.chat) {
          record = { ...record, alt: meta.alt, number: record.number || (meta.alt.endsWith("@s.whatsapp.net") ? jidUser(meta.alt) : "") };
        }
        taken.push(record);
        addPending(authDir, record);
        if (meta?.history !== undefined) {
          fromHistory.chats.add(record.chat);
          fromHistory.messages += 1;
          onHistory({ chats: fromHistory.chats.size, messages: fromHistory.messages });
        }
      };
      const names = {};
      const drained = async sock => {
        keepLearnt();
        // Every chat and saved file still to be named: what this run took, what waits, and what is saved under an id.
        const all = [...taken, ...readPending(authDir)];
        const groups = [...new Set([...all.map(r => r.chat), ...Object.keys(readChats(authDir))].filter(c => chatKind(c) === "group"))];
        const known = readGroups(authDir);
        const unnamed = groups.filter(g => !known[g]);
        if (unnamed.length) Object.assign(names, await groupNames(sock, unnamed));
        saveGroups(authDir, names);
        // A chat or sender WhatsApp names only by a LID: Baileys' own store of LIDs and phone numbers names its number.
        const paired = readLids(authDir);
        const lids = [...new Set(all.flatMap(r => [r.alt ? "" : r.chat, r.sender, r.senderAlt]).filter(j => isLid(j) && !paired[j]))];
        const lookup = sock?.signalRepository?.lidMapping;
        const found = {};
        for (const lid of typeof lookup?.getPNForLID === "function" ? lids : []) {
          try {
            const pn = await within(lookup.getPNForLID(lid), 2000);
            if (typeof pn === "string" && pn.includes("@")) found[lid] = phoneJid(pn);
          } catch { /* the LID stays unknown */ }
        }
        saveLids(authDir, found);
        if (afterDrain) await afterDrain(sock);
      };
      const r = await pullImpl({ authDir, log: plog, selfNumber, pair, onMessage, onContacts, onPairingCode, afterDrain: drained, history, now });

      // Once the phone accepts the code, WhatsApp asks for a new connection, and the phone sends the history on it.
      let historyReason;
      if (pair && r.reason === "linked" && history) {
        plog("history-wait", {});
        const h = await pullImpl({ authDir, log: plog, onMessage, onContacts, afterDrain: drained, history, waitHistory: true, now });
        historyReason = h.reason;
        r.count = h.count;
        plog("history-done", { reason: h.reason ?? "none", chats: fromHistory.chats.size, messages: fromHistory.messages, ...Object.fromEntries(Object.entries(h.history ?? {}).map(([k, v]) => [k, `${v.chats}/${v.messages}`])) });
      }

      // What waited from before, and what this run took, each message once, with the LID and phone pairs it names, the
      // person's own among them, and each sender named.
      keepLearnt();
      saveLids(authDir, Object.assign(selfPair(authDir), ...readPending(authDir).map(pairOf).filter(Boolean)));
      const lids = readLids(authDir);
      const people = readMap(authDir, NAMES);
      const waiting = readPending(authDir).map(r => withSender(withAlias(r, lids), lids, people));

      let report = null;
      let saved = 0;
      const groupNamesKnown = { ...readGroups(authDir), ...names };
      if ((waiting.length || namesToGive(authDir, groupNamesKnown)) && archive && trigger !== "link") {
        try {
          report = await archive(nextBatch(waiting), groupNamesKnown);
          const done = new Set((report?.saved ?? []).map(m => `${m.chat} ${m.id}`));
          const left = waiting.filter(m => !done.has(`${m.chat} ${m.id}`));
          saved = waiting.length - left.length;
          writePending(authDir, left);
        } catch (err) {
          report = { problem: err instanceof Error ? err.message : String(err) };
        }
      }
      const rest = readPending(authDir);
      const left = rest.length;
      const ranMs = now() - startAt;
      plog(r.reason && r.reason !== "linked" ? "pull-fail" : "pull-done", { reason: r.reason ?? "none", ranMs, count: r.count, taken: taken.length, saved, waiting: left });
      return {
        pullId, count: r.count, taken: taken.length, ignored, saved, waiting: left, chatsWaiting: chatsIn(rest),
        history: { chats: fromHistory.chats.size, messages: fromHistory.messages }, historyReason, reason: r.reason, linked: r.linked, report,
      };
    }
  }

  let inflightTrigger = null;
  /** A run while one is under way gets that run's result when it is the same kind, else a "busy" result at once. */
  function run(options = {}) {
    const trigger = options.trigger ?? "check";
    if (inflight && trigger === inflightTrigger) return inflight;
    if (inflight) {
      const waiting = readPending(authDir);
      return Promise.resolve({ count: 0, taken: 0, ignored: 0, saved: 0, waiting: waiting.length, chatsWaiting: chatsIn(waiting), reason: "busy", report: null });
    }
    inflightTrigger = trigger;
    inflight = once(options).finally(() => { inflight = null; inflightTrigger = null; });
    return inflight;
  }

  return { run, running: () => inflight };
}
