// The check: one connection, then the messages it took handed to `archive`. Lifted from maxy-lite's
// channels/whatsapp/pull.mjs (createWhatsAppPull), with its inbox file replaced by the archive callback and its media
// download removed.
//
// Single flight is the safety rule: two connections on one keys folder corrupt the link, so a run while one is under
// way gets the first one's result rather than opening a second socket.
//
// WhatsApp forgets a message once this device has taken it, so nothing taken may be lost when fabrik can't be reached.
// Each run adds what it took to a list of messages still to save, `pending.json` in the keys folder, before archive
// runs, and archive's answer says which were saved. The rest wait for the next check.
import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { formatInbound, chatKind } from "./handler.mjs";
import { pullWhatsApp as defaultPull } from "./baileys.mjs";

export const PENDING = "pending.json";

export function readPending(authDir) {
  try {
    const list = JSON.parse(readFileSync(join(authDir, PENDING), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export function writePending(authDir, list) {
  const file = join(authDir, PENDING);
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(list), { mode: 0o600 });
  renameSync(temp, file);
  chmodSync(file, 0o600);
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
    const taken = [];
    let ignored = 0;
    const onMessage = waMessage => {
      const record = formatInbound(waMessage);
      if (!record) { ignored += 1; return; }
      taken.push(record);
    };
    const names = {};
    const drained = async sock => {
      const groups = [...new Set(taken.filter(r => chatKind(r.chat) === "group").map(r => r.chat))];
      if (groups.length && typeof sock?.groupMetadata === "function") Object.assign(names, await groupNames(sock, groups));
      if (afterDrain) await afterDrain(sock);
    };
    const r = await pullImpl({ authDir, log: plog, selfNumber, pair, onMessage, onPairingCode, afterDrain: drained, now });

    // What waits from before, then what this run took, each message once.
    const waiting = readPending(authDir);
    const known = new Set(waiting.map(m => `${m.chat} ${m.id}`));
    for (const m of taken) if (!known.has(`${m.chat} ${m.id}`)) { known.add(`${m.chat} ${m.id}`); waiting.push(m); }
    if (taken.length) writePending(authDir, waiting);

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

  function run(options = {}) {
    if (inflight) return inflight;
    inflight = once(options).finally(() => { inflight = null; });
    return inflight;
  }

  return { run, running: () => inflight };
}
