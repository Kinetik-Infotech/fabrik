// The check around the connection, lifted from maxy-lite's whatsapp-pull-orchestrator.test.mjs, with its inbox file
// replaced by the archive callback: what is kept, single flight, and messages that wait when fabrik can't be reached.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWhatsAppPull, readPending } from "../mcp/pull.mjs";
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

test("messages archive couldn't save wait in pending.json, once each, for the next run", async () => {
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
