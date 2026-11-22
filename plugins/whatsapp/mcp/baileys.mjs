// One short WhatsApp connection, lifted from maxy-lite's channels/whatsapp/baileys.mjs (pullWhatsApp).
//
// It never holds a socket open: an open one was dropped with code 428 about every 57 seconds and lost messages. Each
// check connects with the saved keys, takes what WhatsApp queued since the last connection, and disconnects once Baileys
// says the queue is delivered (receivedPendingNotifications) and no message has come for a few seconds.
// WhatsApp clears its queue once this device has it.
//
// Pairing is folded in. With `pair` set and the account not linked, the first `qr` signal asks Baileys for an
// 8-character code for the person's number. The code goes to onPairingCode, and the deadline widens so the person can
// type it on their phone. The QR image is never drawn. Once the phone accepts the code, WhatsApp closes the connection
// and asks for a new one. That ends the link here, and the next check connects with the new keys.
//
// Recent history is folded in too. When the person chose it at linking, the connection also listens to
// messaging-history.set, the batch of recent chats the phone sends a new device, and hands each message of the two
// recent sync types to onMessage, as it does a new one. With `waitHistory` set, the connection stays open after the
// queue is drained, until Baileys says the recent sync is complete or no chunk has come for `historyQuietMs`.
//
// It only reads. It connects with markOnlineOnConnect false, so it never shows the person online or sends read
// receipts. It calls nothing that sends a message, a receipt or a presence. Media is noted, never downloaded.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// One whitespace-free token, so a thrown value stays a single k=v field.
const oneToken = e => String((e && e.message) || e || "none").replace(/\s+/g, "_").slice(0, 160);

// Baileys logs through a pino-style logger, to stdout by default, which is this server's JSON-RPC channel.
const SILENT = { level: "silent", child: () => SILENT, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(ROOT, "node_modules", "@whiskeysockets", "baileys", "lib", "index.js");

/** Installs the plugin's packages from its lockfile, beside the plugin. Claude Code does this itself when it copies a
 * plugin from a marketplace into its cache; a plugin loaded in place from a folder, or an older Claude Code, skips it. */
export function installPackages(root = ROOT) {
  return new Promise((resolve, reject) => {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    execFile(npm, ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: root, timeout: 180_000, shell: process.platform === "win32" },
      (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().split("\n").slice(-3).join(" "))) : resolve()));
  });
}

let loaded = null;
/** Baileys itself, loaded on first use, so the server starts, and answers status and unlink, without it. When it
 * isn't beside the plugin, it is installed once from the plugin's lockfile, and loaded again. */
export async function loadBaileys({ root = ROOT, entry = ENTRY, install = installPackages } = {}) {
  if (!loaded) {
    loaded = (async () => {
      if (!existsSync(entry)) {
        try { await install(root); }
        catch (err) {
          throw new Error(`Baileys, the WhatsApp library this plugin uses, isn't installed, and installing it failed: ${oneToken(err)}. `
            + `In a Terminal, run: cd '${root.replaceAll("'", "'\\''")}' && npm ci --omit=dev --ignore-scripts`);
        }
      }
      return await import(pathToFileURL(entry).href);
    })().catch(err => { loaded = null; throw err; });
  }
  return loaded;
}

/** The history sync types kept: INITIAL_BOOTSTRAP (0) and RECENT (3), as Baileys' proto.HistorySync.HistorySyncType
 * numbers them. FULL (2) and ON_DEMAND (6) are left alone. */
export const HISTORY_TYPES = new Map([[0, "initial"], [3, "recent"]]);
const RECENT = 3;

/** Whether the keys belong to a linked device, and its number: { linked, number }. Only a finished pairing writes
 * `account`. Asking for a code writes `me` alone, so keys with `me` and no `account` are a link that never finished. */
