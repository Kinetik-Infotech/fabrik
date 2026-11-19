// Drafting, sending and moving to Trash, for the mailboxes mail.ts reads, over the connections it opens and with the
// password it reads from Vault. A draft is kept in the folder the server marks \Drafts, by IMAP APPEND. A message goes
// out over SMTP with the mailbox's own password, and is then filed in the folder marked \Sent unless the server filed
// it there itself. A message is moved to the folder marked \Trash, never expunged: a draft replaced or sent goes there too.
//
// A send holds no IMAP connection open while SMTP carries the message: what it reads first is read on one connection,
// and the filing in Sent and the draft's move to Trash on another, opened once the message is out. A failure after the
// send is said in the answer, never given as a refusal, since the message has gone and a refusal reads as if it had not.
//
// Each message is made by nodemailer's own composer from the mailbox's From address and signatures and what the call
// gives, with a Message-ID of its own. A mailbox with an HTML signature sends multipart/alternative: the HTML part is the
// body made into paragraphs, in the signature's own typography, with the HTML signature after it, and the plain-text
// part is the body with the plain-text signature, or the HTML signature's text when there is none. A mailbox with no
// HTML signature sends plain text. A stored draft keeps its Bcc header, since its bytes are its only record of who
// it goes to; the copy sent over SMTP has it taken out, and the SMTP envelope carries those recipients. An attachment
// is a file in a fabrik scope, read from Storage as the signed-in person, so a file they may not read is refused.
//
// Every tool here changes the mailbox or sends from it, so its description asks Claude to show the person what it
// will do, and to call it only after the person's approval in the chat.
import MailComposer from "npm:nodemailer@6.10.1/lib/mail-composer/index.js";
import { simpleParser } from "npm:mailparser@3.9.12";
import { Buffer } from "node:buffer";
import type { ImapFlow } from "npm:imapflow@2.12.1";
import { z } from "npm:zod@4.3.6";
import { call, type Ctx, refused, type Result, scopeOf, type Tool, tool } from "./tool.ts";
import { objectPath } from "./ported.ts";
import {
  ADDRESS, category, decodeHtml, examine, type Folder, folderPath, htmlText, line, list, type Mailbox, mailboxArg, mailboxRow, MAX_MESSAGES,
  MESSAGE, onMailbox, Refusal, same, type Settings, smtpTransport, uidArg, uidValidityArg, using,
} from "./mail.ts";

/** The most attachments one message takes, and the most bytes they come to. */
export const MAX_ATTACHMENTS = 10;
export const ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** The most recipients one message takes, To, Cc and Bcc together. */
export const MAX_RECIPIENTS = 50;
const BODY_CHARS = 200_000;
/** The longest signatures fabrik keeps, plain text and HTML. */
const SIGNATURE_CHARS = 2000;
const SIGNATURE_HTML_CHARS = 50_000;

// ---- What a call gives ----

/** One recipient: an email address, or a name and an address in angle brackets. No line breaks, commas or semicolons. */
const RECIPIENT = /^(?:[^\r\n<>,;"]{0,200}<[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+>|[^@\s<>,;"]+@[^@\s<>,;"]+\.[^@\s<>,;"]+)$/;
const recipients = (what: string) => z.array(z.string().trim().regex(RECIPIENT, "An email address, or a name and an address in angle brackets"))
  .max(MAX_RECIPIENTS).optional().describe(`${what}: each an email address, such as ann@example.com, or Ann Lee <ann@example.com>.`);
// deno-lint-ignore no-control-regex
const subjectArg = z.string().max(998).refine((s) => !/[\u0000-\u001F\u007F]/.test(s), { message: "A subject of one line" })
  .describe("The subject, one line.");
const bodyArg = z.string().max(BODY_CHARS).describe(`The message's text, plain text, at most ${BODY_CHARS} characters, with no signature: the mailbox's signature is added under it.`);
const attachmentsArg = z.array(z.object({
  scope: z.string().min(1).describe("The file's scope, by its scope_id, code or name, from list_scopes."),
  path: z.string().min(1).describe("The file's path in the scope, as upload_file or search gives it."),
})).max(MAX_ATTACHMENTS).optional()
  .describe(`Files in fabrik scopes to attach, ${MAX_ATTACHMENTS} at most and ${ATTACHMENT_BYTES / 1024 / 1024} MB in all. Upload a file from the computer with upload_file first.`);
const parentArg = z.object({
  folder: z.enum(["inbox", "sent"]).describe("The folder the message replied to is in."),
  uid: uidArg, uid_validity: uidValidityArg,
});
const messageFields = {
  to: recipients("The recipients"), cc: recipients("Copied to"), bcc: recipients("Blind copied to: the other recipients do not see these"),
  subject: subjectArg, body: bodyArg, attachments: attachmentsArg,
};
const APPROVAL = "Before calling it, show the person the From address, every recipient, the subject, the whole text and each attachment, " +
  "and call it only after their approval in the chat of exactly that. Administrators only.";

type Message = {
  to?: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string;
  attachments?: { scope: string; path: string }[]; parent?: z.infer<typeof parentArg>;
};
type Attachment = { filename: string; content: Buffer; contentType: string };
type Parent = { messageId: string; references: string[]; subject: string; replyTo: string[]; others: string[] };

