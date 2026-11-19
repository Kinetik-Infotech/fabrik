// A fake IMAP server for the stand-in's mail step: implicit TLS on a free port, with the certificate the step made, and
// one user with one password. It answers, from RFC 3501, what imapflow sends to read mail: CAPABILITY, LOGIN (any other
// user or password gets NO [AUTHENTICATIONFAILED]), LIST and LSUB (INBOX, and each folder with its special use, such as
// Sent marked \Sent), EXAMINE and SELECT, UID SEARCH (HEADER among its keys), UID FETCH (UID, FLAGS, ENVELOPE,
// BODYSTRUCTURE, INTERNALDATE, RFC822.SIZE, BODY[...] and BODY.PEEK[...] with a part, MIME, HEADER, HEADER.FIELDS or
// TEXT and a <start.length>), NOOP, CLOSE and LOGOUT. To draft and move mail it answers APPEND, with APPENDUID from
// UIDPLUS (RFC 4315), STORE, EXPUNGE and UID EXPUNGE, and UID MOVE (RFC 6851), as far as caps, the capabilities it gives,
// name UIDPLUS and MOVE. A folder can leave out its
// UIDVALIDITY, and a part can report a smaller size than it sends, as a broken or hostile server may. Anything else is
// recorded and answered BAD. Each message is made from a few fields, or a tree of parts (multiparts, forwarded
// messages, base64, quoted-printable and other charsets), and its source and its BODYSTRUCTURE are both made from them.
// It records every command it receives, LOGIN's password left out, and each connection, so the step can check what a
// client did.
import { Buffer } from "node:buffer";
import { simpleParser } from "npm:mailparser@3.9.12";

/** One part. Its body is text, sent in UTF-8, or in charset when given (iso-8859-1 is sent as one byte each), with
 * the transfer encoding given (7bit or 8bit when none). message makes it a forwarded message/rfc822, whose body is
 * that message. reportedSize, when given, is the size BODYSTRUCTURE gives for the part, whatever its body's own: a
 * server that under-reports. */
export type Part = {
  type: string; subtype: string; body: string; filename?: string; base64?: boolean; encoding?: "base64" | "quoted-printable";
  charset?: string; reportedSize?: number; message?: Message;
};
export type Multipart = { multipart: "mixed" | "alternative" | "related"; parts: Node[] };
export type Node = Part | Multipart;
/** A message is its text, as one text/plain part, with any attachments after it in a multipart/mixed; or tree, when
 * given, as its whole body. */
export type Message = {
  uid: number; from: [string, string]; to: [string, string]; subject: string; date: Date; messageId: string;
  text: string; textBase64?: boolean; attachments?: Part[]; tree?: Node; flags?: string[];
  /** Copied to, and the References header's Message-IDs, as a reply to the message reads them. */
  cc?: [string, string][]; references?: string;
  /** Found by SEARCH and counted in the sequence, but left out of every FETCH, as a message another client expunged
   * between the two. */
  gone?: boolean;
  /** The message's bytes as a client appended them, one character each: BODY[] gives these, while its structure and
   * envelope come from the fields above, read from them. */
  raw?: string;
};
/** A folder with no uidValidity is opened with no UIDVALIDITY line, as a broken server may. */
export type Folder = { name: string; specialUse?: string; uidValidity?: number; messages: Message[] };
export type Received = { connection: number; tag: string; command: string; line: string };

const CRLF = "\r\n";
const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
/** A folder name as IMAP carries it, in modified UTF-7 (RFC 3501 5.1.3): printable ASCII as it is, & as &-, and each
 * run of other characters as & and the base64 of its UTF-16, with , for / and no padding, then -. */
