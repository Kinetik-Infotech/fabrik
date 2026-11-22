// A group message's sender. A message from the phone's history names its group sender in the message's own
// `participant`, not in its key, so a group's history once showed every sender as "Unknown".
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatInbound } from "../mcp/handler.mjs";
import { mergeChat } from "../mcp/archive.mjs";

const TZ = "Europe/London";
const GROUP = "120363000000000009@g.us";
const fromHistory = (id, { participant, pushName } = {}) =>
  ({ key: { id, remoteJid: GROUP, fromMe: false }, participant, ...(pushName ? { pushName } : {}), message: { conversation: "from history" }, messageTimestamp: 1795000000 });

test("a history message names its group sender from the message's own participant", () => {
  const r = formatInbound(fromHistory("H1", { participant: "447222000222@s.whatsapp.net" }));
  assert.equal(r.sender, "447222000222@s.whatsapp.net");
  assert.equal(r.from, "+447222000222");
});

test("a history message from a LID sender keeps the LID, so the check can name them", () => {
  const r = formatInbound(fromHistory("H2", { participant: "7303000@lid" }));
  assert.equal(r.sender, "7303000@lid");
  assert.equal(r.from, "");
});

test("a line saved as Unknown takes the sender's name when the same message comes again", () => {
  const unknown = { ...formatInbound(fromHistory("H3")), from: "", sender: "" };
  let { text } = mergeChat(null, "Rubysoft Crew", [unknown], { timeZone: TZ, chat: GROUP });
  assert.match(text, /\*\*Unknown:\*\* from history/);
  const named = formatInbound(fromHistory("H3", { participant: "447222000222@s.whatsapp.net", pushName: "Sam" }));
  const again = mergeChat(text, "Rubysoft Crew", [named], { timeZone: TZ, chat: GROUP });
  assert.match(again.text, /\*\*Sam:\*\* from history/);
  assert.doesNotMatch(again.text, /Unknown/);
  assert.equal(again.added, 0);
  assert.equal((again.text.match(/wa:H3/g) ?? []).length, 1);
});

test("a named line is never renamed", () => {
  const first = formatInbound(fromHistory("H4", { participant: "447222000222@s.whatsapp.net", pushName: "Sam" }));
  const { text } = mergeChat(null, "Rubysoft Crew", [first], { timeZone: TZ, chat: GROUP });
  const other = formatInbound(fromHistory("H4", { participant: "447222000222@s.whatsapp.net", pushName: "Samuel" }));
  assert.equal(mergeChat(text, "Rubysoft Crew", [other], { timeZone: TZ, chat: GROUP }).text, text);
});

test("a check saves a chat file whose Unknown lines it named, though it added no message", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveChats } = await import("../mcp/archive.mjs");
  const dir = mkdtempSync(join(tmpdir(), "wa-senders-"));
  const files = new Map();
  const store = { read: async p => files.get(p) ?? null, write: async (p, t) => { files.set(p, t); } };
  const unknown = { ...formatInbound(fromHistory("H5")), from: "", sender: "" };
  await saveChats([unknown], { [GROUP]: "Rubysoft Crew" }, { dir, files: store, timeZone: TZ });
  const [path] = files.keys();
  assert.match(files.get(path), /\*\*Unknown:\*\*/);
  const named = formatInbound(fromHistory("H5", { participant: "447222000222@s.whatsapp.net", pushName: "Sam" }));
  await saveChats([named], { [GROUP]: "Rubysoft Crew" }, { dir, files: store, timeZone: TZ });
  assert.match(files.get(path), /\*\*Sam:\*\* from history/);
});