// ---- Attachments ----

/** Each file named, read from its scope's Storage bucket as the person: Storage's own rules decide what they may read. */
async function filesOf(ctx: Ctx, wanted: { scope: string; path: string }[]): Promise<Attachment[]> {
  const out: Attachment[] = [];
  let total = 0;
  for (const w of wanted) {
    const encoded = objectPath(w.path);
    if (!encoded) throw new Refusal(`Not a path inside a scope: ${w.path}.`);
    const found = await scopeOf(ctx, w.scope);
    if (typeof found === "string") throw new Refusal(found);
    const res = await ctx.project(`/storage/v1/object/authenticated/${found.code}/${encoded}`);
    if (!res.ok || !res.body) {
      await res.body?.cancel();
      throw new Refusal(`${w.path} in ${found.name} could not be read for attaching: there is no such file, or you may not read it.`);
    }
    const over = () => new Refusal(`The attachments come to over ${ATTACHMENT_BYTES / 1024 / 1024} MB, which is the most one message takes.`);
    // Refused by its stated length before any of it is read, and counted as it is read, whatever length was stated.
    const stated = Number(res.headers.get("Content-Length") ?? "NaN");
    if (Number.isFinite(stated) && total + stated > ATTACHMENT_BYTES) { await res.body.cancel(); throw over(); }
    const chunks: Uint8Array[] = [];
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > ATTACHMENT_BYTES) { await reader.cancel(); throw over(); }
      chunks.push(value);
    }
    const content = Buffer.concat(chunks);
    out.push({ filename: w.path.split("/").pop()!, content, contentType: res.headers.get("Content-Type") ?? "application/octet-stream" });
  }
  return out;
}

// ---- Signatures ----

/** The elements a signature may hold. Any other is refused, so markup a mail program may run or load never goes out. */
const SIGNATURE_TAGS = new Set(("a abbr b bdi bdo big blockquote br caption center cite code col colgroup dd del dfn div dl dt em font " +
  "h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strike strong style sub sup table tbody td tfoot th thead " +
  "tr tt u ul wbr").split(" "));
/** Elements that load or run another page, named as such in a refusal. */
const LOADS = new Set(["iframe", "frame", "frameset", "object", "embed", "applet", "form", "meta", "base", "link"]);
/** Elements whose content a browser reads as text up to their end tag, not as markup. */
const RAW = new Set(["script", "style", "title", "textarea", "xmp", "iframe", "noembed", "noframes", "noscript"]);
/** Attributes whose value is an address. */
const ADDRESSED = new Set(["href", "src", "background", "action", "formaction", "poster", "cite", "longdesc", "lowsrc", "dynsrc",
  "srcset", "data", "codebase", "ping", "xlink:href"]);
const SCHEMES = new Set(["http", "https", "mailto", "tel", "cid"]);
const SPACE = /[\t\n\f\r ]/;

type Tag = { name: string; end: boolean; attrs: [string, string][]; from: number; to: number };
type Raw = { raw: string; text: string; from: number; to: number };
type Note = { note: true; from: number; to: number };

/** An attribute's value as a browser reads an address in it: character references decoded, and spaces and control
 * characters taken out, so java&#x09;script&#58; reads as javascript:. */
// deno-lint-ignore no-control-regex
const asAddress = (value: string) => decodeHtml(value, true).replace(/[\u0000-\u0020\u007F]+/g, "").toLowerCase();

/** The scheme of an address, or an empty string for an address with none. */
const schemeOf = (value: string) => /^([a-z][a-z0-9+.-]*):/.exec(asAddress(value))?.[1] ?? "";

/** Why an address may not go out, or null. A picture may be a data: address of an image. */
function badAddress(attr: string, value: string): string | null {
  const urls = attr === "srcset" ? value.split(",").map((c) => c.trim().split(/\s+/)[0]) : [value];
  for (const url of urls) {
    const scheme = schemeOf(url);
    if (!scheme || SCHEMES.has(scheme)) continue;
    if (scheme === "data" && (attr === "src" || attr === "background") && /^data:image\/(png|gif|jpeg|webp)[;,]/i.test(decodeHtml(url, true).trim())) continue;
    return `a ${scheme}: address`;
  }
  return null;
}