const mutf7 = (name: string) => name.replace(/&/g, "\u0000").replace(/[^\x20-\x7e\u0000]+/g, (run) => {
  const bytes = new Uint8Array(run.length * 2);
  for (let i = 0; i < run.length; i++) { bytes[2 * i] = run.charCodeAt(i) >> 8; bytes[2 * i + 1] = run.charCodeAt(i) & 255; }
  return `&${Buffer.from(bytes).toString("base64").replace(/=+$/, "").replace(/\//g, ",")}-`;
}).replace(/\u0000/g, "&-");
/** Text as a header carries it: as it is when ASCII, else as an RFC 2047 encoded word. */
const word = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString("base64")}?=`;
const nstring = (s: string | undefined | null) => s == null || s === "" ? "NIL" : quote(word(s));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const two = (n: number) => String(n).padStart(2, "0");
const rfc5322Date = (d: Date) =>
  `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;
const internalDate = (d: Date) =>
  `"${two(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000"`;

// Every part, header and source below is held as bytes, one character each (latin1), as the server sends them.

/** Bytes as quoted-printable, lines of at most 76. */
function qp(bytes: string): string {
  return bytes.split(CRLF).map((l) => {
    let out = "";
    for (let i = 0; i < l.length; i++) {
      const c = l.charCodeAt(i);
      const keep = (c >= 33 && c <= 126 && c !== 61) || ((c === 32 || c === 9) && i < l.length - 1);
      out += keep ? l[i] : `=${c.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return out.replace(/(.{73}[^=]{0,2})(?=.)/g, `$1=${CRLF}`);
  }).join(CRLF);
}

/** A message's parts as the server holds them, by part number: each one's MIME header and body as sent. */
type Built = { source: string; parts: Map<string, { mime: string; body: string }>; header: string; text: string; structure: string };
type Rendered = { mime: string; body: string; structure: string };
const lines = (s: string) => s.split(CRLF).length - (s.endsWith(CRLF) ? 1 : 0);

function render(node: Node, num: string, parts: Built["parts"]): Rendered {
  if ("multipart" in node) {
    const boundary = `stand-in-${num || "0"}`;
    const children = node.parts.map((c, i) => render(c, num ? `${num}.${i + 1}` : String(i + 1), parts));
    const body = children.map((c) => `--${boundary}${CRLF}${c.mime}${c.body}${CRLF}`).join("") + `--${boundary}--${CRLF}`;
    const done = { mime: `Content-Type: multipart/${node.multipart}; boundary="${boundary}"${CRLF}${CRLF}`, body,
      structure: `(${children.map((c) => c.structure).join(" ")} ${quote(node.multipart.toUpperCase())} ("BOUNDARY" ${quote(boundary)}) NIL NIL NIL)` };
    if (num) parts.set(num, done);
    return done;
  }
  const p = node;
  const inner = p.message ? build(p.message) : null;
  const charset = p.charset ?? "utf-8";
  const bytes = inner ? inner.source
    : Buffer.from(p.body.replace(/\r?\n/g, CRLF), /^(iso-8859-1|latin1)$/i.test(charset) ? "latin1" : "utf8").toString("latin1");
  const encoding = p.base64 || p.encoding === "base64" ? "BASE64" : p.encoding === "quoted-printable" ? "QUOTED-PRINTABLE"
    : /^[\x00-\x7f]*$/.test(bytes) ? "7BIT" : "8BIT";
  const body = encoding === "BASE64" ? Buffer.from(bytes, "latin1").toString("base64").replace(/.{76}/g, `$&${CRLF}`) + CRLF
    : encoding === "QUOTED-PRINTABLE" ? qp(bytes) : bytes;
  const isText = p.type === "text";
  const name = p.filename ? word(p.filename) : undefined;
  const params = [...(isText ? [`"CHARSET" ${quote(charset)}`] : []), ...(name ? [`"NAME" ${quote(name)}`] : [])];
  const mime = [
    `Content-Type: ${p.type}/${p.subtype}${isText ? `; charset=${charset}` : ""}${name ? `; name="${name}"` : ""}`,
    `Content-Transfer-Encoding: ${encoding.toLowerCase()}`,
    ...(name ? [`Content-Disposition: attachment; filename="${name}"`] : []),
  ].join(CRLF) + CRLF + CRLF;
  const disposition = name ? `("ATTACHMENT" ("FILENAME" ${quote(name)}))` : "NIL";
  const size = p.reportedSize ?? body.length;
  const fields = `${quote(p.type.toUpperCase())} ${quote(p.subtype.toUpperCase())} ${params.length ? `(${params.join(" ")})` : "NIL"} NIL NIL ${quote(encoding)} ${size}`;
  // A forwarded message also gives its envelope, its own structure and its lines, as RFC 3501 has body-type-msg.
  const structure = inner ? `(${fields} ${envelope(p.message!)} ${inner.structure} ${lines(body)} NIL ${disposition} NIL NIL)`
    : `(${fields}${isText ? ` ${lines(body)}` : ""} NIL ${disposition} NIL NIL)`;
  const done = { mime, body, structure };
  parts.set(num || "1", done);
  return done;
}

function build(m: Message): Built {
  const header = [
    `From: ${word(m.from[0])} <${m.from[1]}>`, `To: ${word(m.to[0])} <${m.to[1]}>`, `Subject: ${word(m.subject)}`,
    `Date: ${rfc5322Date(m.date)}`, `Message-ID: ${m.messageId}`, "MIME-Version: 1.0",
    ...(m.cc?.length ? [`Cc: ${m.cc.map(([n, a]) => `${word(n)} <${a}>`).join(", ")}`] : []),
    ...(m.references ? [`References: ${m.references}`] : []),
  ];
  const text: Part = { type: "text", subtype: "plain", body: m.text, base64: m.textBase64 };
  const root: Node = m.tree ?? (m.attachments?.length ? { multipart: "mixed", parts: [text, ...m.attachments] } : text);
  const parts: Built["parts"] = new Map();
  const r = render(root, "", parts);
  const head = [...header, ...r.mime.trimEnd().split(CRLF)].join(CRLF) + CRLF + CRLF;
  if (m.raw !== undefined) {
    const end = m.raw.indexOf(CRLF + CRLF);
    const rawHead = end < 0 ? m.raw : m.raw.slice(0, end + 4);
    return { source: m.raw, parts, header: rawHead, text: end < 0 ? "" : m.raw.slice(end + 4), structure: r.structure };
  }
  return { source: head + r.body, parts, header: head, text: r.body, structure: r.structure };
}

const address = ([name, email]: [string, string]) => {
  const [box, host] = email.split("@");
  return `((${nstring(name)} NIL ${quote(box)} ${quote(host)}))`;
};
const addresses = (list: [string, string][] | undefined) => list?.length ? `(${list.map((x) => address(x).slice(1, -1)).join("")})` : "NIL";
const envelope = (m: Message) =>
  `(${quote(rfc5322Date(m.date))} ${nstring(m.subject)} ${address(m.from)} ${address(m.from)} ${address(m.from)} ${address(m.to)} ${addresses(m.cc)} NIL NIL ${quote(m.messageId)})`;

// ---- Reading a command ----

type Token = string | { list: Token[] } | { literal: string };
/** A command's tokens: atoms (with any [section] and <partial> kept whole), quoted strings, literals and lists. */
function tokens(text: string, literals: string[]): Token[] {
  const stack: Token[][] = [[]];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " ") { i++; continue; }
    if (c === "(") { stack.push([]); i++; continue; }
    if (c === ")") { const list = stack.pop()!; stack[stack.length - 1].push({ list }); i++; continue; }
    if (c === '"') {
      let s = ""; i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === "\\") i++; s += text[i++]; }
      i++; stack[stack.length - 1].push({ literal: s }); continue;
    }
    if (c === "\u0000") { stack[stack.length - 1].push({ literal: literals.shift()! }); i++; continue; }
    let atom = "";
    while (i < text.length && !" ()".includes(text[i])) {
      if (text[i] === "[") { const end = text.indexOf("]", i); atom += text.slice(i, end + 1); i = end + 1; continue; }
      atom += text[i++];
    }
    stack[stack.length - 1].push(atom);
  }
  return stack[0];
}
const str = (t: Token | undefined) => t === undefined ? "" : typeof t === "string" ? t : "literal" in t ? t.literal : "";

/** The uids a sequence set names, against the uids there are. */
function inSet(set: string, uids: number[]): number[] {
  const max = uids.length ? Math.max(...uids) : 0;
  const n = (s: string) => s === "*" ? max : Number(s);
  const picked = new Set<number>();
  for (const range of set.split(",")) {
    const [a, b] = range.split(":");
    const [lo, hi] = b === undefined ? [n(a), n(a)] : [Math.min(n(a), n(b)), Math.max(n(a), n(b))];
    for (const u of uids) if (u >= lo && u <= hi) picked.add(u);
  }
  return uids.filter((u) => picked.has(u));
}
const searchDate = (s: string) => {
  const [d, mon, y] = s.split("-");
  return Date.UTC(Number(y), MONTHS.indexOf(mon[0].toUpperCase() + mon.slice(1).toLowerCase()), Number(d));
};
const dayOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** Whether a message meets search keys, each joined by AND, as RFC 3501 6.4.4 has them. */
function meets(m: Message, keys: Token[], seqOf: (m: Message) => number, all: number[]): boolean {
  const built = build(m);
  const has = (hay: string, needle: string) => hay.toLowerCase().includes(needle.toLowerCase());
  let i = 0;
  const one = (): boolean => {
    const t = keys[i++];
    if (typeof t === "object" && "list" in t) return t.list.length === 0 || meetsAll(t.list);
    const k = str(t).toUpperCase();
    switch (k) {
      case "ALL": return true;
      case "NOT": return !one();
      case "OR": { const a = one(), b = one(); return a || b; }
      case "FROM": return has(`${m.from[0]} <${m.from[1]}>`, str(keys[i++]));
      case "TO": return has(`${m.to[0]} <${m.to[1]}>`, str(keys[i++]));
      case "SUBJECT": return has(m.subject, str(keys[i++]));
      case "BODY": return has(built.text, str(keys[i++]));
      case "TEXT": return has(built.source, str(keys[i++]));
      case "SINCE": return dayOf(m.date) >= searchDate(str(keys[i++]));
      case "BEFORE": return dayOf(m.date) < searchDate(str(keys[i++]));
      case "ON": return dayOf(m.date) === searchDate(str(keys[i++]));
      case "SEEN": return (m.flags ?? []).includes("\\Seen");
      case "UNSEEN": return !(m.flags ?? []).includes("\\Seen");
      case "UID": return inSet(str(keys[i++]), all).includes(m.uid);
      case "HEADER": {
        const field = str(keys[i++]).toLowerCase(), value = str(keys[i++]);
        return built.header.split(CRLF).some((l) => l.toLowerCase().startsWith(`${field}:`) && has(l.slice(field.length + 1), value));
      }
      case "DELETED": return (m.flags ?? []).includes("\\Deleted");
      default:
        if (/^[0-9*:,]+$/.test(k)) return inSet(k, all.map((_, j) => j + 1)).includes(seqOf(m));
        throw new Error(`unknown search key ${k}`);
    }
  };
  const meetsAll = (list: Token[]) => meets(m, list, seqOf, all);
  while (i < keys.length) if (!one()) return false;
  return true;
}

/** One FETCH item's answer for a message: its text, and a section's bytes as a literal. */
function fetchItem(item: string, m: Message): { text: string; literal?: string } {
  const built = build(m);
  const upper = item.toUpperCase();
  if (upper === "UID") return { text: `UID ${m.uid}` };
  if (upper === "FLAGS") return { text: `FLAGS (${(m.flags ?? []).join(" ")})` };
  if (upper === "ENVELOPE") return { text: `ENVELOPE ${envelope(m)}` };
  if (upper === "BODYSTRUCTURE" || upper === "BODY") return { text: `${upper} ${built.structure}` };
  if (upper === "INTERNALDATE") return { text: `INTERNALDATE ${internalDate(m.date)}` };
  if (upper === "RFC822.SIZE") return { text: `RFC822.SIZE ${built.source.length}` };
  const section = /^BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)\.(\d+)>)?$/i.exec(item);
  if (!section) throw new Error(`unknown fetch item ${item}`);
  const [, name, start, length] = section;
  const key = name.toUpperCase();
  let content: string;
  if (key === "") content = built.source;
  else if (key === "HEADER") content = built.header;
  else if (key === "TEXT") content = built.text;
  else if (key.startsWith("HEADER.FIELDS (")) {
    // The header's lines whose field is named, each with its folded lines, then the empty line, as RFC 3501 gives them.
    const wanted = key.slice("HEADER.FIELDS (".length, -1).split(" ").map((f) => f.toLowerCase());
    const kept: string[] = [];
    let keeping = false;
    for (const l of built.header.split(CRLF)) {
      if (/^[ \t]/.test(l)) { if (keeping) kept.push(l); continue; }
      keeping = wanted.includes(l.split(":")[0].toLowerCase());
      if (keeping) kept.push(l);
    }
    content = kept.map((l) => l + CRLF).join("") + CRLF;
  }
  else {
    const [, n, mime] = /^([\d.]+?)(\.MIME)?$/.exec(key) ?? [];
    const part = built.parts.get(n);
    if (!part) content = "";
    else content = mime ? part.mime : part.body;
  }
  let bytes = Buffer.from(content, "latin1");
  let origin = "";
  if (start !== undefined) { bytes = bytes.subarray(Number(start), Number(start) + Number(length)); origin = `<${start}>`; }
  return { text: `BODY[${name}]${origin} {${bytes.length}}`, literal: bytes.toString("latin1") };
}

// ---- The server ----

export type FakeImap = {
  port: number;
  /** Whether it listens on ::1 as well as 127.0.0.1. */
  ipv6: boolean;
  /** Every command received, in order, LOGIN's password left out. */
  received: Received[];
  /** How many connections were opened. */
  connections: () => number;
  close: () => Promise<void>;
};

/** A message from the bytes a client appended: its fields read from them by mailparser, its bytes kept. */
async function appended(raw: string, uid: number, flags: string[]): Promise<Message> {
  const parsed = await simpleParser(Buffer.from(raw, "latin1"));
  const one = (x: typeof parsed.to): [string, string] => {
    const v = (Array.isArray(x) ? x : x ? [x] : []).flatMap((g) => g.value)[0];
    return [v?.name ?? "", v?.address ?? "nobody@example.invalid"];
  };
  return {
    uid, from: one(parsed.from), to: one(parsed.to), subject: parsed.subject ?? "", date: parsed.date ?? new Date(),
    messageId: parsed.messageId ?? `<appended-${uid}@stand-in>`, text: parsed.text ?? "", flags, raw,
    attachments: parsed.attachments.map((a) => {
      const [type, subtype] = (a.contentType ?? "application/octet-stream").split("/");
      return { type, subtype, filename: a.filename ?? "attachment", body: a.content.toString("latin1"), base64: true };
    }),
  };
}

/** dropOn, when given, names a command the server answers by closing the connection, as a server that gives up may. */
export function startFakeImap(o: { cert: string; key: string; user: string; password: string; folders: Folder[]; caps?: string; dropOn?: string }): FakeImap {
  // On 127.0.0.1, and on ::1 at the same port where the computer has it, so that "localhost" reaches it whichever
  // family it resolves to first.
  const listener = Deno.listenTls({ hostname: "127.0.0.1", port: 0, cert: o.cert, key: o.key });
  const listeners: Deno.TlsListener[] = [listener];
  let ipv6 = true;
  try { listeners.push(Deno.listenTls({ hostname: "::1", port: (listener.addr as Deno.NetAddr).port, cert: o.cert, key: o.key })); }
  catch (err) {
    ipv6 = false;
    console.log(`# fake IMAP: not listening on ::1 (${(err as Error).name}), so on 127.0.0.1 alone; "localhost" must resolve there`);
  }
  const received: Received[] = [];
  let connections = 0;
  const open = new Set<Deno.Conn>();
  const folderOf = (name: string) => o.folders.find((f) => mutf7(f.name).toUpperCase() === name.toUpperCase());
  // The next uid of each folder, which never goes back, so an expunged message's uid names no later one.
  const nextUid = new Map(o.folders.map((f) => [f, Math.max(0, ...f.messages.map((m) => m.uid)) + 1]));
  const take = (f: Folder) => { const u = nextUid.get(f)!; nextUid.set(f, u + 1); return u; };

  async function serve(conn: Deno.Conn, id: number) {
    // Every byte, since one write may take only part of a large answer.
    const write = async (s: string) => {
      const bytes = Buffer.from(s, "latin1");
      try { for (let at = 0; at < bytes.length;) at += await conn.write(bytes.subarray(at)); } catch { /* the client left */ }
    };
    let buffer = Buffer.alloc(0);
    const reader = conn.readable.getReader();
    /** The next n bytes, or a line, from the connection; null once it closes. */
    const more = async () => {
      const { value, done } = await reader.read();
      if (done) return false;
      buffer = Buffer.concat([buffer, value]);
      return true;
    };
    const line = async (): Promise<string | null> => {
      for (;;) {
        const at = buffer.indexOf(CRLF);
        if (at >= 0) { const s = buffer.subarray(0, at).toString("latin1"); buffer = buffer.subarray(at + 2); return s; }
        if (!await more()) return null;
      }
    };
    const bytes = async (n: number): Promise<string | null> => {
      while (buffer.length < n) if (!await more()) return null;
      const s = buffer.subarray(0, n).toString("utf8"); buffer = buffer.subarray(n); return s;
    };
    let authed = false;
    let selected: Folder | null = null;
    // SPECIAL-USE (RFC 6154), as a server that marks a folder \Sent says: without it imapflow ignores the mark and
    // guesses the Sent folder from its name.
    const CAPS = o.caps ?? "IMAP4rev1 SPECIAL-USE";
    const has = (cap: string) => CAPS.split(" ").includes(cap);
    await write(`* OK [CAPABILITY ${CAPS}] stand-in IMAP ready${CRLF}`);
    for (;;) {
      // A command, with each literal read in after a continuation, its place in the text kept by a NUL.
      let text = await line();
      if (text === null) break;
      const literals: string[] = [];
      for (;;) {
        const lit = /\{(\d+)(\+?)\}$/.exec(text);
        if (!lit) break;
        if (!lit[2]) await write(`+ go ahead${CRLF}`);
        const value = await bytes(Number(lit[1]));
        const rest = await line();
        if (value === null || rest === null) return;
        literals.push(value);
        text = text.slice(0, lit.index) + "\u0000" + rest;
      }
      const all = tokens(text, [...literals]);
      const tag = str(all[0]);
      let name = str(all[1]).toUpperCase();
      let args = all.slice(2);
      let byUid = false;
      if (name === "UID") { byUid = true; name = `UID ${str(args[0]).toUpperCase()}`; args = args.slice(1); }
      const shown = name === "LOGIN" ? `${tag} LOGIN ${quote(str(args[0]))} (password left out)` : text.replace(/\u0000/g, "{literal}");
      received.push({ connection: id, tag, command: name, line: shown });
      if (o.dropOn && name === o.dropOn) break;
      const ok = (s = `${name} completed`) => write(`${tag} OK ${s}${CRLF}`);
      const bad = (s: string) => write(`${tag} BAD ${s}${CRLF}`);
      const no = (s: string) => write(`${tag} NO ${s}${CRLF}`);
      try {
        if (name === "CAPABILITY") { await write(`* CAPABILITY ${CAPS}${CRLF}`); await ok(); continue; }
        if (name === "NOOP") { await ok(); continue; }
        if (name === "LOGOUT") { await write(`* BYE stand-in IMAP logging out${CRLF}`); await ok(); break; }
        if (name === "LOGIN") {
          if (str(args[0]) === o.user && str(args[1]) === o.password) { authed = true; await ok(`[CAPABILITY ${CAPS}] LOGIN completed`); }
          else await no("[AUTHENTICATIONFAILED] Invalid credentials (Failure)");
          continue;
        }
        if (!authed) { await bad("Log in first"); continue; }
        if (name === "LIST" || name === "LSUB") {
          // An empty pattern asks for the hierarchy delimiter and the root, as RFC 3501 6.3.8 has it.
          if (str(args[1]) === "") { await write(`* ${name} (\\Noselect) "/" ""${CRLF}`); await ok(); continue; }
          for (const f of o.folders) await write(`* ${name} (\\HasNoChildren${f.specialUse ? ` ${f.specialUse}` : ""}) "/" ${quote(mutf7(f.name))}${CRLF}`);
          await ok(); continue;
        }
        if (name === "EXAMINE" || name === "SELECT") {
          const f = folderOf(str(args[0]));
          if (!f) { await no("[NONEXISTENT] No such mailbox"); continue; }
          selected = f;
          const next = nextUid.get(f)!;
          await write(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)${CRLF}* ${f.messages.length} EXISTS${CRLF}* 0 RECENT${CRLF}` +
            (f.uidValidity === undefined ? "" : `* OK [UIDVALIDITY ${f.uidValidity}] UIDs valid${CRLF}`) + `* OK [UIDNEXT ${next}] Predicted next UID${CRLF}` +
            `* OK [PERMANENTFLAGS (${name === "SELECT" ? "\\Seen \\Deleted" : ""})] Flags permitted${CRLF}`);
          await ok(`[${name === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] ${name} completed`);
          continue;
        }
        if (name === "CLOSE" || name === "UNSELECT") { selected = null; await ok(); continue; }
        if (name === "APPEND") {
          const f = folderOf(str(args[0]));
          if (!f) { await no("[TRYCREATE] No such mailbox"); continue; }
          const flagsToken = args.find((t) => typeof t === "object" && "list" in t) as { list: Token[] } | undefined;
          const raw = str(args[args.length - 1]);
          const uid = take(f);
          f.messages.push(await appended(raw, uid, flagsToken ? flagsToken.list.map(str) : []));
          await ok(has("UIDPLUS") ? `[APPENDUID ${f.uidValidity ?? 0} ${uid}] APPEND completed` : "APPEND completed");
          continue;
        }
        if (!selected) { await bad("Select a mailbox first"); continue; }
        const f = selected;
        const seqOf = (m: Message) => f.messages.indexOf(m) + 1;
        const uids = f.messages.map((m) => m.uid);
        if (name === "SEARCH" || name === "UID SEARCH") {
          let keys = args;
          if (str(keys[0]).toUpperCase() === "CHARSET") keys = keys.slice(2);
          const hits = f.messages.filter((m) => meets(m, keys, seqOf, uids));
          await write(`* SEARCH${hits.map((m) => ` ${byUid ? m.uid : seqOf(m)}`).join("")}${CRLF}`);
          await ok(); continue;
        }
        if (name === "FETCH" || name === "UID FETCH") {
          const set = str(args[0]);
          const itemsToken = args[1];
          let items = typeof itemsToken === "object" && "list" in itemsToken ? itemsToken.list.map(str) : [str(itemsToken)];
          items = items.flatMap((x) => x.toUpperCase() === "ALL" ? ["FLAGS", "INTERNALDATE", "RFC822.SIZE", "ENVELOPE"]
            : x.toUpperCase() === "FAST" ? ["FLAGS", "INTERNALDATE", "RFC822.SIZE"] : [x]);
          if (byUid && !items.some((x) => x.toUpperCase() === "UID")) items.unshift("UID");
          const picked = byUid ? inSet(set, uids).map((u) => f.messages.find((m) => m.uid === u)!) : inSet(set, f.messages.map((_, j) => j + 1)).map((n) => f.messages[n - 1]);
          for (const m of picked) {
            if (m.gone) continue;
            let out = `* ${seqOf(m)} FETCH (`;
            out += items.map((it) => { const a = fetchItem(it, m); return a.literal === undefined ? a.text : `${a.text}${CRLF}${a.literal}`; }).join(" ");
            await write(out + `)${CRLF}`);
          }
          await ok(); continue;
        }
        if (name === "STORE" || name === "UID STORE") {
          const picked = byUid ? inSet(str(args[0]), uids).map((u) => f.messages.find((m) => m.uid === u)!) : inSet(str(args[0]), f.messages.map((_, j) => j + 1)).map((n) => f.messages[n - 1]);
          const how = str(args[1]).toUpperCase();
          const flagsToken = args[2];
          const given = typeof flagsToken === "object" && "list" in flagsToken ? flagsToken.list.map(str) : [str(flagsToken)];
          for (const m of picked) {
            const now = new Set(m.flags ?? []);
            if (how.startsWith("+")) given.forEach((x) => now.add(x));
            else if (how.startsWith("-")) given.forEach((x) => now.delete(x));
            else { now.clear(); given.forEach((x) => now.add(x)); }
            m.flags = [...now];
            if (!how.endsWith(".SILENT")) await write(`* ${seqOf(m)} FETCH (FLAGS (${m.flags.join(" ")})${byUid ? ` UID ${m.uid}` : ""})${CRLF}`);
          }
          await ok(); continue;
        }
        if (name === "EXPUNGE" || (name === "UID EXPUNGE" && has("UIDPLUS"))) {
          const within = name === "UID EXPUNGE" ? inSet(str(args[0]), uids) : uids;
          const doomed = f.messages.filter((m) => within.includes(m.uid) && (m.flags ?? []).includes("\\Deleted"));
          for (const m of doomed) { await write(`* ${seqOf(m)} EXPUNGE${CRLF}`); f.messages.splice(f.messages.indexOf(m), 1); }
          await ok(); continue;
        }
        if (name === "UID MOVE" && has("MOVE")) {
          const to = folderOf(str(args[1]));
          if (!to) { await no("[TRYCREATE] No such mailbox"); continue; }
          const moving = inSet(str(args[0]), uids).map((u) => f.messages.find((m) => m.uid === u)!);
          const given = moving.map((m) => ({ m, uid: take(to) }));
          await write(`* OK [COPYUID ${to.uidValidity ?? 0} ${given.map((g) => g.m.uid).join(",")} ${given.map((g) => g.uid).join(",")}] Moved${CRLF}`);
          for (const g of given) {
            await write(`* ${seqOf(g.m)} EXPUNGE${CRLF}`);
            f.messages.splice(f.messages.indexOf(g.m), 1);
            to.messages.push({ ...g.m, uid: g.uid });
          }
          await ok(); continue;
        }
        await bad(`${name} is not answered by the stand-in`);
      } catch (err) {
        await bad(String((err as Error).message));
      }
    }
    try { conn.close(); } catch { /* already closed */ }
  }

  for (const l of listeners) {
    (async () => {
      for await (const conn of l) {
        const id = ++connections;
        open.add(conn);
        serve(conn, id).catch(() => {}).finally(() => open.delete(conn));
      }
    })().catch(() => {});
  }

  return {
    port: (listener.addr as Deno.NetAddr).port,
    ipv6,
    received,
    connections: () => connections,
    close: async () => {
      for (const l of listeners) { try { l.close(); } catch { /* closed */ } }
      for (const c of open) { try { c.close(); } catch { /* closed */ } }
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}
