// Which WhatsApp messages are kept, and the record kept for each. Lifted from maxy-lite's
// channels/whatsapp/handler.mjs. maxy-lite kept direct messages from others and the self-chat; a chat file here keeps
// both sides of every direct chat and every group, so the person's own messages are kept too. Status updates,
// channels, reactions, stickers and protocol messages are left out.

/** The user part of a JID ("447…@s.whatsapp.net", "447…:12@…", "123@lid") as a bare id. */
export function jidUser(jid) {
  return typeof jid === "string" ? jid.split("@")[0].split(":")[0] : "";
}

/** Which kind of chat a JID is: "direct", "group", or null for anything else. */
export function chatKind(jid) {
  if (typeof jid !== "string") return null;
  if (jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid")) return "direct";
  if (jid.endsWith("@g.us")) return "group";
  return null;
}

function mediaContent(type, node, { hasFileName = false } = {}) {
  const caption = typeof node?.caption === "string" ? node.caption : "";
  const media = { type, caption };
  if (hasFileName) media.fileName = typeof node?.fileName === "string" ? node.fileName : "";
  return { text: caption, media };
}

/** A message's text, or the photo, video, voice note or document it carries. Anything else is { text: null, media: null }. */
export function extractContent(message) {
  if (!message) return { text: null, media: null };
  // A disappearing or view-once message wraps the real one.
  const inner = message.ephemeralMessage?.message ?? message.viewOnceMessage?.message ?? message.viewOnceMessageV2?.message
    ?? message.documentWithCaptionMessage?.message;
  if (inner) return extractContent(inner);
  if (typeof message.conversation === "string") return { text: message.conversation, media: null };
  if (typeof message.extendedTextMessage?.text === "string") return { text: message.extendedTextMessage.text, media: null };
  if (message.imageMessage) return mediaContent("photo", message.imageMessage);
  if (message.documentMessage) return mediaContent("document", message.documentMessage, { hasFileName: true });
  if (message.videoMessage) return mediaContent("video", message.videoMessage);
  if (message.audioMessage) return mediaContent(message.audioMessage.ptt ? "voice note" : "audio", message.audioMessage);
  return { text: null, media: null };
}

/** A name safe on one line of Markdown: no newlines, no brackets or asterisks, at most 64 characters. */
export function cleanName(name) {
  return String(name ?? "").replace(/[\r\n]+/g, " ").replace(/[[\]*_`<>]/g, "").trim().slice(0, 64);
}

/** "keep" for a message the chat file holds, else "ignore". */
export function classifyInbound(waMessage) {
  const key = waMessage?.key;
  if (!key || typeof key.id !== "string") return "ignore";
  if (!chatKind(key.remoteJid)) return "ignore";
  const { text, media } = extractContent(waMessage.message);
  if (text === null && media === null) return "ignore";
  return "keep";
}

/**
 * The record kept for one message, or null for one that isn't kept:
 * { id, chat, kind, number, from, fromMe, at, text, media }. `chat` is the chat's JID, `number` the other person's
 * phone number in a direct chat when WhatsApp gives it, `from` the sender's name, and `at` the time in milliseconds.
 */
export function formatInbound(waMessage) {
  if (classifyInbound(waMessage) === "ignore") return null;
  const key = waMessage.key;
  const chat = key.remoteJid;
  const kind = chatKind(chat);
  const { text, media } = extractContent(waMessage.message);
  const phoneJid = [chat, key.remoteJidAlt].find(j => typeof j === "string" && j.endsWith("@s.whatsapp.net"));
  const sender = kind === "group" ? (key.participantAlt ?? key.participant) : chat;
  const from = key.fromMe ? "Me" : cleanName(waMessage.pushName) || (jidUser(sender) ? `+${jidUser(sender)}` : "Unknown");
  const seconds = Number(waMessage.messageTimestamp?.toString?.() ?? waMessage.messageTimestamp ?? 0);
  return {
    id: key.id, chat, kind, number: kind === "direct" && phoneJid ? jidUser(phoneJid) : "", from, fromMe: !!key.fromMe,
    at: seconds > 0 ? seconds * 1000 : Date.now(), text: text ?? "", media,
  };
}

/** The line a photo, video, voice note or document leaves in the file: its kind, its name and its caption. */
export function mediaNote(media) {
  return [`[${media.type}]`, media.fileName, media.caption].filter(Boolean).join(" ");
}