/** Why a style may not go out, or null. A backslash is refused, since a CSS escape can spell any word. */
function badStyle(css: string): string | null {
  const read = css.replace(/\/\*[\s\S]*?(\*\/|$)/g, "").replace(/\s+/g, "").toLowerCase();
  if (read.includes("\\") || /expression\(|-moz-binding|behavior:|javascript:|vbscript:/.test(read)) return "a style that can run code";
  if (read.includes("@import")) return "a style that loads another stylesheet";
  for (const m of read.matchAll(/url\(['"]?([^'")]*)/g)) {
    const bad = badAddress("src", m[1]);
    if (bad) return bad;
  }
  return null;
}

/** The tags, comments and raw text of a piece of HTML, read as a browser reads them: a > in a quoted value stays in the
 * value, <!--> closes a comment at once, and a script's or style's content runs to its end tag. A tag, comment, quoted
 * value or raw element left open is refused, since the markup after the signature would be read into it. */
function tokens(html: string): (Tag | Raw | Note)[] | string {
  const out: (Tag | Raw | Note)[] = [];
  const n = html.length;
  let i = 0;
  while (true) {
    const lt = html.indexOf("<", i);
    if (lt < 0) return out;
    if (html.startsWith("<!--", lt)) {
      let end: number;
      if (html.startsWith(">", lt + 4)) end = lt + 5;
      else if (html.startsWith("->", lt + 4)) end = lt + 6;
      else {
        const close = /--!?>/g;
        close.lastIndex = lt + 4;
        const m = close.exec(html);
        if (!m) return "a comment left open";
        end = m.index + m[0].length;
      }
      out.push({ note: true, from: lt, to: end });
      i = end;
      continue;
    }
    const next = html[lt + 1] ?? "";
    const end = next === "/";
    const start = end ? lt + 2 : lt + 1;
    // A doctype, <?…> and </ not followed by a letter run to the next >, as a browser reads them.
    if (next === "!" || next === "?" || (end && !/[a-zA-Z]/.test(html[start] ?? ""))) {
      const gt = html.indexOf(">", lt + 2);
      if (gt < 0) return "a tag left open";
      out.push({ note: true, from: lt, to: gt + 1 });
      i = gt + 1;
      continue;
    }
    // A < not followed by a letter is text.
    if (!/[a-zA-Z]/.test(html[start] ?? "")) { i = lt + 1; continue; }
    let j = start;
    while (j < n && !/[\t\n\f\r />]/.test(html[j])) j++;
    const tag: Tag = { name: html.slice(start, j).toLowerCase(), end, attrs: [], from: lt, to: 0 };
    while (true) {
      while (j < n && /[\t\n\f\r /]/.test(html[j])) j++;
      if (j >= n) return "a tag left open";
      if (html[j] === ">") { j++; break; }
      // A name may begin with =, and runs to a space, /, > or =.
      let k = j + 1;
      while (k < n && !/[\t\n\f\r />=]/.test(html[k])) k++;
      const name = html.slice(j, k).toLowerCase();
      j = k;
      while (j < n && SPACE.test(html[j])) j++;
      let value = "";
      if (html[j] === "=") {
        j++;
        while (j < n && SPACE.test(html[j])) j++;
        const quote = html[j];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, j + 1);
          if (close < 0) return "a tag left open";
          value = html.slice(j + 1, close);
          j = close + 1;
        } else {
          k = j;
          while (k < n && !/[\t\n\f\r >]/.test(html[k])) k++;
          value = html.slice(j, k);
          j = k;
        }
      }
      tag.attrs.push([name, value]);
    }
    tag.to = j;
    out.push(tag);
    i = j;
    if (!end && (RAW.has(tag.name) || tag.name === "plaintext")) {
      const close = new RegExp(`</${tag.name}[\\t\\n\\f\\r />]`, "gi");
      close.lastIndex = j;
      const m = tag.name === "plaintext" ? null : close.exec(html);
      if (!m) return `a <${tag.name}> element left open`;
      out.push({ raw: tag.name, text: html.slice(j, m.index), from: j, to: m.index });
      i = m.index;
    }
  }
}

/** Why a tag may not go out, or null. */
function badTag(tag: Tag): string | null {
  if (tag.end) return null;
  if (tag.name === "script") return "a script";
  if (LOADS.has(tag.name)) return "an element that loads or runs another page";
  if (!SIGNATURE_TAGS.has(tag.name)) return `a <${tag.name}> element`;
  for (const [name, value] of tag.attrs) {
    if (/^on/.test(name)) return "an on…= attribute";
    const bad = ADDRESSED.has(name) ? badAddress(name, value) : name === "style" ? badStyle(decodeHtml(value, true)) : null;
    if (bad) return bad;
    const script = /(javascript|vbscript):/.exec(asAddress(value));
    if (script) return `a ${script[1]}: address`;
  }
  return null;
}

/** The HTML that goes out for a signature, and the style of its root element, or why it may not go out. Of a whole page,
 * what its <body> holds is sent, after the styles in its <head>, so its classes keep their look; the rest of its head,
 * scripts included, stays out and is not checked. */
export function readSignature(html: string): { body: string; rootStyle: string | null } | { unsafe: string } {
  const all = tokens(html);
  if (typeof all === "string") return { unsafe: all };
  const opened = all.findIndex((t) => "name" in t && t.name === "body" && !t.end);
  const from = opened < 0 ? 0 : opened + 1;
  const closed = all.findIndex((t, x) => x >= from && "name" in t && t.name === "body" && t.end);
  const sent = all.slice(from, closed < 0 ? all.length : closed);
  const head = all.slice(0, Math.max(opened, 0)).filter((t): t is Raw => "raw" in t && t.raw === "style");
  for (const t of [...head, ...sent]) {
    const bad = "raw" in t ? (t.raw === "style" ? badStyle(t.text) : null) : "name" in t ? badTag(t) : null;
    if (bad) return { unsafe: bad };
  }
  const start = opened < 0 ? 0 : all[opened].to;
  const body = html.slice(start, closed < 0 ? html.length : all[closed].from).trim();
  // The root is the first element, with only space and comments before it.
  let rootStyle: string | null = null;
  let at = start;
  for (const t of sent) {
    if (html.slice(at, t.from).trim()) break;
    if ("note" in t) { at = t.to; continue; }
    const style = "name" in t && !t.end ? t.attrs.find(([a]) => a === "style") : undefined;
    if (style) rootStyle = decodeHtml(style[1], true);
    break;
  }
  return { body: head.map((s) => `<style>${s.text}</style>`).join("") + body, rootStyle };
}

/** Why an HTML signature may not go out, or null when it may. */
export function unsafeSignature(html: string): string | null {
  const read = readSignature(html);
  return "unsafe" in read ? read.unsafe : null;
}

/** The text of an HTML signature, for the plain-text part: a line for each line break and each block it ends. */
export const signatureText = (html: string) =>
  htmlText(html.replace(/\s+/g, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|p|tr|td|li|h[1-6]|table)\s*>/gi, "$&\n"));

/** Plain text as HTML: a line of nothing but spaces starts a paragraph, a line break is <br>, and spaces a browser
 * would fold into one, at the start of a line or two together, are kept. Only &, < and > are escaped, since it is never
 * an attribute's value. */
export function htmlFromPlainText(text: string): string {
  const escaped = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const spaced = (line: string) => line.replace(/^ /, "&nbsp;").replace(/ {2}/g, " &nbsp;");
  return escaped.split(/\n[^\S\n]*\n(?:[^\S\n]*\n)*/).map((p) => `<p>${p.split("\n").map(spaced).join("<br>")}</p>`).join("");
}

/** The font family, size, line height and colour of a style, as CSS, so the body reads in the signature's own type.
 * Null when it declares none. */
export function typography(style: string | null): string | null {
  if (!style) return null;
  const kept = style.split(";").map((d) => [d.slice(0, d.indexOf(":")).trim().toLowerCase(), d.slice(d.indexOf(":") + 1).trim()])
    .filter(([p, v]) => v && ["font-family", "font-size", "line-height", "color"].includes(p)).map(([p, v]) => `${p}:${v}`);
  return kept.length ? kept.join(";") : null;
}

/** The message's plain text, and its HTML when the mailbox has an HTML signature, each with its own signature. */
export function signed(body: string, box: Pick<Settings, "signature" | "signature_html">): { text: string; html?: string } {
  // A signature written to the table some other way than mail_signature_set is checked here too, before it is sent.
  const sig = box.signature_html ? readSignature(box.signature_html) : null;
  if (sig && "unsafe" in sig) throw new Refusal(`The mailbox's HTML signature holds ${sig.unsafe}, so nothing is drafted or sent. Set the signature again with mail_signature_set.`);
  const sigHtml = sig?.body ?? "";
  const sigText = box.signature || (sigHtml ? signatureText(sigHtml) : "");
  const trimmed = body.replace(/\s+$/, "");
  const text = sigText ? `${trimmed}\n\n-- \n${sigText}\n` : body;
  if (!sig || !sigHtml) return { text };
  const type = typography(sig.rootStyle);
  const inner = `${htmlFromPlainText(trimmed)}<br>${sigHtml}`;
  return { text, html: type ? `<div style="${type.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${inner}</div>` : `<div>${inner}</div>` };
}

// ---- Composing ----

/** The address in a recipient as given: the part in angle brackets, or all of it. */
const bare = (r: string) => (/<([^>]+)>$/.exec(r)?.[1] ?? r).trim().toLowerCase();
/** A domain for the Message-ID, from the From address. */
const domainOf = (address: string) => address.split("@")[1] ?? "fabrik.invalid";

/** Bytes with every line ending made CRLF, as IMAP and SMTP carry a message: the composer leaves a text body's LF. */
export const crlf = (raw: Buffer) => Buffer.from(raw.toString("latin1").replace(/\r?\n/g, "\r\n"), "latin1");

/** The message's bytes, as nodemailer's composer makes them, with CRLF line endings and the Bcc header kept: SMTP gets
 * it taken out. */
function compose(options: Record<string, unknown>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const node = new MailComposer(options).compile();
    node.keepBcc = true;
    node.build((err: Error | null, message: Buffer) => err ? reject(err) : resolve(crlf(message)));
  });
}

