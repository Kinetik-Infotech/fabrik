// Which messages are kept and the record kept for each, lifted from maxy-lite's whatsapp-handler.test.mjs. Unlike
// maxy-lite, groups and the person's own messages are kept: a chat file holds both sides of the chat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyInbound, formatInbound, jidUser, mediaNote, cleanName } from "../mcp/handler.mjs";
import { normalizeE164, maskPhone } from "../mcp/normalize.mjs";

const DM = "447700900123@s.whatsapp.net";
const msg = (message, key = {}) => ({ key: { id: "1", remoteJid: DM, fromMe: false, ...key }, message, pushName: "Kate", messageTimestamp: 1795000000 });

test("direct chats, LID chats, groups and the person's own messages are kept", () => {
  assert.equal(classifyInbound(msg({ conversation: "hi" })), "keep");
  assert.equal(classifyInbound(msg({ conversation: "hi" }, { remoteJid: "7303@lid" })), "keep");
  assert.equal(classifyInbound(msg({ conversation: "hi" }, { remoteJid: "1203@g.us", participant: DM })), "keep");
  assert.equal(classifyInbound(msg({ conversation: "to a friend" }, { fromMe: true })), "keep");
});

test("status updates, channels, stickers, reactions and keyless messages are left out", () => {
  assert.equal(classifyInbound(msg({ conversation: "x" }, { remoteJid: "status@broadcast" })), "ignore");
  assert.equal(classifyInbound(msg({ conversation: "x" }, { remoteJid: "1234@newsletter" })), "ignore");
  assert.equal(classifyInbound(msg({ stickerMessage: {} })), "ignore");
  assert.equal(classifyInbound(msg({ reactionMessage: { text: "👍" } })), "ignore");
  assert.equal(classifyInbound({ message: { conversation: "x" } }), "ignore");
});

test("a record carries the chat, the sender's name, the time, and Me for the person's own message", () => {
  const r = formatInbound(msg({ extendedTextMessage: { text: "see you" } }));
  assert.deepEqual(r, { id: "1", chat: DM, alt: "", kind: "direct", number: "447700900123", from: "Kate", fromMe: false, at: 1795000000000, text: "see you", media: null });
  assert.equal(formatInbound(msg({ conversation: "x" }, { fromMe: true })).from, "Me");
});

test("a LID chat takes its number from remoteJidAlt, and a group sender with no name is named by number", () => {
  assert.equal(formatInbound(msg({ conversation: "x" }, { remoteJid: "7303@lid", remoteJidAlt: "447333000333@s.whatsapp.net" })).number, "447333000333");
  const g = formatInbound({ key: { id: "g", remoteJid: "1203@g.us", participant: "447222000222@s.whatsapp.net" }, message: { conversation: "x" }, messageTimestamp: 1 });
  assert.equal(g.from, "+447222000222");
  assert.equal(g.number, "");
});

test("photos, videos, voice notes and documents become notes, with the caption and file name", () => {
  assert.equal(mediaNote(formatInbound(msg({ imageMessage: { caption: "a cat" } })).media), "[photo] a cat");
  assert.equal(mediaNote(formatInbound(msg({ documentMessage: { fileName: "invite.ics" } })).media), "[document] invite.ics");
  assert.equal(mediaNote(formatInbound(msg({ videoMessage: {} })).media), "[video]");
  assert.equal(mediaNote(formatInbound(msg({ audioMessage: { ptt: true } })).media), "[voice note]");
  assert.equal(mediaNote(formatInbound(msg({ ephemeralMessage: { message: { imageMessage: { caption: "gone soon" } } } })).media), "[photo] gone soon");
});

test("a sender's name can't break the file's Markdown", () => {
  assert.equal(cleanName("**Bob**\n[x](y) <!-- z -->"), "Bob x(y) !-- z --");
  assert.equal(cleanName("a".repeat(100)).length, 64);
});

test("jidUser, normalizeE164 and maskPhone", () => {
  assert.equal(jidUser("447700900123:12@s.whatsapp.net"), "447700900123");
  assert.equal(normalizeE164("+44 (0) 7700-900123".replace("(0) ", "")), "447700900123");
  assert.equal(normalizeE164("0044 7700 900123"), "447700900123");
  assert.equal(normalizeE164("not a number"), "");
  assert.equal(maskPhone("447700900123"), "44********23");
});
