// Stand-ins for the two things a test can't reach: WhatsApp's servers, and the person's fabrik project.
//
// fakeBaileys is Baileys' surface as baileys.mjs uses it. Its socket plays one connection: an account with no keys
// gets the `qr` signal, then, once the code is asked for, the phone accepting it and WhatsApp's restart; an account
// with keys opens, announces its queue, hands over the scripted messages and says the queue is delivered. Everything
// the socket is asked to do is written to `calls`.
//
// standInFabrik is an HTTP server with the calls fabrik.mjs makes: who the person is, their scopes, and Storage's
// download and upload.
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function fakeBaileys({ messages = () => [], history = () => ({ chunks: [] }), linkAs = "447700900123", calls = [], groups = {}, lids = {}, accept = true, lateMs = 0 } = {}) {
  return {
    calls,
    async useMultiFileAuthState(dir) {
      mkdirSync(dir, { recursive: true });
      let creds = {};
      try { creds = JSON.parse(readFileSync(join(dir, "creds.json"), "utf8")); } catch { /* new */ }
      return { state: { creds, keys: {} }, saveCreds: async () => writeFileSync(join(dir, "creds.json"), JSON.stringify(creds)) };
    },
    async fetchLatestBaileysVersion() { return { version: [2, 3000, 0] }; },
    getBinaryNodeChild: (node, tag) => node?.content?.find(c => c.tag === tag),
    Browsers: { appropriate: () => ["Mac OS", "Chrome", "1"] },
    makeWASocket(config) {
      calls.push({ op: "connect", markOnlineOnConnect: config.markOnlineOnConnect, syncFullHistory: config.syncFullHistory });
      const ev = new EventEmitter();
      let holding = false;
      ev.isBuffering = () => holding;
      const ws = new EventEmitter();
      const creds = config.auth.creds;
      const sock = {
        ev, ws,
        async requestPairingCode(digits) {
          calls.push({ op: "pairing-code", digits });
          // As Baileys does: asking for a code writes `me`, and only a finished pairing writes `account`.
          creds.me = { id: `${digits}@s.whatsapp.net`, name: "~" };
          creds.pairingCode = "ABCD1234";
          ev.emit("creds.update", creds);
          if (!accept) return "ABCD1234";
          setTimeout(() => {
            creds.me = { id: `${linkAs}:7@s.whatsapp.net` };
            creds.registered = true;
            creds.account = { details: "signed" };
            ev.emit("creds.update", creds);
            ev.emit("connection.update", { isNewLogin: true });
            ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
          }, 50);
          return "ABCD1234";
        },
        // Baileys' store of each contact's LID and phone number.
        signalRepository: { lidMapping: { async getPNForLID(lid) { calls.push({ op: "lid", lid }); return lids[lid] ?? null; } } },
        async groupMetadata(jid) { calls.push({ op: "group-name", jid }); return { subject: groups[jid] ?? "" }; },
        async logout() { calls.push({ op: "logout" }); },
        end() { calls.push({ op: "end" }); },
      };
      setImmediate(() => {
        if (!creds.me) return ev.emit("connection.update", { qr: "payload" });
        // Keys from a code never typed: WhatsApp refuses the login, and sends no qr.
        if (!creds.account) return ev.emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 401 } } } });
        ev.emit("connection.update", { connection: "open" });
        const list = messages();
        ws.emit("CB:ib,,offline", { tag: "ib", content: [{ tag: "offline", attrs: { count: String(list.length) } }] });
        // As Baileys does, the queue is said to be delivered before its messages are decrypted and handed over.
        ev.emit("connection.update", { receivedPendingNotifications: true });
        setTimeout(() => {
          for (const m of list) { ws.emit("CB:message", {}); ev.emit("messages.upsert", { type: "append", messages: [m] }); }
        }, lateMs);
        // The recent history the phone sends a new device, in chunks, each `afterMs` after the queue is delivered. As
        // Baileys does, a chunk of a type the socket's shouldSyncHistoryMessage refuses is dropped. A chunk with
        // `status` is followed by Baileys' word that its sync type is complete, which is never held back. With
        // `holdMs`, Baileys holds the chunks back and, at holdMs, hands them over as one set named by the last chunk's
        // type.
        const { chunks = [], holdMs } = history();
        const keep = config.shouldSyncHistoryMessage ?? (({ syncType }) => syncType !== 2);
        const held = [];
        if (holdMs !== undefined) {
          holding = true;
          setTimeout(() => {
            holding = false;
            if (!held.length) return;
            const last = held[held.length - 1];
            ev.emit("messaging-history.set", { ...last, chats: held.flatMap(c => c.chats), messages: held.flatMap(c => c.messages) });
          }, holdMs);
        }
        for (const chunk of chunks) {
          setTimeout(() => {
            const { afterMs: _a, status, chats, ...set } = chunk;
            const full = { chats: chats ?? [...new Set(set.messages.map(m => m.key.remoteJid))].map(id => ({ id })), ...set };
            if (keep({ syncType: set.syncType })) {
              if (holding) held.push(full);
              else ev.emit("messaging-history.set", full);
            }
            if (status) ev.emit("messaging-history.status", { syncType: set.syncType, status, explicit: true });
          }, chunk.afterMs ?? 0);
        }
      });
      return sock;
    },
  };
}