/** The bytes with every Bcc header line, and its folded lines, taken out of the header, its line endings made CRLF
 * first. A header still holding a Bcc line after that is refused, so a recipient meant to be blind is never shown. */
export function withoutBcc(raw: Buffer): Buffer {
  const text = crlf(raw).toString("latin1");
  const end = text.indexOf("\r\n\r\n");
  const head = end < 0 ? text : text.slice(0, end);
  const kept: string[] = [];
  let dropping = false;
  for (const l of head.split("\r\n")) {
    if (/^[ \t]/.test(l)) { if (!dropping) kept.push(l); continue; }
    dropping = /^\s*bcc\s*:/i.test(l);
    if (!dropping) kept.push(l);
  }
  if (kept.some((l) => /^\s*bcc\s*:/i.test(l))) throw new Refusal("The message's Bcc header could not be taken out, so it is not sent.");
  return Buffer.from(kept.join("\r\n") + (end < 0 ? "" : text.slice(end)), "latin1");
}

/** A message from the mailbox: its bytes, its Message-ID and what it holds, for the answer. */
async function build(ctx: Ctx, box: Mailbox, m: Message, parent: Parent | null) {
  if (!box.address || !ADDRESS.test(box.address)) throw new Refusal(`The mailbox ${box.name} has no From address. Set it up again on the mail setup card.`);
  const to = m.to ?? [], cc = m.cc ?? [], bcc = m.bcc ?? [];
  if (!to.length && !cc.length && !bcc.length) throw new Refusal("Give at least one recipient, in to, cc or bcc.");
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw new Refusal(`A message goes to ${MAX_RECIPIENTS} recipients at most.`);
  const files = await filesOf(ctx, m.attachments ?? []);
  const messageId = `<${crypto.randomUUID()}@${domainOf(box.address)}>`;
  const { text, html } = signed(m.body, box);
  const raw = await compose({
    from: box.address, to, cc: cc.length ? cc : undefined, bcc: bcc.length ? bcc : undefined, subject: m.subject, text, html, messageId,
    inReplyTo: parent?.messageId, references: parent ? [...parent.references, parent.messageId].join(" ") : undefined,
    attachments: files.map((f) => ({ filename: f.filename, content: f.content, contentType: f.contentType })),
  });
  return {
    raw, messageId, envelope: { from: box.address, to: [...to, ...cc, ...bcc].map(bare) },
    shown: { from: box.address, to, cc, bcc, envelope_to: [...to, ...cc, ...bcc].map(bare), subject: m.subject, message_id: messageId,
      attachments: files.map((f) => ({ filename: f.filename, size: f.content.length })) },
  };
}

