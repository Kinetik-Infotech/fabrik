// The chat files: what a new file holds, where a later message goes, and that two checks of the same messages leave
// each message in the file once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeChat, saveChats, idsIn, fileName } from "../mcp/archive.mjs";
import { formatInbound } from "../mcp/handler.mjs";
import { dm } from "./stand-ins.mjs";

const TZ = "Europe/London";
const rec = (...a) => formatInbound(dm(...a));
const memory = () => {
  const files = new Map();
  return { files, read: async p => files.get(p) ?? null, write: async (p, t) => { files.set(p, t); } };
};

test("two checks of the same messages leave each message in the file once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-arch-"));
  const store = memory();
  const list = [rec("A1", "hello"), rec("A2", "again", { at: 1795000060 })];
  const first = await saveChats(list, {}, { dir, files: store, timeZone: TZ });
  const second = await saveChats([...list, rec("A1", "hello")], {}, { dir, files: store, timeZone: TZ });
  assert.deepEqual(first.chats, [{ file: "whatsapp/Kate.md", added: 2 }]);
  assert.deepEqual(second.chats, [{ file: "whatsapp/Kate.md", added: 0 }]);
  const text = store.files.get("whatsapp/Kate.md");
  assert.equal(text.match(/wa:A1 /g).length, 1);
  assert.equal(text.match(/wa:A2 /g).length, 1);
  assert.equal(second.saved.length, 3, "messages already in the file count as saved");
});

test("a later message goes under its own day, and an earlier one under its day, in time order", () => {
  let { text } = mergeChat(null, "WhatsApp: Kate", [rec("A2", "noon", { at: 1795003200 })], { timeZone: TZ });
  ({ text } = mergeChat(text, "WhatsApp: Kate", [rec("A3", "next day", { at: 1795089600 }), rec("A1", "morning", { at: 1794996000 })], { timeZone: TZ }));
  assert.equal(text, [
    "# WhatsApp: Kate", "",
    "## 2026-11-18", "",
    "- 10:00 **Kate:** morning <!-- wa:A1 -->",
    "- 12:00 **Kate:** noon <!-- wa:A2 -->", "",
    "## 2026-11-19", "",
    "- 12:00 **Kate:** next day <!-- wa:A3 -->", "",
  ].join("\n"));
  assert.deepEqual([...idsIn(text)], ["A1", "A2", "A3"]);
});

test("what the file held before is kept as it was", () => {
  const before = "# WhatsApp: Kate\n\nNotes the person wrote.\n\n## 2026-11-18\n\n- 09:00 **Kate:** old <!-- wa:X -->\n";
  const { text, added } = mergeChat(before, "ignored", [rec("A1", "new", { at: 1795000000 })], { timeZone: TZ });
  assert.equal(added, 1);
  assert.ok(text.startsWith("# WhatsApp: Kate\n\nNotes the person wrote.\n\n## 2026-11-18\n\n- 09:00 **Kate:** old <!-- wa:X -->\n- 11:06"));
});

test("a chat keeps its file when the name changes, and two chats with one name get two files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-arch-"));
  const store = memory();
  await saveChats([rec("A1", "hi")], {}, { dir, files: store, timeZone: TZ });
  await saveChats([rec("A2", "hi", { from: "Katie" })], {}, { dir, files: store, timeZone: TZ });
  await saveChats([rec("B1", "hi", { jid: "447999000999@s.whatsapp.net" })], {}, { dir, files: store, timeZone: TZ });
  assert.deepEqual([...store.files.keys()].sort(), ["whatsapp/Kate 447999000999.md", "whatsapp/Kate.md"]);
});

test("a chat whose file can't be written waits, and the other chats are still saved", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-arch-"));
  const store = memory();
  const write = store.write;
  store.write = async (p, t) => { if (p.includes("Kate")) throw new Error("refused"); return write(p, t); };
  const r = await saveChats([rec("A1", "hi"), rec("B1", "yo", { from: "Lee", jid: "447333000333@s.whatsapp.net" })], {}, { dir, files: store, timeZone: TZ });
  assert.deepEqual(r.saved.map(m => m.id), ["B1"]);
  assert.deepEqual(r.failed, [{ file: "whatsapp/Kate.md", problem: "refused" }]);
});

test("file names stay one safe part of a path", () => {
  assert.equal(fileName("../Mum / Dad: \"home\""), "Mum Dad home");
  assert.equal(fileName("..."), "chat");
});