/** fabrik's calls, for one person who owns `scopes`: { url, files, close }. files maps "bucket/path" to text. */
export async function standInFabrik({ actorId = "11111111-1111-1111-1111-111111111111", scopes = [{ code: "me_private", display_name: "My notes", is_private: true }] } = {}) {
  const files = new Map();
  const uploads = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, "http://x");
      const json = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.headers.authorization !== "Bearer token-1") return json(401, { message: "Invalid JWT" });
      if (url.pathname === "/rest/v1/rpc/fabrik_get_actor") return json(200, { actor_id: actorId, display_name: "Pat" });
      if (url.pathname === "/rest/v1/rpc/fabrik_get_scopes")
        return json(200, { items: [{ code: "general", display_name: "General", is_private: false, owner_actor_id: null }, ...scopes.map(s => ({ owner_actor_id: actorId, enabled: true, ...s }))], next_cursor: null });
      const got = /^\/storage\/v1\/object\/authenticated\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (req.method === "GET" && got) {
        const key = `${got[1]}/${decodeURIComponent(got[2])}`;
        if (!files.has(key)) return json(400, { statusCode: "404", error: "not_found", message: "Object not found" });
        res.writeHead(200, { "Content-Type": "text/markdown" });
        return res.end(files.get(key));
      }
      const put = /^\/storage\/v1\/object\/([^/]+)\/(.+)$/.exec(url.pathname);
      if (req.method === "POST" && put) {
        const key = `${put[1]}/${put[2].split("/").map(decodeURIComponent).join("/")}`;
        if (files.has(key) && req.headers["x-upsert"] !== "true") return json(400, { message: "The resource already exists" });
        files.set(key, body.toString("utf8"));
        uploads.push({ key, type: req.headers["content-type"] });
        return json(200, { Key: key });
      }
      json(404, { message: `No stand-in for ${req.method} ${url.pathname}` });
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, files, uploads, close: () => new Promise(r => server.close(r)) };
}

/** A saved fabrik sign-in under `home`, good for an hour, for the stand-in at `url`. */
export function savedSignIn(home, url, { ref = "abcdefghijklmnopqrst", email = "pat@example.com" } = {}) {
  const dir = join(home, ".config", "supabase-auth", ref);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${email}.json`), JSON.stringify({ version: 1, url, publishableKey: "pk", email, refreshToken: "r1", accessToken: "token-1", expiresAt: Date.now() + 3600_000 }), { mode: 0o600 });
  return { ref, email };
}

// A WhatsApp message as Baileys hands it over.
export const dm = (id, text, { from = "Kate", jid = "447111000111@s.whatsapp.net", fromMe = false, at = 1795000000 } = {}) =>
  ({ key: { id, remoteJid: jid, fromMe }, message: { conversation: text }, pushName: fromMe ? "Pat" : from, messageTimestamp: at });