/** The message a reply answers, with what threading and replying to it need. */
async function parentOf(client: ImapFlow, box: Mailbox, p: z.infer<typeof parentArg>): Promise<Parent> {
  return await examine(client, p.folder as Folder, async (name, uidValidity) => {
    same(p.uid_validity, uidValidity);
    const head = await client.fetchOne(String(p.uid), { uid: true, envelope: true, headers: ["references"] }, { uid: true });
    if (!head || !head.envelope) throw new Refusal(`No message in ${name} has the uid ${p.uid}.`);
    if (/[\r\n]/.test(head.envelope.messageId ?? "")) throw new Refusal("The message's Message-ID holds a line break, so a reply is not threaded to it.");
    const e = head.envelope;
    if (!e.messageId) throw new Refusal("The message has no Message-ID, so a reply cannot be threaded to it.");
    // The mailbox's own addresses: its From address, and its username where that is another address of the person's.
    const own = new Set([box.address, box.username].map((x) => (x ?? "").toLowerCase()));
    // Each recipient taken from the message is its bare address, and only one that passes the From address's own check:
    // the message was written by someone else.
    const all = (list?: { address?: string; name?: string }[]) =>
      (list ?? []).map((x) => line(x.address ?? "").toLowerCase()).filter((x) => x.length <= 320 && ADDRESS.test(x));
    // A reply to a message the mailbox sent goes to that message's recipients; any other, to its Reply-To or From.
    const replyTo = p.folder === "sent" ? all(e.to) : all(e.replyTo?.length ? e.replyTo : e.from);
    const others = [...all(e.to), ...all(e.cc)].filter((x) => !own.has(bare(x)) && !replyTo.some((r) => bare(r) === bare(x)));
    const subject = line(e.subject);
    const messageId = line(e.messageId);
    // The thread so far, from the message's References header, unfolded: each a Message-ID in angle brackets with no
    // space or line break, the last 20 at most, so a long thread keeps its newest messages and the header stays short.
    const folded = Buffer.from(head.headers ?? "").toString("latin1").replace(/\r?\n[ \t]+/g, " ");
    const references = (/^references:(.*)$/im.exec(folded)?.[1].match(/<[^<>\s]{1,250}>/g) ?? []).filter((x) => x !== messageId).slice(-20);
    return { messageId, references, subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, replyTo, others };
  });
}

// ---- The mailbox's folders ----

/** Keeps the bytes in the Drafts folder, marked \Draft and \Seen: the draft's uid and uid_validity. */
async function keepDraft(client: ImapFlow, raw: Buffer, messageId: string): Promise<{ folder: string; uid: number | null; uid_validity: string | null }> {
  const { path, name } = await folderPath(client, "drafts");
  const put = await client.append(path, raw, ["\\Draft", "\\Seen"]);
  if (put && put.uid) return { folder: name, uid: put.uid, uid_validity: put.uidValidity ? String(put.uidValidity) : null };
  // A server without UIDPLUS gives no uid: the draft's own Message-ID finds it.
  return await examine(client, "drafts", async (_n, uidValidity) => {
    const found = (await client.search({ header: { "message-id": messageId } }, { uid: true })) || [];
    return { folder: name, uid: found.length ? Math.max(...found) : null, uid_validity: uidValidity };
  });
}

/** Whether the server can move a message without removing others: MOVE, or UIDPLUS for an EXPUNGE of one uid. */
const canMove = (client: ImapFlow) => client.capabilities.has("MOVE") || client.capabilities.has("UIDPLUS");

