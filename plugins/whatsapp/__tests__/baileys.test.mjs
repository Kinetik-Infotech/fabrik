// The connection, lifted from maxy-lite's whatsapp-pull.test.mjs: a fake socket, no network and no keys. Both
// `notify` and `append` entries reach onMessage, the queue's size comes from the offline node, the connection ends on
// receivedPendingNotifications, pairing asks for a code on the `qr` signal, and every timeout ends in a typed reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { pullWhatsApp, linkedState, halfLinked, loadBaileys } from "../mcp/baileys.mjs";

function fake({ creds = { me: { id: "447700900123:5@s.whatsapp.net" }, account: {} } } = {}) {
  const ev = new EventEmitter();
  const ws = new EventEmitter();
  const seen = { requested: [], ended: false, config: null, saved: 0 };
  const sock = {
    ev, ws,
    requestPairingCode: async digits => { seen.requested.push(digits); return "ABCD1234"; },
    end: () => { seen.ended = true; },
  };
  const baileys = {
    makeWASocket: config => { seen.config = config; return sock; },
    useMultiFileAuthState: async () => ({ state: { creds }, saveCreds: async () => { seen.saved += 1; } }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    getBinaryNodeChild: (node, tag) => node?.content?.find(c => c.tag === tag),
    Browsers: { appropriate: () => ["Mac OS", "Chrome", "1"] },
  };
  return { ev, ws, seen, baileys, creds };
}
const flush = () => new Promise(r => setImmediate(r));
const lines = () => { const all = []; return { all, log: (op, f = {}) => all.push({ op, ...f }) }; };

test("connects without going online or asking for full history", async () => {
  const f = fake();
  const p = pullWhatsApp({ authDir: "/unused", baileys: f.baileys, quietMs: 20 });
  await flush();
  f.ev.emit("connection.update", { connection: "open" });
  f.ev.emit("connection.update", { receivedPendingNotifications: true });
  await p;
  assert.equal(f.seen.config.markOnlineOnConnect, false);
  assert.equal(f.seen.config.syncFullHistory, false);
  assert.equal(typeof f.seen.config.logger.child, "function", "Baileys gets a silent logger, so nothing reaches stdout");
});

test("drains notify and append, counts the announced queue, and ends the socket", async () => {
  const f = fake();
  const got = [];
  const p = pullWhatsApp({ authDir: "/unused", baileys: f.baileys, quietMs: 20, onMessage: m => got.push(m.key.id) });
  await flush();
  f.ev.emit("connection.update", { connection: "open" });
  f.ws.emit("CB:ib,,offline", { tag: "ib", content: [{ tag: "offline", attrs: { count: "19" } }] });
  f.ev.emit("messages.upsert", { type: "notify", messages: [{ key: { id: "A" } }] });
  f.ev.emit("messages.upsert", { type: "append", messages: [{ key: { id: "B" } }, { key: { id: "C" } }] });
  f.ev.emit("messages.upsert", { type: "history", messages: [{ key: { id: "X" } }] });
  f.ev.emit("connection.update", { receivedPendingNotifications: true });
  const r = await p;
  assert.deepEqual(got, ["A", "B", "C"]);
  assert.equal(r.received, 3);
  assert.equal(r.count, 19);
  assert.equal(r.reason, null);
  assert.ok(f.seen.ended);
});

test("afterDrain runs with the socket still open, before it ends", async () => {
  const f = fake();
  let endedDuring = null;
  const p = pullWhatsApp({ authDir: "/unused", baileys: f.baileys, quietMs: 20, afterDrain: async () => { await flush(); endedDuring = f.seen.ended; } });
  await flush();
  f.ev.emit("connection.update", { connection: "open" });
  f.ev.emit("connection.update", { receivedPendingNotifications: true });
  await p;
  assert.equal(endedDuring, false);
  assert.ok(f.seen.ended);
});

test("pairing: the qr signal asks for a code, the link window outlives the connect timeout, and WhatsApp's restart ends it linked", async () => {
  const f = fake({ creds: {} });
  const { all, log } = lines();
  const codes = [];
  const p = pullWhatsApp({ authDir: "/unused", baileys: f.baileys, quietMs: 20, log, pair: true, selfNumber: "447700900123", onPairingCode: c => codes.push(c), connectTimeoutMs: 20, linkTimeoutMs: 1000 });
  await flush();
  f.ev.emit("connection.update", { qr: "payload" });
  await new Promise(r => setTimeout(r, 45));
  f.creds.me = { id: "447700900123:9@s.whatsapp.net" };
  f.creds.account = { details: "signed" };
  f.ev.emit("creds.update", f.creds);
  f.ev.emit("connection.update", { isNewLogin: true });
  f.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
  const r = await p;
  assert.deepEqual(f.seen.requested, ["447700900123"]);
  assert.deepEqual(codes, ["ABCD1234"]);
  assert.equal(r.reason, "linked");
  assert.equal(r.linked, true);
  assert.equal(f.seen.saved, 1, "the new keys are saved before the run ends");
  assert.ok(all.find(l => l.op === "pairing-code" && l.codeLen === 8 && !("code" in l)), "the code itself never reaches the log");
});

test("a check on an account that isn't linked stops at once and asks for no code", async () => {
  const f = fake({ creds: {} });
  const p = pullWhatsApp({ authDir: "/unused", baileys: f.baileys, quietMs: 20, connectTimeoutMs: 60000 });
  await flush();
  f.ev.emit("connection.update", { qr: "payload" });
  const r = await p;
  assert.equal(r.reason, "not-linked");
  assert.deepEqual(f.seen.requested, []);
});

test("pairing with no number asks for no code", async () => {
  const f = fake({ creds: {} });
  const p = pullWhatsApp({ authDir: "/unused", baileys: f.baileys, quietMs: 20, pair: true, selfNumber: "" });
  await flush();
  f.ev.emit("connection.update", { qr: "payload" });
  assert.equal((await p).reason, "not-linked");
  assert.deepEqual(f.seen.requested, []);
});

test("WhatsApp logging the device out ends the run as logged-out", async () => {
  const f = fake();
  const p = pullWhatsApp({ authDir: "/unused", baileys: f.baileys, quietMs: 20 });
  await flush();
  f.ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
  assert.equal((await p).reason, "logged-out");
});

test("connect-timeout when neither open nor qr comes", async () => {
  const f = fake();
  const r = await pullWhatsApp({ authDir: "/unused", baileys: f.baileys, quietMs: 20, connectTimeoutMs: 20 });
  assert.equal(r.reason, "connect-timeout");
  assert.ok(f.seen.ended);
});

test("drain-timeout when the queue is never said to be delivered", async () => {
  const f = fake();
  const p = pullWhatsApp({ authDir: "/unused", baileys: f.baileys, quietMs: 20, drainTimeoutMs: 20 });
  await flush();
  f.ev.emit("connection.update", { connection: "open" });
  assert.equal((await p).reason, "drain-timeout");
});

test("a socket that fails to start ends the run at once", async () => {
  const f = fake();
  const { all, log } = lines();
  f.baileys.makeWASocket = () => { throw new Error("spawn failed"); };
  const r = await pullWhatsApp({ authDir: "/unused", baileys: f.baileys, quietMs: 20, log, connectTimeoutMs: 60000 });
  assert.equal(r.reason, "connect-timeout");
  assert.ok(all.find(l => l.op === "wa-connect-error"));
});

test("linkedState: only a finished pairing, which writes account, is a link", () => {
  // Baileys leaves registered false on a finished link, so it can't decide.
  assert.deepEqual(linkedState({ me: { id: "447700900123:5@s.whatsapp.net" }, account: {}, registered: false }), { linked: true, number: "447700900123" });
  assert.deepEqual(linkedState({ me: { id: "447700900123@s.whatsapp.net", name: "~" }, pairingCode: "ABCD1234" }), { linked: false, number: "" });
  assert.deepEqual(linkedState(null), { linked: false, number: "" });
  assert.equal(halfLinked({ me: { id: "447700900123@s.whatsapp.net", name: "~" }, pairingCode: "ABCD1234" }), true);
  assert.equal(halfLinked({ me: { id: "447700900123:5@s.whatsapp.net" }, account: {} }), false);
  assert.equal(halfLinked({}), false);
});

test("the run waits for messages Baileys hands over after it says the queue is delivered", async () => {
  const f = fake();
  const got = [];
  const p = pullWhatsApp({ authDir: "/unused", baileys: f.baileys, quietMs: 60, onMessage: m => got.push(m.key.id) });
  await flush();
  f.ev.emit("connection.update", { connection: "open" });
  f.ev.emit("connection.update", { receivedPendingNotifications: true });
  // Baileys is still decrypting: a frame comes, and its message is handed over a little later.
  await new Promise(r => setTimeout(r, 30));
  f.ws.emit("CB:message", {});
  await new Promise(r => setTimeout(r, 40));
  f.ev.emit("messages.upsert", { type: "append", messages: [{ key: { id: "LATE" } }] });
  const r = await p;
  assert.deepEqual(got, ["LATE"]);
  assert.equal(r.reason, null);
});

test("loadBaileys installs the packages once when they are missing, and names the command when that fails", async () => {
  const installs = [];
  await assert.rejects(
    loadBaileys({ root: "/plugin root", entry: "/no/such/baileys.js", install: async root => { installs.push(root); throw new Error("npm ERR! network"); } }),
    /installing it failed: npm_ERR!_network\. In a Terminal, run: cd '\/plugin root' && npm ci --omit=dev --ignore-scripts/,
  );
  assert.deepEqual(installs, ["/plugin root"]);
});
