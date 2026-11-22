// One short WhatsApp connection, lifted from maxy-lite's channels/whatsapp/baileys.mjs (pullWhatsApp).
//
// It never holds a socket open: an open one was dropped with code 428 about every 57 seconds and lost messages. Each
// check connects with the saved keys, takes what WhatsApp queued since the last connection, and disconnects once Baileys
// says the queue is delivered (receivedPendingNotifications). WhatsApp clears its queue once this device has it.
//
// Pairing is folded in. With `pair` set and the account not linked, the first `qr` signal asks Baileys for an
// 8-character code for the person's number. The code goes to onPairingCode, and the deadline widens so the person can
// type it on their phone. The QR image is never drawn. Once the phone accepts the code, WhatsApp closes the connection
// and asks for a new one. That ends the link here, and the next check connects with the new keys.
//
// It only reads. It connects with markOnlineOnConnect false, so it never shows the person online or sends read
// receipts. It calls nothing that sends a message, a receipt or a presence. Media is noted, never downloaded.

// One whitespace-free token, so a thrown value stays a single k=v field.
const oneToken = e => String((e && e.message) || e || "none").replace(/\s+/g, "_").slice(0, 160);

// Baileys logs through a pino-style logger, to stdout by default, which is this server's JSON-RPC channel.
const SILENT = { level: "silent", child: () => SILENT, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };

let loaded = null;
/** Baileys itself, loaded on first use, so the server starts, and answers status and unlink, without it. */
export async function loadBaileys() {
  if (!loaded) {
    loaded = import("@whiskeysockets/baileys").catch(err => {
      loaded = null;
      throw new Error(`Baileys, the WhatsApp library this plugin uses, isn't installed beside the plugin (${oneToken(err)}). Reinstall the plugin with: claude plugin install whatsapp@fabrik`);
    });
  }
  return loaded;
}

/** Whether the keys under authDir belong to a linked device, and its number: { linked, number }. */
export function linkedState(creds) {
  const id = creds?.me?.id;
  if (!id || creds?.registered === false) return { linked: false, number: "" };
  return { linked: true, number: String(id).split("@")[0].split(":")[0] };
}

/**
 * One connection that drains WhatsApp's offline queue and disconnects.
 *
 * Hands each `notify` and `append` upsert entry to onMessage(waMessage). After the drain, and before the socket is torn
 * down, awaits afterDrain(sock), which can read group names or remove the link. Always tears the socket down.
 *
 * Resolves { count, received, msToOpen, reason, linked }: `count` is the queue WhatsApp announced, `received` the
 * entries handed on, and `reason` null on a clean drain, else "connect-timeout", "drain-timeout", "not-linked",
 * "logged-out", "closed" or, for a pairing the phone accepted, "linked".
 */
export async function pullWhatsApp({
  authDir, log = () => {}, selfNumber = "", pair = false, onMessage = () => {}, onPairingCode = () => {}, afterDrain = null,
  baileys = null, connectTimeoutMs = 20000, linkTimeoutMs = 180000, drainTimeoutMs = 30000, now = () => Date.now(),
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

  return await new Promise(resolve => {
    let settled = false;
    let deadline = null;
    let draining = false;
    const finish = reason => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      try {
        sock?.ev?.removeAllListeners();
        sock?.ws?.removeAllListeners?.();
        sock?.end?.(new Error("pull-done"));
      } catch { /* already gone */ }
      saving.finally(() => resolve({ count, received, msToOpen, reason: reason ?? null, linked: linkedState(state.creds).linked }));
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
          arm(drainTimeoutMs, "drain-timeout");
          Promise.resolve()
            .then(() => (afterDrain ? afterDrain(sock) : undefined))
            .catch(err => log("after-drain-error", { err: oneToken(err) }))
            .then(() => finish(null));
        }
      });

      sock.ev.on("messages.upsert", ({ messages, type }) => {
        if (type !== "notify" && type !== "append") return;
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