/** Moves one draft from Drafts to Trash, by its uid, once the folder's uid_validity is still the one given. */
async function toTrash(client: ImapFlow, uid: number, uidValidity: string) {
  const { path } = await folderPath(client, "trash");
  await examine(client, "drafts", async (_n, now) => { same(uidValidity, now); await client.messageMove(String(uid), path, { uid: true }); }, true);
}

/** A stored draft's bytes, by its uid in the Drafts folder. */
async function draftSource(client: ImapFlow, uid: number): Promise<Buffer> {
  const got = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
  if (!got || !got.source) throw new Refusal(`No draft in the Drafts folder has the uid ${uid}.`);
  return Buffer.from(got.source);
}

/** Files a sent message in the Sent folder, unless the server already did: whether it was filed, found or neither. */
async function fileInSent(client: ImapFlow, raw: Buffer, messageId: string): Promise<string> {
  try {
    const { path } = await folderPath(client, "sent");
    const there = await examine(client, "sent", async () => ((await client.search({ header: { "message-id": messageId } }, { uid: true })) || []).length > 0);
    if (there) return "already in Sent";
    await client.append(path, raw, ["\\Seen"]);
    return "filed in Sent";
  } catch (error) {
    return `sent, but not filed in Sent: ${why(error)}`;
  }
}

/** Sends the bytes over SMTP, with the Bcc header taken out and the envelope's recipients. */
async function send(box: Mailbox, raw: Buffer, envelope: { from: string; to: string[] }) {
  const transport = await smtpTransport(box);
  try { await transport.sendMail({ raw: withoutBcc(raw), envelope }); }
  finally { try { transport.close(); } catch { /* already closed */ } }
}

/** Runs fn on the mailbox the call names, with one IMAP connection, giving a failure as its kind alone. */
const onImap = (ctx: Ctx, named: string | undefined, fn: (box: Mailbox, client: ImapFlow) => Promise<unknown>): Promise<Result> =>
  onMailbox(ctx, named, (box) => using(box, (client) => fn(box, client)), "reached");

/** What went wrong, in fabrik's words or as its kind alone. */
const why = (error: unknown) => error instanceof Refusal ? error.message : category(error);

/** The work that follows a send, on an IMAP connection of its own. A failure gives otherwise's answer, never throws. */
async function afterSending<T>(box: Mailbox, fn: (client: ImapFlow) => Promise<T>, otherwise: (why: string) => T): Promise<T> {
  try { return await using(box, fn); } catch (error) { return otherwise(why(error)); }
}

/** Files a sent message in Sent, on a connection opened after the send. */
const filed = (box: Mailbox, raw: Buffer, messageId: string) =>
  afterSending(box, (client) => fileInSent(client, raw, messageId), (w) => `sent, but not filed in Sent: ${w}`);

// ---- The tools ----

const draft = tool({
  name: "mail_draft",
  description: "Save a new email as a draft in a mailbox's Drafts folder, unsent, from the mailbox's From address with its signatures added. " +
    "It is the first step of an email the person asks for. Tell them it's in Drafts, and send it with mail_draft_send once they approve sending it. " +
    "Give in_reply_to to thread it as a reply to a message from mail_read or mail_search. Gives the draft's uid and uid_validity in drafts, " +
    "which mail_draft_edit, mail_draft_send and mail_delete take, and from, to, cc, bcc, subject, message_id and attachments. " + APPROVAL,
  input: z.object({ mailbox: mailboxArg, ...messageFields, in_reply_to: parentArg.optional().describe("The message this draft replies to.") }),
  run: (ctx, a) => onImap(ctx, a.mailbox, async (box, client) => {
    const parent = a.in_reply_to ? await parentOf(client, box, a.in_reply_to) : null;
    const m = await build(ctx, box, a, parent);
    return { mailbox: box.name, ...m.shown, draft: await keepDraft(client, m.raw, m.messageId) };
  }),
});

const draftEdit = tool({
  name: "mail_draft_edit",
  description: "Replace a draft in a mailbox's Drafts folder with a new one: give every field of the draft as it should now be, not only " +
    "what changes. The old draft is moved to Trash once the new one is kept. Gives the new draft's uid and uid_validity, which the old ones no " +
    "longer name. " + APPROVAL,
  input: z.object({ mailbox: mailboxArg, uid: uidArg, uid_validity: uidValidityArg, ...messageFields,
    in_reply_to: parentArg.optional().describe("The message this draft replies to.") }),
  run: (ctx, a) => onImap(ctx, a.mailbox, async (box, client) => {
    if (!canMove(client)) throw new Refusal("This server can take a draft out only by expunging every message marked deleted, so drafts are not edited here.");
    await folderPath(client, "trash");
    await examine(client, "drafts", async (name, uidValidity) => {
      same(a.uid_validity, uidValidity);
      const got = await client.fetchOne(String(a.uid), { uid: true }, { uid: true });
      if (!got) throw new Refusal(`No draft in ${name} has the uid ${a.uid}.`);
    });
    const parent = a.in_reply_to ? await parentOf(client, box, a.in_reply_to) : null;
    const m = await build(ctx, box, a, parent);
    const kept = await keepDraft(client, m.raw, m.messageId);
    await toTrash(client, a.uid, a.uid_validity);
    return { mailbox: box.name, ...m.shown, draft: kept, replaced: { uid: a.uid, uid_validity: a.uid_validity } };
  }),
});

