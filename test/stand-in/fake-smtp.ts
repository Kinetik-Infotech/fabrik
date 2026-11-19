// A fake SMTP server for the stand-in's mail step: implicit TLS on a free port, with the certificate the step made, and
// one user with one password. With starttls, it starts in plain text, upgrades after STARTTLS (RFC 3207) and refuses
// AUTH before it. It answers what nodemailer sends, from RFC 5321 and RFC 4954. That is EHLO, advertising AUTH PLAIN
// LOGIN, then AUTH PLAIN and AUTH LOGIN, MAIL FROM, RCPT TO, DATA, RSET, NOOP and QUIT.
//
// Any other user or password gets 535. It records each message's envelope and the bytes sent after DATA, with the leading dots RFC 5321 4.5.2
// adds taken out. It records every command too, AUTH's credentials left out, and marks those sent after a STARTTLS
// "(TLS)". Deno can't start TLS as a server, so the STARTTLS server is Node's net and tls.
import { Buffer } from "node:buffer";
import net from "node:net";
import tls from "node:tls";

export type Sent = { from: string; to: string[]; data: string };
export type FakeSmtp = {
  port: number; sent: Sent[]; commands: string[]; connections: () => number;
  /** Resolves once no connection is open, or with false after the milliseconds given. */
  idle: (ms: number) => Promise<boolean>;
  close: () => Promise<void>;
};

/** A connection as serve() uses it, over Deno's or Node's sockets. */
type Channel = { read: () => Promise<Uint8Array | null>; write: (bytes: Uint8Array) => Promise<void>; close: () => void; startTls?: (reply: Uint8Array) => void };

function denoChannel(conn: Deno.Conn): Channel {
  const reader = conn.readable.getReader();
  return {
    read: async () => { const { value, done } = await reader.read(); return done ? null : value; },
    write: async (bytes) => { for (let at = 0; at < bytes.length;) at += await conn.write(bytes.subarray(at)); },
    close: () => { try { conn.close(); } catch { /* already closed */ } },
  };
}

