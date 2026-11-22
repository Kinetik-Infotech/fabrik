// The check around the connection, lifted from maxy-lite's whatsapp-pull-orchestrator.test.mjs, with its inbox file
// replaced by the archive callback: what is kept, single flight, and messages that wait when fabrik can't be reached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWhatsAppPull, LOCK, readPending } from "../mcp/pull.mjs";
import { dm } from "./stand-ins.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "wa-pull-"));
const transport = list => async ({ onMessage, afterDrain }) => {
  for (const m of list) onMessage(m);
  await afterDrain?.({ groupMetadata: async () => ({ subject: "Family" }) });
  return { count: list.length, received: list.length, reason: null, linked: true };
};

test("hands the kept messages to archive, with group names, and leaves out the rest", async () => {
  const handed = [];
  const pull = createWhatsAppPull({
    authDir: dir(),
    pullImpl: transport([
      dm("A", "hi"),
      { key: { id: "G", remoteJid: "1203@g.us", participant: "447@s.whatsapp.net" }, message: { conversation: "all" }, pushName: "Sam", messageTimestamp: 1 },
      { key: { id: "S", remoteJid: "447111000111@s.whatsapp.net" }, message: { stickerMessage: {} } },
      { key: { id: "B", remoteJid: "status@broadcast" }, message: { conversation: "x" } },
    ]),
    archive: async (records, names) => { handed.push({ ids: records.map(r => r.id), names }); return { saved: records }; },
  });
  const r = await pull.run();
  assert.deepEqual(handed, [{ ids: ["A", "G"], names: { "1203@g.us": "Family" } }]);
  assert.equal(r.taken, 2);
  assert.equal(r.ignored, 2);
  assert.equal(r.saved, 2);
  assert.equal(r.waiting, 0);
});

test("single flight: two runs at once share one connection and one result", async () => {
  let connects = 0;
  const pull = createWhatsAppPull({
    authDir: dir(),
    pullImpl: async () => { connects += 1; await new Promise(r => setTimeout(r, 15)); return { count: 0, received: 0, reason: null }; },
  });
  const [a, b] = await Promise.all([pull.run(), pull.run()]);
  assert.equal(connects, 1);
  assert.strictEqual(a, b);
  await pull.run();
  assert.equal(connects, 2);
});

test("messages archive couldn't save wait in pending.jsonl, once each, for the next run", async () => {
  const authDir = dir();
  let refuse = true;
  const archived = [];
  const pull = createWhatsAppPull({
    authDir,
    pullImpl: transport([dm("A", "one"), dm("B", "two")]),
    archive: async records => {
      if (refuse) throw new Error("fabrik is down");
      archived.push(...records.map(r => r.id));
      return { saved: records };
    },
  });
  const first = await pull.run();
  assert.equal(first.report.problem, "fabrik is down");
  assert.equal(first.waiting, 2);
  const second = await pull.run();
  assert.equal(second.waiting, 2, "the same two messages taken again are kept once each");
  assert.deepEqual(readPending(authDir).map(m => m.id), ["A", "B"]);
  refuse = false;
  const third = await pull.run();
  assert.equal(third.waiting, 0);
  assert.deepEqual(archived, ["A", "B"]);
  assert.deepEqual(readPending(authDir), []);
});

test("a failure the connection reports is passed on, with what was taken", async () => {
  const pull = createWhatsAppPull({ authDir: dir(), pullImpl: async () => ({ count: 0, received: 0, reason: "connect-timeout" }) });
  const r = await pull.run();
  assert.equal(r.reason, "connect-timeout");
  assert.equal(r.taken, 0);
});

test("each message is on disk as it arrives, before the connection ends", async () => {
  const authDir = dir();
  let onDisk = null;
  const pull = createWhatsAppPull({
    authDir,
    pullImpl: async ({ onMessage }) => {
      onMessage(dm("A", "one"));
      // The session could end here, with the connection still open.
      onDisk = readPending(authDir).map(m => m.id);
      return { count: 1, received: 1, reason: null };
    },
  });
  await pull.run();
  assert.deepEqual(onDisk, ["A"]);
});

test("a second session finds the keys folder locked and connects nothing; a dead session's lock is taken over", async () => {
  const authDir = dir();
  let connects = 0;
  const pullImpl = async () => { connects += 1; return { count: 0, received: 0, reason: null }; };
  writeFileSync(join(authDir, LOCK), String(process.pid));
  const busy = await createWhatsAppPull({ authDir, pullImpl }).run();
  assert.equal(busy.reason, "busy");
  assert.equal(connects, 0);
  writeFileSync(join(authDir, LOCK), "999999");
  const r = await createWhatsAppPull({ authDir, pullImpl }).run();
  assert.equal(r.reason, null);
  assert.equal(connects, 1);
  assert.equal(existsSync(join(authDir, LOCK)), false, "the lock goes when the run ends");
});

test("an unlink while a check runs is busy, and doesn't take the check's result", async () => {
  let release;
  const pull = createWhatsAppPull({ authDir: dir(), pullImpl: () => new Promise(r => { release = () => r({ count: 0, received: 0, reason: null }); }) });
  const check = pull.run({ trigger: "check" });
  await new Promise(r => setImmediate(r));
  const unlink = await pull.run({ trigger: "unlink" });
  assert.equal(unlink.reason, "busy");
  release();
  assert.equal((await check).reason, null);
});