const draftList = tool({
  name: "mail_draft_list",
  description: `List the drafts in a mailbox's Drafts folder, newest first, ${MAX_MESSAGES} at most per call, as the server holds them now. ` + MESSAGE +
    " mail_fetch_body with folder drafts gives one draft's whole text. Administrators only. Reading changes nothing.",
  input: z.object({ mailbox: mailboxArg, limit: z.number().int().min(1).max(MAX_MESSAGES).optional(), before_uid: z.number().int().positive().optional() }),
  run: (ctx, a) => onImap(ctx, a.mailbox, (box, client) => list({ ...a, folder: "drafts" })(client, box.name)),
});

const draftSend = tool({
  name: "mail_draft_send",
  description: "Send a draft from a mailbox's Drafts folder as it is stored, over the mailbox's SMTP server, then file it in Sent and take it out " +
    "of Drafts into Trash. Read the draft first with mail_fetch_body, folder drafts, and show it to the person. A draft whose From is not the " +
    `mailbox's From address, or with over ${MAX_RECIPIENTS} recipients, is refused. Gives from, to, cc, bcc, subject, message_id, sent_copy, and ` +
    "draft, which says whether the draft went to Trash: once sent_copy or draft begins with sent, the message has gone, so never send it again. " + APPROVAL,
  input: z.object({ mailbox: mailboxArg, uid: uidArg, uid_validity: uidValidityArg }),
  run: (ctx, a) => onMailbox(ctx, a.mailbox, async (box) => {
    const raw = await using(box, async (client) => {
      if (!canMove(client)) throw new Refusal("This server can take a draft out only by expunging every message marked deleted, so drafts are not sent from here.");
      await folderPath(client, "trash");
      return await examine(client, "drafts", async (_n, uidValidity) => { same(a.uid_validity, uidValidity); return await draftSource(client, a.uid); });
    });
    const parsed = await simpleParser(raw);
    const from = parsed.from?.value?.[0]?.address?.toLowerCase();
    if (!box.address || from !== box.address.toLowerCase()) throw new Refusal(`The draft is from ${line(from ?? "no address")}, not the mailbox's From address, so it is not sent.`);
    const of = (x: typeof parsed.to) => (Array.isArray(x) ? x : x ? [x] : []).flatMap((g) => g.value).map((v) => v.address ?? "").filter(Boolean);
    const to = of(parsed.to), cc = of(parsed.cc), bcc = of(parsed.bcc);
    if (!to.length && !cc.length && !bcc.length) throw new Refusal("The draft has no recipients.");
    if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) throw new Refusal(`The draft has over ${MAX_RECIPIENTS} recipients, the most a message goes to, so it is not sent.`);
    const odd = [...to, ...cc, ...bcc].find((x) => x.length > 320 || !ADDRESS.test(x));
    if (odd !== undefined) throw new Refusal(`The draft has a recipient that is not one email address, ${line(odd).slice(0, 80)}, so it is not sent.`);
    const messageId = parsed.messageId ? line(parsed.messageId) : null;
    await send(box, raw, { from: box.address, to: [...to, ...cc, ...bcc].map(bare) });
    const after = await afterSending(box, async (client) => {
      const sentCopy = messageId ? await fileInSent(client, raw, messageId) : "sent, but not filed in Sent: the draft has no Message-ID";
      try { await toTrash(client, a.uid, a.uid_validity); return { sentCopy, draft: "moved to Trash" }; }
      catch (error) { return { sentCopy, draft: `sent, but left in Drafts: ${why(error)}. mail_delete, folder drafts, moves it to Trash` }; }
    }, (w) => ({ sentCopy: `sent, but not filed in Sent: ${w}`, draft: `sent, but left in Drafts: ${w}. mail_delete, folder drafts, moves it to Trash` }));
    return { mailbox: box.name, from: box.address, to, cc, bcc, subject: line(parsed.subject), message_id: messageId, sent_copy: after.sentCopy, draft: after.draft };
  }, "reached"),
});

const sendNew = tool({
  name: "mail_send",
  description: "Send a new email at once, without a draft, from a mailbox's From address over its SMTP server, with its signatures added, and " +
    "file it in Sent. Use it only when the person asks to send without a draft: for any other email, mail_draft first. " +
    "Gives from, to, cc, bcc, subject, message_id, attachments and sent_copy. mail_reply answers a message. " + APPROVAL,
  input: z.object({ mailbox: mailboxArg, ...messageFields }),
  run: (ctx, a) => onMailbox(ctx, a.mailbox, async (box) => {
    const m = await build(ctx, box, a, null);
    await send(box, m.raw, m.envelope);
    return { mailbox: box.name, ...m.shown, sent_copy: await filed(box, m.raw, m.messageId) };
  }, "reached"),
});

