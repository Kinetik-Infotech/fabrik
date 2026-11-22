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
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync, renameSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { formatInbound, chatKind } from "./handler.mjs";
import { pullWhatsApp as defaultPull } from "./baileys.mjs";

export const PENDING = "pending.jsonl";
export const LOCK = "check.lock";
/** The group names read while a socket was open, kept so messages saved at a later check still have them. */
export const GROUPS = "groups.json";
export const CHATS_PER_CHECK = 20;

/** The chats waiting to be saved. */
export const chatsIn = list => new Set(list.map(m => m.chat)).size;

/** The messages of the `limit` chats whose oldest message is oldest, and how many chats that leaves. */
export function nextBatch(list, limit = CHATS_PER_CHECK) {
  const oldest = new Map();
  for (const m of list) if (!oldest.has(m.chat) || m.at < oldest.get(m.chat)) oldest.set(m.chat, m.at);
  const chosen = new Set([...oldest].sort((a, b) => a[1] - b[1]).slice(0, limit).map(([chat]) => chat));
  return list.filter(m => chosen.has(m.chat));
}

const readGroups = dir => { try { return JSON.parse(readFileSync(join(dir, GROUPS), "utf8")) ?? {}; } catch { return {}; } };
function saveGroups(dir, names) {
  if (!Object.keys(names).length) return;
  const file = join(dir, GROUPS);
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...readGroups(dir), ...names }, null, 1), { mode: 0o600 });
  renameSync(temp, file);
}

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

/** Group names, read while the socket is open: a query, never a message. Each waits at most `ms`. */
async function groupNames(sock, jids, ms = 5000) {
  const names = {};
  for (const jid of jids) {
    let timer;
    try {
      const meta = await Promise.race([sock.groupMetadata(jid), new Promise((_, no) => { timer = setTimeout(() => no(new Error("timeout")), ms); })]);
      if (typeof meta?.subject === "string" && meta.subject.trim()) names[jid] = meta.subject.trim();
    } catch { /* the file is named by the group's id */ }
    finally { clearTimeout(timer); }
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
      const onMessage = (waMessage, meta) => {
        const record = formatInbound(waMessage);
        if (!record) { ignored += 1; return; }
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
        const groups = [...new Set(taken.filter(r => chatKind(r.chat) === "group").map(r => r.chat))];
        const known = readGroups(authDir);
        const unnamed = groups.filter(g => !known[g]);
        if (unnamed.length && typeof sock?.groupMetadata === "function") Object.assign(names, await groupNames(sock, unnamed));
        saveGroups(authDir, names);
        if (afterDrain) await afterDrain(sock);
      };
      const r = await pullImpl({ authDir, log: plog, selfNumber, pair, onMessage, onPairingCode, afterDrain: drained, history, now });

      // Once the phone accepts the code, WhatsApp asks for a new connection, and the phone sends the history on it.
      let historyReason;
      if (pair && r.reason === "linked" && history) {
        plog("history-wait", {});
        const h = await pullImpl({ authDir, log: plog, onMessage, afterDrain: drained, history, waitHistory: true, now });
        historyReason = h.reason;
        r.count = h.count;
        plog("history-done", { reason: h.reason ?? "none", chats: fromHistory.chats.size, messages: fromHistory.messages, ...Object.fromEntries(Object.entries(h.history ?? {}).map(([k, v]) => [k, `${v.chats}/${v.messages}`])) });
      }

      // What waited from before, and what this run took, each message once.
      const waiting = readPending(authDir);

      let report = null;
      let saved = 0;
      if (waiting.length && archive && trigger !== "link") {
        try {
          report = await archive(nextBatch(waiting), { ...readGroups(authDir), ...names });
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
