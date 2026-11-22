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
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync, renameSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { formatInbound, chatKind } from "./handler.mjs";
import { pullWhatsApp as defaultPull } from "./baileys.mjs";

export const PENDING = "pending.jsonl";
export const LOCK = "check.lock";

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
 * run({ pair, selfNumber, onPairingCode, afterDrain }) answers
 * { pullId, count, taken, ignored, saved, waiting, reason, linked, report }.
 */
export function createWhatsAppPull({ authDir, archive, log = () => {}, pullImpl = defaultPull, now = () => Date.now(), genId = () => randomUUID().slice(0, 8) }) {
  let inflight = null;

  async function once({ trigger = "check", pair = false, selfNumber = "", onPairingCode, afterDrain } = {}) {
    const pullId = genId();
    const plog = (op, fields = {}) => log(op, { pullId, ...fields });
    const startAt = now();
    plog("pull-start", { trigger });
    const release = takeLock(authDir);
    if (!release) {
      plog("pull-busy", {});
      return { pullId, count: 0, taken: 0, ignored: 0, saved: 0, waiting: readPending(authDir).length, reason: "busy", linked: undefined, report: null };
    }
    try { return await locked(); } finally { release(); }

    async function locked() {
      const taken = [];
      let ignored = 0;
      const onMessage = waMessage => {
        const record = formatInbound(waMessage);
        if (!record) { ignored += 1; return; }
        taken.push(record);
        addPending(authDir, record);
      };
      const names = {};
      const drained = async sock => {
        const groups = [...new Set(taken.filter(r => chatKind(r.chat) === "group").map(r => r.chat))];
        if (groups.length && typeof sock?.groupMetadata === "function") Object.assign(names, await groupNames(sock, groups));
        if (afterDrain) await afterDrain(sock);
      };
      const r = await pullImpl({ authDir, log: plog, selfNumber, pair, onMessage, onPairingCode, afterDrain: drained, now });

      // What waited from before, and what this run took, each message once.
      const waiting = readPending(authDir);

      let report = null;
      let saved = 0;
      if (waiting.length && archive) {
        try {
          report = await archive(waiting, names);
          const done = new Set((report?.saved ?? []).map(m => `${m.chat} ${m.id}`));
          const left = waiting.filter(m => !done.has(`${m.chat} ${m.id}`));
          saved = waiting.length - left.length;
          writePending(authDir, left);
        } catch (err) {
          report = { problem: err instanceof Error ? err.message : String(err) };
        }
      }
      const left = waiting.length - saved;
      const ranMs = now() - startAt;
      plog(r.reason && r.reason !== "linked" ? "pull-fail" : "pull-done", { reason: r.reason ?? "none", ranMs, count: r.count, taken: taken.length, saved, waiting: left });
      return { pullId, count: r.count, taken: taken.length, ignored, saved, waiting: left, reason: r.reason, linked: r.linked, report };
    }
  }

  let inflightTrigger = null;
  /** A run while one is under way gets that run's result when it is the same kind, else a "busy" result at once. */
  function run(options = {}) {
    const trigger = options.trigger ?? "check";
    if (inflight && trigger === inflightTrigger) return inflight;
    if (inflight) return Promise.resolve({ count: 0, taken: 0, ignored: 0, saved: 0, waiting: readPending(authDir).length, reason: "busy", report: null });
    inflightTrigger = trigger;
    inflight = once(options).finally(() => { inflight = null; inflightTrigger = null; });
    return inflight;
  }

  return { run, running: () => inflight };
}