const reply = tool({
  name: "mail_reply",
  description: "Reply at once, without a draft, to a message from mail_read or mail_search, threaded to it, from the mailbox's From address " +
    "with its signatures added, and file the reply in Sent. Use it only when the person asks to send without a draft: for any other reply, " +
    "mail_draft with in_reply_to first. It goes to the message's Reply-To or From, or for a message in Sent to its recipients; reply_all copies the " +
    "message's other recipients. to and cc given replace those. The subject is the message's, with Re:. Gives from, to, cc, bcc, subject, " +
    "message_id, attachments and sent_copy. " + APPROVAL,
  input: z.object({
    mailbox: mailboxArg, folder: z.enum(["inbox", "sent"]).optional().describe("The message's folder: inbox when left out."),
    uid: uidArg, uid_validity: uidValidityArg, body: bodyArg, attachments: attachmentsArg,
    to: recipients("In place of the message's sender"), cc: recipients("Copied to"), bcc: recipients("Blind copied to"),
    reply_all: z.boolean().optional().describe("Copy the message's other recipients, as Reply all does."),
  }),
  run: (ctx, a) => onMailbox(ctx, a.mailbox, async (box) => {
    const parent = await using(box, (client) => parentOf(client, box, { folder: a.folder ?? "inbox", uid: a.uid, uid_validity: a.uid_validity }));
    const m = await build(ctx, box, {
      to: a.to ?? parent.replyTo, cc: a.cc ?? (a.reply_all ? parent.others : []), bcc: a.bcc, subject: parent.subject, body: a.body,
      attachments: a.attachments,
    }, parent);
    await send(box, m.raw, m.envelope);
    return { mailbox: box.name, ...m.shown, in_reply_to: parent.messageId, sent_copy: await filed(box, m.raw, m.messageId) };
  }, "reached"),
});

const remove = tool({
  name: "mail_delete",
  description: "Move messages to a mailbox's Trash folder, from the inbox, Sent or Drafts, by their uids and the folder's uid_validity, as " +
    "mail_read, mail_search or mail_draft_list give them. They stay in Trash, where the person can get them back. Gives the uids moved. " +
    "Before calling it, show the person each message's sender, subject and date, and call it only after their approval in the chat. " +
    "Administrators only.",
  input: z.object({
    mailbox: mailboxArg, folder: z.enum(["inbox", "sent", "drafts"]).describe("The folder the messages are in."),
    uids: z.array(uidArg).min(1).max(MAX_MESSAGES), uid_validity: uidValidityArg,
  }),
  run: (ctx, a) => onImap(ctx, a.mailbox, async (box, client) => {
    if (!canMove(client)) throw new Refusal("This server moves a message only by expunging every message marked deleted, so nothing is moved.");
    const trash = await folderPath(client, "trash");
    return await examine(client, a.folder, async (name, uidValidity) => {
      same(a.uid_validity, uidValidity);
      const there: number[] = [];
      for await (const m of client.fetch(a.uids.join(","), { uid: true }, { uid: true })) there.push(m.uid);
      const missing = a.uids.filter((u) => !there.includes(u));
      if (missing.length) throw new Refusal(`No message in ${name} has the uid ${missing.join(", ")}, so nothing is moved.`);
      await client.messageMove(a.uids.join(","), trash.path, { uid: true });
      return { mailbox: box.name, folder: name, moved_to: trash.name, uids: a.uids };
    }, true);
  }),
});

const signatureSet = tool({
  name: "mail_signature_set",
  description: "Set a mailbox's signatures, which every draft and message from it carries under its text: text, plain text, at most " +
    `${SIGNATURE_CHARS} characters, for the plain-text part, and html, at most ${SIGNATURE_HTML_CHARS} characters, for the HTML part. ` +
    "To use an HTML file the person gives, read the file and pass its whole text as html: of a whole page, what its body holds is used, after the styles in its head. " +
    "With an HTML signature, each message carries an HTML part, its text in the signature's own type, and a plain-text part, with the " +
    "plain-text signature, or the HTML signature's text when there is none. A part left out is kept, and a part given as an empty string is " +
    "removed. Sends nothing. An HTML signature is refused when it holds a script, a frame, a form or another element mail programs " +
    "don't show safely. So is one with an on…= attribute, a tag left open, or an address other than a web, mail, phone or picture one. " +
    "Gives the mailbox's " +
    "name and both signatures as now stored. Before calling it, show the person what it sets, and call it only after their approval in the " +
    "chat. Administrators only.",
  input: z.object({
    mailbox: mailboxArg,
    text: z.string().max(SIGNATURE_CHARS).optional().describe("The plain-text signature, or an empty string to remove it."),
    html: z.string().max(SIGNATURE_HTML_CHARS).optional().describe("The HTML signature, a fragment or a whole page, or an empty string to remove it."),
  }),
  run: async (ctx, a) => {
    // A call with neither part would change nothing, so it is refused rather than answered as if it had set one.
    if (a.text === undefined && a.html === undefined) return refused("Give text, html or both. Nothing was changed.");
    const bad = a.html ? unsafeSignature(a.html) : null;
    if (bad) return refused(`The HTML signature holds ${bad}, so it is not saved. Take it out and give the signature again.`);
    const row = await mailboxRow(ctx, a.mailbox);
    if ("content" in row) return row;
    return await call(ctx, "fabrik_save_mailbox_signature", { p_name: row.name, p_text: a.text ?? null, p_html: a.html ?? null });
  },
});

/** The tools that draft, send and move, in the order Claude lists them. */
export const MAIL_SEND_TOOLS: Tool[] = [draft, draftEdit, draftList, draftSend, sendNew, reply, remove, signatureSet];
