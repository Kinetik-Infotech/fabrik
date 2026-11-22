// The server's stand-in for WhatsApp, loaded through WHATSAPP_TEST_HOOKS. The messages each connection hands over are
// read from the JSON file WHATSAPP_TEST_MESSAGES names, and what the socket was asked to do is appended to
// WHATSAPP_TEST_CALLS, one JSON line each. The history chunks the first connection after a link gets are read from
// WHATSAPP_TEST_HISTORY.
import { appendFileSync, readFileSync } from "node:fs";
import { pullWhatsApp as real } from "../mcp/baileys.mjs";
import { fakeBaileys } from "./stand-ins.mjs";

const calls = { push: one => appendFileSync(process.env.WHATSAPP_TEST_CALLS, JSON.stringify(one) + "\n") };
const messages = () => { try { return JSON.parse(readFileSync(process.env.WHATSAPP_TEST_MESSAGES, "utf8")); } catch { return []; } };
// The phone sends its history once, to the first connection after the link, as WhatsApp does.
let linked = false;
const history = () => {
  if (linked) return [];
  linked = true;
  try { return JSON.parse(readFileSync(process.env.WHATSAPP_TEST_HISTORY, "utf8")); } catch { return []; }
};
const groups = { "120363000000000001@g.us": "Family" };

const accept = process.env.WHATSAPP_TEST_ACCEPT !== "no";
const lateMs = Number(process.env.WHATSAPP_TEST_LATE_MS ?? 0);
const linkTimeoutMs = Number(process.env.WHATSAPP_TEST_LINK_TIMEOUT_MS ?? 180000);

export const waitMs = Number(process.env.WHATSAPP_TEST_WAIT_MS ?? 60000);

export const pullWhatsApp = options => real({
  ...options, quietMs: Number(process.env.WHATSAPP_TEST_QUIET_MS ?? 100), historyQuietMs: Number(process.env.WHATSAPP_TEST_HISTORY_QUIET_MS ?? 180000), linkTimeoutMs,
  baileys: fakeBaileys({ messages, history: options.pair ? () => [] : history, calls, groups, accept, lateMs }),
});
