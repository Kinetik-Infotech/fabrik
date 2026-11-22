// The server's stand-in for WhatsApp, loaded through WHATSAPP_TEST_HOOKS. The messages each connection hands over are
// read from the JSON file WHATSAPP_TEST_MESSAGES names, and what the socket was asked to do is appended to
// WHATSAPP_TEST_CALLS, one JSON line each. The history chunks the first connection after a link gets are read from
// WHATSAPP_TEST_HISTORY.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pullWhatsApp as real } from "../mcp/baileys.mjs";
import { fakeBaileys, fakeLaunchctl } from "./stand-ins.mjs";

const calls = { push: one => appendFileSync(process.env.WHATSAPP_TEST_CALLS, JSON.stringify(one) + "\n") };
const messages = () => { try { return JSON.parse(readFileSync(process.env.WHATSAPP_TEST_MESSAGES, "utf8")); } catch { return []; } };
// The phone sends its history to the first connection after the link, as WhatsApp does.
// The file holds a list of chunks, or { chunks, holdMs } for history Baileys holds back. A connection after the first
// gets the chunks marked `later`, as the phone sends what a closed connection didn't take.
// The count of connections is kept beside the file, so a server started again carries on from it.
const history = () => {
  if (!process.env.WHATSAPP_TEST_HISTORY) return { chunks: [] };
  let file = [];
  try { file = JSON.parse(readFileSync(process.env.WHATSAPP_TEST_HISTORY, "utf8")); } catch { /* none */ }
  const { chunks = [], holdMs } = Array.isArray(file) ? { chunks: file } : file;
  const counter = `${process.env.WHATSAPP_TEST_HISTORY}.sent`;
  let sent = 0;
  try { sent = Number(readFileSync(counter, "utf8")) || 0; } catch { /* first */ }
  sent += 1;
  writeFileSync(counter, String(sent));
  return { holdMs: sent === 1 ? holdMs : undefined, chunks: chunks.filter(c => (sent === 1 ? !c.later : c.later && sent === 2)) };
};
// The group names WhatsApp gives, from the JSON file WHATSAPP_TEST_GROUPS names when a test sets one, read at each
// connection, so a test can give a name later.
const groups = () => {
  try { return JSON.parse(readFileSync(process.env.WHATSAPP_TEST_GROUPS, "utf8")); } catch { return { "120363000000000001@g.us": "Family" }; }
};
const lids = { "88888888888888@lid": "447222000222:0@s.whatsapp.net" };

const accept = process.env.WHATSAPP_TEST_ACCEPT !== "no";
const lateMs = Number(process.env.WHATSAPP_TEST_LATE_MS ?? 0);
const linkTimeoutMs = Number(process.env.WHATSAPP_TEST_LINK_TIMEOUT_MS ?? 180000);

export const waitMs = Number(process.env.WHATSAPP_TEST_WAIT_MS ?? 60000);

export const pullWhatsApp = options => real({
  ...options, quietMs: Number(process.env.WHATSAPP_TEST_QUIET_MS ?? 100), historyQuietMs: Number(process.env.WHATSAPP_TEST_HISTORY_QUIET_MS ?? 180000), linkTimeoutMs,
  baileys: fakeBaileys({ messages, history: options.pair ? () => ({ chunks: [] }) : history, calls, groups: groups(), lids, accept, lateMs }),
});

// launchctl, for whatsapp_timer: each call is added to WHATSAPP_TEST_CALLS as { op: "launchctl", args }, and the jobs
// loaded are kept beside it.
const timer = fakeLaunchctl({ calls: { push: args => calls.push({ op: "launchctl", args }) }, file: `${process.env.WHATSAPP_TEST_CALLS}.launchd` });
export const launchctl = timer.run;