function nodeChannel(socket: net.Socket, cert: string, key: string): Channel {
  let current: net.Socket = socket;
  const chunks: Uint8Array[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  const onData = (c: Buffer) => { chunks.push(c); wake?.(); };
  const onEnd = () => { ended = true; wake?.(); };
  const attach = (s: net.Socket) => { s.on("data", onData); s.on("end", onEnd); s.on("close", onEnd); s.on("error", onEnd); };
  attach(socket);
  return {
    read: async () => {
      while (!chunks.length && !ended) await new Promise<void>((r) => wake = r);
      return chunks.shift() ?? null;
    },
    write: (bytes) => new Promise((r) => current.write(bytes, () => r())),
    close: () => current.destroy(),
    // The reply is written once the plain socket stops reading, so the client's TLS handshake goes to the TLS socket.
    startTls: (reply) => {
      for (const [event, fn] of [["data", onData], ["end", onEnd], ["close", onEnd], ["error", onEnd]] as const) socket.removeListener(event, fn);
      socket.pause();
      socket.write(reply);
      current = new tls.TLSSocket(socket, { isServer: true, cert, key });
      attach(current);
    },
  };
}

const CRLF = "\r\n";

/** onData, when given, runs as each message's bytes arrive, before the server answers that it took them. */
export async function startFakeSmtp(o: { cert: string; key: string; user: string; password: string; onData?: () => void; starttls?: boolean }): Promise<FakeSmtp> {
  const sent: Sent[] = [];
  const commands: string[] = [];
  const open = new Set<Channel>();
  let connections = 0;
  const waiting = new Set<() => void>();

  async function serve(conn: Channel) {
    const write = async (s: string) => {
      try { await conn.write(Buffer.from(s, "latin1")); } catch { /* the client left */ }
    };
    let buffer = Buffer.alloc(0);
    const line = async (): Promise<string | null> => {
      for (;;) {
        const at = buffer.indexOf(CRLF);
        if (at >= 0) { const s = buffer.subarray(0, at).toString("latin1"); buffer = buffer.subarray(at + 2); return s; }
        const value = await conn.read();
        if (value === null) return null;
        buffer = Buffer.concat([buffer, value]);
      }
    };
    let secure = !o.starttls;
    let authed = false;
    let from: string | null = null;
    let to: string[] = [];
    const credentials = (user: string, pass: string) => user === o.user && pass === o.password;
    await write(`220 stand-in ESMTP ready${CRLF}`);
    for (;;) {
      const text = await line();
      if (text === null) break;
      const verb = text.split(" ")[0].toUpperCase();
      const shown = verb === "AUTH" ? `AUTH ${text.split(" ")[1] ?? ""} (credentials left out)` : text;
      commands.push(o.starttls && secure ? `${shown} (TLS)` : shown);
      if (verb === "EHLO" || verb === "HELO") {
        await write(`250-stand-in${CRLF}${secure ? "" : `250-STARTTLS${CRLF}`}250-AUTH PLAIN LOGIN${CRLF}250-8BITMIME${CRLF}250 SMTPUTF8${CRLF}`);
        continue;
      }
      if (verb === "STARTTLS" && !secure && conn.startTls) {
        if (buffer.length) { await write(`501 Nothing may follow STARTTLS${CRLF}`); break; }
        conn.startTls(Buffer.from(`220 Ready to start TLS${CRLF}`, "latin1"));
        secure = true;
        continue;
      }
      if (!secure && verb !== "QUIT" && verb !== "NOOP" && verb !== "RSET") { await write(`530 5.7.0 Must issue a STARTTLS command first${CRLF}`); continue; }
      if (verb === "NOOP") { await write(`250 OK${CRLF}`); continue; }
      if (verb === "QUIT") { await write(`221 Bye${CRLF}`); break; }
      if (verb === "RSET") { from = null; to = []; await write(`250 OK${CRLF}`); continue; }
      if (verb === "AUTH") {
        const [, mech, initial] = text.split(" ");
        if (mech?.toUpperCase() === "PLAIN") {
          let given = initial;
          if (!given) { await write(`334 ${CRLF}`); given = (await line()) ?? ""; }
          const [, user, pass] = Buffer.from(given, "base64").toString("utf8").split("\u0000");
          authed = credentials(user ?? "", pass ?? "");
        } else if (mech?.toUpperCase() === "LOGIN") {
          await write(`334 ${Buffer.from("Username:").toString("base64")}${CRLF}`);
          const user = Buffer.from((await line()) ?? "", "base64").toString("utf8");
          await write(`334 ${Buffer.from("Password:").toString("base64")}${CRLF}`);
          const pass = Buffer.from((await line()) ?? "", "base64").toString("utf8");
          authed = credentials(user, pass);
        } else { await write(`504 Unrecognized authentication type${CRLF}`); continue; }
        await write(authed ? `235 Authentication successful${CRLF}` : `535 5.7.8 Authentication credentials invalid${CRLF}`);
        continue;
      }
      if (!authed) { await write(`530 5.7.0 Authentication required${CRLF}`); continue; }
      if (verb === "MAIL") { from = /<([^>]*)>/.exec(text)?.[1] ?? ""; to = []; await write(`250 OK${CRLF}`); continue; }
      if (verb === "RCPT") { to.push(/<([^>]*)>/.exec(text)?.[1] ?? ""); await write(`250 OK${CRLF}`); continue; }
      if (verb === "DATA") {
        if (from === null || !to.length) { await write(`503 Need MAIL and RCPT first${CRLF}`); continue; }
        await write(`354 End data with <CR><LF>.<CR><LF>${CRLF}`);
        const lines: string[] = [];
        for (;;) {
          const l = await line();
          if (l === null) return;
          if (l === ".") break;
          lines.push(l.startsWith(".") ? l.slice(1) : l);
        }
        sent.push({ from, to, data: lines.join(CRLF) + CRLF });
        o.onData?.();
        from = null; to = [];
        await write(`250 OK queued${CRLF}`);
        continue;
      }
      await write(`502 Command not implemented${CRLF}`);
    }
    try { conn.close(); } catch { /* already closed */ }
  }
  const accept = (conn: Channel) => { connections++; open.add(conn); serve(conn).catch(() => {}).finally(() => { open.delete(conn); if (!open.size) for (const w of waiting) w(); }); };

  // On 127.0.0.1, and on ::1 at the same port where the computer has it, as the fake IMAP server listens.
  let port: number;
  let closeListeners: () => void;
  if (o.starttls) {
    const servers = [net.createServer((s) => accept(nodeChannel(s, o.cert, o.key)))];
    const listening = (server: net.Server, host: string, at: number) => new Promise<number>((ok, no) => {
      server.once("error", no);
      server.listen(at, host, () => ok((server.address() as net.AddressInfo).port));
    });
    port = await listening(servers[0], "127.0.0.1", 0);
    const v6 = net.createServer((s) => accept(nodeChannel(s, o.cert, o.key)));
    try { await listening(v6, "::1", port); servers.push(v6); } catch { /* 127.0.0.1 alone */ }
    closeListeners = () => { for (const s of servers) s.close(); };
  } else {
    const listener = Deno.listenTls({ hostname: "127.0.0.1", port: 0, cert: o.cert, key: o.key });
    port = (listener.addr as Deno.NetAddr).port;
    const listeners: Deno.TlsListener[] = [listener];
    try { listeners.push(Deno.listenTls({ hostname: "::1", port, cert: o.cert, key: o.key })); }
    catch { /* 127.0.0.1 alone */ }
    for (const l of listeners) {
      (async () => { for await (const conn of l) accept(denoChannel(conn)); })().catch(() => {});
    }
    closeListeners = () => { for (const l of listeners) { try { l.close(); } catch { /* closed */ } } };
  }

  return {
    port, sent, commands, connections: () => connections,
    idle: (ms) => open.size === 0 ? Promise.resolve(true) : new Promise((resolve) => {
      const done = (v: boolean) => { waiting.delete(woken); clearTimeout(timer); resolve(v); };
      const woken = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      waiting.add(woken);
    }),
    close: async () => {
      closeListeners();
      for (const c of open) { try { c.close(); } catch { /* closed */ } }
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}