export function linkedState(creds) {
  const id = creds?.me?.id;
  if (!id || !creds?.account) return { linked: false, number: "" };
  return { linked: true, number: String(id).split("@")[0].split(":")[0] };
}

/** Whether the keys hold a link that never finished, such as a code that was never typed. */
export const halfLinked = creds => !!creds && !linkedState(creds).linked && !!(creds.me || creds.pairingCode);

/**
 * One connection that drains WhatsApp's offline queue and disconnects.
 *
 * Hands each `notify` and `append` upsert entry to onMessage(waMessage). With `history`, it also hands each message of a
 * kept history sync type to onMessage(waMessage, { history: syncType }). After the drain, and before the socket is torn
 * down, awaits afterDrain(sock), which can read group names or remove the link. Always tears the socket down.
 *
 * Resolves { count, received, history, msToOpen, reason, linked }: `count` is the queue WhatsApp announced, `received`
 * the entries handed on, `history` the chats and messages history brought per sync type, and `reason` null on a clean
 * drain, else "connect-timeout", "drain-timeout", "not-linked",
 * "logged-out", "closed" or, for a pairing the phone accepted, "linked".
 */
export async function pullWhatsApp({
  authDir, log = () => {}, selfNumber = "", pair = false, onMessage = () => {}, onPairingCode = () => {}, afterDrain = null,
  history = false, waitHistory = false, historyQuietMs = 180000,
  baileys = null, connectTimeoutMs = 20000, linkTimeoutMs = 180000, drainTimeoutMs = 30000, quietMs = 3000, now = () => Date.now(),
}) {
  const b = baileys ?? await loadBaileys();
  const { state, saveCreds } = await b.useMultiFileAuthState(authDir);
  const { version } = await b.fetchLatestBaileysVersion();
  const startAt = now();
  let sock = null;
  let count = 0;
  let received = 0;
  let msToOpen = 0;
  let opened = false;
  let requestedPairing = false;
  let paired = false;
  // The keys saved so far: a run ends only once they are on disk, so the next connection finds them.
  let saving = Promise.resolve();
  // When WhatsApp last sent a message frame, or Baileys last handed one over.
  let lastActivity = now();
  // The history taken, per sync type: { initial: { chats, messages }, recent: { chats, messages } }.
  const tally = {};
  // When the last kept history chunk came, and whether Baileys said the recent sync is over.
  let lastChunk = null;
  let historyDone = false;

  return await new Promise(resolve => {
    let settled = false;
    let deadline = null;
    let draining = false;
    let quiet = null;
    const finish = reason => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (quiet) clearInterval(quiet);
      try {
        sock?.ev?.removeAllListeners();
        sock?.ws?.removeAllListeners?.();
        sock?.end?.(new Error("pull-done"));
      } catch { /* already gone */ }
      saving.finally(() => resolve({ count, received, history: tally, msToOpen, reason: reason ?? null, linked: linkedState(state.creds).linked }));
    };
    const arm = (ms, reason) => {
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => finish(reason), ms);
    };
    arm(connectTimeoutMs, "connect-timeout");

    try {
      sock = b.makeWASocket({
        version, auth: state, browser: b.Browsers.appropriate("Chrome"), logger: SILENT,
        markOnlineOnConnect: false, syncFullHistory: false,
      });

      sock.ev.on("creds.update", () => {
        saving = saving.then(saveCreds).catch(err => log("creds-save-error", { err: oneToken(err) }));
      });

      // The announced queue, read from the protocol's <offline count='N'/> node.
      // Baileys decrypts the queue's messages one by one after WhatsApp says the queue is delivered, and it tells
      // WhatsApp each one arrived before it hands it over. So the run waits until messages stop coming.
      sock.ws.on("CB:message", () => { lastActivity = now(); });

      sock.ws.on("CB:ib,,offline", node => {
        count = +(b.getBinaryNodeChild(node, "offline")?.attrs?.count || 0);
        log("pull-offline", { count });
      });

      sock.ev.on("connection.update", u => {
        const { connection, qr, receivedPendingNotifications, isNewLogin } = u;
        if (qr && !requestedPairing) {
          requestedPairing = true;
          if (!pair) { log("pull-not-linked", {}); return finish("not-linked"); }
          if (!selfNumber) { log("pairing-error", { reason: "no-number" }); return finish("not-linked"); }
          sock.requestPairingCode(selfNumber)
            .then(code => { log("pairing-code", { codeLen: code.length }); onPairingCode(code); })
            .catch(err => { log("pairing-error", { reason: "request-failed", error: oneToken(err) }); finish("closed"); });
          arm(linkTimeoutMs, "connect-timeout");
        }
        if (isNewLogin) paired = true;
        if (connection === "open" && !opened) {
          opened = true;
          msToOpen = now() - startAt;
          log("pull-connected", { msToOpen });
          arm(drainTimeoutMs, "drain-timeout");
        }
        if (connection === "close") {
          const code = u.lastDisconnect?.error?.output?.statusCode;
          log("pull-closed", { code: code ?? "none" });
          if (paired || (requestedPairing && linkedState(state.creds).linked)) return finish("linked");
          return finish(code === 401 ? "logged-out" : "closed");
        }
        if (receivedPendingNotifications && !draining) {
          draining = true;
          const drainAt = now();
          arm(waitHistory ? historyQuietMs + drainTimeoutMs : drainTimeoutMs, "drain-timeout");
          lastActivity = now();
          quiet = setInterval(() => {
            if (now() - lastActivity < quietMs) return;
            // Linking with history waits for the phone's last chunk: Baileys' word, or no chunk for historyQuietMs.
            if (waitHistory && !historyDone && now() - (lastChunk ?? drainAt) < historyQuietMs) return;
            clearInterval(quiet);
            quiet = null;
            log("pull-quiet", { quietMs, ...(waitHistory ? { historyDone } : {}) });
            Promise.resolve()
              .then(() => (afterDrain ? afterDrain(sock) : undefined))
              .catch(err => log("after-drain-error", { err: oneToken(err) }))
              .then(() => finish(null));
          }, Math.max(10, Math.min(250, quietMs / 4)));
        }
      });

      if (history) {
        sock.ev.on("messaging-history.set", ({ messages = [], chats = [], syncType, progress, chunkOrder }) => {
          lastActivity = now();
          const kind = HISTORY_TYPES.get(syncType);
          if (!kind) { log("history-skipped", { syncType: syncType ?? "none", messages: messages.length }); return; }
          lastChunk = now();
          if (waitHistory && draining) arm(historyQuietMs + drainTimeoutMs, "drain-timeout");
          const t = (tally[kind] ??= { chats: 0, messages: 0 });
          t.chats += chats.length;
          t.messages += messages.length;
          log("history-chunk", { syncType: kind, chunkOrder: chunkOrder ?? "none", progress: progress ?? "none", chats: chats.length, messages: messages.length });
          for (const m of messages) {
            received += 1;
            try { onMessage(m, { history: syncType }); } catch (err) { log("message-error", { err: oneToken(err) }); }
          }
          if (syncType === RECENT && progress === 100) historyDone = true;
        });
        sock.ev.on("messaging-history.status", ({ syncType, status }) => {
          log("history-status", { syncType: HISTORY_TYPES.get(syncType) ?? syncType, status });
          if (syncType === RECENT) historyDone = true;
        });
      }

      sock.ev.on("messages.upsert", ({ messages, type }) => {
        if (type !== "notify" && type !== "append") return;
        lastActivity = now();
        for (const m of messages) {
          received += 1;
          try { onMessage(m); } catch (err) { log("message-error", { err: oneToken(err) }); }
        }
      });
    } catch (err) {
      log("wa-connect-error", { err: oneToken(err) });
      finish("connect-timeout");
    }
  });
}
