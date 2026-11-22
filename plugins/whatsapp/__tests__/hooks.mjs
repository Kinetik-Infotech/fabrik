// The server's stand-in for WhatsApp, loaded through WHATSAPP_TEST_HOOKS. The messages each connection hands over are
// read from the JSON file WHATSAPP_TEST_MESSAGES names, and what the socket was asked to do is appended to
// WHATSAPP_TEST_CALLS, one JSON line each.
import { appendFileSync, readFileSync } from "node:fs";
import { pullWhatsApp as real } from "../mcp/baileys.mjs";
import { fakeBaileys } from "./stand-ins.mjs";

const calls = { push: one => appendFileSync(process.env.WHATSAPP_TEST_CALLS, JSON.stringify(one) + "\n") };
const messages = () => { try { return JSON.parse(readFileSync(process.env.WHATSAPP_TEST_MESSAGES, "utf8")); } catch { return []; } };
const groups = { "120363000000000001@g.us": "Family" };

export const pullWhatsApp = options => real({ ...options, baileys: fakeBaileys({ messages, calls, groups }) });
