// The mail step's checks of the connector's drafting, sending and moving tools (mail-send.ts), run by mail.ts with its
// people, its Supabase stand-in and its helpers, against a fake IMAP server of their own (fake-imap.ts) and a fake SMTP
// server (fake-smtp.ts), both on implicit TLS with the step's certificate, and a fake SMTP server that upgrades with STARTTLS.
//
// It checks that mail_setup_save signs in to SMTP as well as IMAP, and saves nothing when SMTP refuses the password;
// that mail_draft keeps a draft in Drafts from the From address, with the signature, the Bcc header and an attachment
// read from a scope, and sends nothing; that mail_draft_list and mail_fetch_body read it back; that mail_draft_edit
// replaces it under a new uid and moves the old one to Trash, listing the folders once; that mail_draft_send sends it
// over SMTP with the Bcc recipients in the envelope and not in the bytes, files it in Sent and moves it to Trash, and
// says it was sent when the Drafts folder changes during the send; that mail_reply threads to the message and its
// References and goes to its sender, and reply_all leaves out the mailbox's username; that mail_delete moves a message
// to Trash; that SMTP on 587, 25 and 2525 requires STARTTLS. It checks that reading and sending go over Deno's own TLS,
// and a STARTTLS server is sent the password over TLS alone. It checks that mail_check reads the newest message once,
// and that a host resolving to a loopback address is refused once connected when FABRIK_MAIL_LOOPBACK is not set. It
// checks that a restricted person, a file that is not there, a mailbox with no SMTP host, a server with neither UIDPLUS nor MOVE, a stale uid_validity, a draft from another address, a draft
// to over 50 recipients and a recipient or subject with a line break are each refused before anything is sent or moved. It
// checks that mail_signature_set refuses an unsafe HTML signature and stores nothing, that a draft from a mailbox with an
// HTML signature is multipart/alternative with each signature in its own part and the body in the signature's typography,
// and that a mailbox with no HTML signature sends plain text.
import type postgres from "npm:postgres@3.4.9";
import { type Folder, startFakeImap } from "./fake-imap.ts";
import { startFakeSmtp } from "./fake-smtp.ts";

// deno-lint-ignore no-explicit-any
type Answer = { content?: { text: string }[]; structuredContent?: any; isError?: boolean } | undefined;
type Env = {
  sql: ReturnType<typeof postgres>;
  tool: (token: string, name: string, args?: Record<string, unknown>) => Promise<Answer>;
  ownerToken: string; readerToken: string;
  setupSave: (token: string, settings: Record<string, unknown>, password: string) => Promise<Answer>;
  check: (what: string, ok: boolean, seen: unknown) => void;
  USER: string; PASSWORD: string; read: (p: string) => string; files: Map<string, Uint8Array>; actor: string;
  // deno-lint-ignore no-explicit-any
  mcp: (token: string, method: string, params?: Record<string, unknown>) => Promise<any>;
  /** Opens a show_ tool's card as Claude opens it, as mail.ts's openCard does. */
  // deno-lint-ignore no-explicit-any
  openCard: (token: string, show: string, args: Record<string, unknown>) => Promise<any>;
};

const v = (r: Answer) => r?.structuredContent;
const said = (r: Answer) => r?.isError === true ? r.content?.[0]?.text ?? "" : null;
const ok = (r: Answer) => r !== undefined && r.isError !== true;

export async function sendingChecks(e: Env) {
  const { sql, tool, ownerToken, readerToken, setupSave, check, USER, PASSWORD, read } = e;
  const cert = read("cert.pem"), key = read("key.pem");
  // The sign-in as AUTHENTICATE PLAIN sends it, which must never reach a log.
  const SECRET_B64 = btoa(`\u0000${USER}\u0000${PASSWORD}`).replace(/=+$/, "");
  const day = new Date("2026-11-15T09:00:00Z");
  const folders = (): Folder[] => [
    { name: "INBOX", uidValidity: 51, messages: [
      { uid: 1, from: ["Ann Lee", "ann@example.com"], to: ["Harbour", USER], subject: "Invoice please", date: day, messageId: "<ask@example.com>",
        text: "Could you send the invoice for October?\n" },
      // Late in a thread, sent to the mailbox's username and copied to Bob.
      { uid: 2, from: ["Dan Moss", "dan@example.com"], to: ["Harbour", USER], cc: [["Bob", "bob@example.com"]], subject: "Re: Moorings",
        date: day, messageId: "<three@example.com>", references: "<one@example.com>\r\n <two@example.com>", text: "Which berth?\n" },
    ] },
    { name: "Sent", specialUse: "\\Sent", uidValidity: 52, messages: [] },
    { name: "Drafts", specialUse: "\\Drafts", uidValidity: 53, messages: [] },
    { name: "Trash", specialUse: "\\Trash", uidValidity: 54, messages: [] },
  ];
  const box = folders();
  const imap = startFakeImap({ cert, key, user: USER, password: PASSWORD, folders: box, caps: "IMAP4rev1 SPECIAL-USE UIDPLUS MOVE" });
  // A server with neither UIDPLUS nor MOVE, which can take a message out only by expunging every one marked deleted.
  const plain = startFakeImap({ cert, key, user: USER, password: PASSWORD, folders: folders() });
  // A server that closes the connection at the first FETCH, once the inbox is open.
  const dropper = startFakeImap({ cert, key, user: USER, password: PASSWORD, folders: folders(), dropOn: "FETCH" });
  // Run as each message reaches the SMTP server, to change the mailbox while a send is under way.
  let duringSend: (() => void) | undefined;
  const smtp = await startFakeSmtp({ cert, key, user: USER, password: PASSWORD, onData: () => duringSend?.() });
  const other = await startFakeSmtp({ cert, key, user: USER, password: "another password" });
  // A server that starts in plain text and upgrades with STARTTLS.
  const starttls = await startFakeSmtp({ cert, key, user: USER, password: PASSWORD, starttls: true });
  const [drafts, sent, trash] = [box[2], box[1], box[3]];

  // A file in a scope, to attach: its row in storage.objects, and its bytes in the stand-in's Storage.
  await sql`insert into fabrik.scope(code, display_name, description, created_by) values ('mail_files', 'Mail files', 'Stand-in fixture', ${e.actor})`;
  const pdf = new TextEncoder().encode("%PDF-1.4 invoice KIN-2026-002\n");
  await sql`insert into storage.objects(bucket_id, name, owner_id, metadata) values ('mail_files', 'invoices/kin-2026-002.pdf', ${e.actor}, ${sql.json({ mimetype: "application/pdf", size: pdf.length })})`;
  e.files.set("mail_files/invoices/kin-2026-002.pdf", pdf);

  try {
    const SEND = { name: "send", host: "localhost", port: imap.port, username: USER, address: USER, smtp_host: "localhost", smtp_port: smtp.port,
      signature: "Harbour Office\nQuay Street" };
    // ---- Setting up a mailbox that sends ----
    const smtpWrong = await setupSave(ownerToken, { ...SEND, smtp_port: other.port }, PASSWORD);
    const [{ n: afterWrong }] = await sql`select count(*)::int as n from fabrik_private.mailbox where name = 'send'`;
    check("mail_setup_save with an SMTP server that refuses the password answers SMTP: authentication failure, and saves nothing",
      said(smtpWrong) === "SMTP: authentication failure" && afterWrong === 0, smtpWrong);
    const setup = await setupSave(ownerToken, SEND, PASSWORD);
    const draftOnly = await setupSave(ownerToken, { ...SEND, name: "drafts", smtp_host: "" }, PASSWORD);
    const plainSaved = await setupSave(ownerToken, { ...SEND, name: "plain", port: plain.port }, PASSWORD);
    const [row] = await sql`select address, smtp_host, smtp_port, signature from fabrik_private.mailbox where name = 'send'`;
    check("mail_setup_save signs in to IMAP and SMTP, and saves the From address, the SMTP host and port and the signature",
      ok(setup) && ok(draftOnly) && ok(plainSaved) && row?.address === USER && row?.smtp_host === "localhost" && row?.smtp_port === smtp.port
        && row?.signature === "Harbour Office\nQuay Street" && smtp.commands.some((c) => c.startsWith("AUTH")), { setup, draftOnly, plainSaved, row });

    // ---- The card for a mailbox already set up: filled from its saved row ----
    const savedCard = await tool(ownerToken, "show_mail_setup", { name: "drafts" });
    const sendingCard = await tool(ownerToken, "show_mail_setup", { name: "send" });
    check("show_mail_setup given a saved mailbox's name fills the card from its row, hosts included, and from no argument the model gave",
      JSON.stringify(v(savedCard)?.saved) === JSON.stringify({ host: "localhost", smtp_host: null, smtp_port: null }) && v(savedCard)?.username === USER
        && JSON.stringify(v(sendingCard)?.saved) === JSON.stringify({ host: "localhost", smtp_host: "localhost", smtp_port: smtp.port }),
      { savedCard: v(savedCard), sendingCard: v(sendingCard) });
    // A saved mailbox whose From address is at a provider the card knows: its saved servers stay on the card, and the
    // provider's guess doesn't replace them.
    await sql`update fabrik_private.mailbox set address = 'harbour@icloud.com' where name = 'drafts'`;
    const card = await e.openCard(ownerToken, "show_mail_setup", { name: "drafts" });
    for (let i = 0; i < 500 && card.value("ms-username") !== USER; i++) await new Promise((r) => setTimeout(r, 10));
    const shown = { host: card.value("ms-host"), smtp_host: card.value("ms-smtp-host"), smtp_port: card.value("ms-smtp-port"), address: card.value("ms-address") };
    // The person types a reading server the card knows: a mailbox that only reads gets its sending server.
    const host = card.doc.getElementById("ms-host");
    host.value = "imap.fastmail.com";
    host.dispatchEvent(new card.w.Event("input"));
    const typedHost = { smtp_host: card.value("ms-smtp-host"), smtp_port: card.value("ms-smtp-port") };
    card.close();
    await sql`update fabrik_private.mailbox set address = ${USER} where name = 'drafts'`;
    check("the card for a saved mailbox at a provider the card knows keeps the saved servers, not the provider's",
      JSON.stringify(shown) === JSON.stringify({ host: "localhost", smtp_host: "", smtp_port: "465", address: "harbour@icloud.com" }), shown);
    check("on the card for a saved mailbox that only reads, typing a reading server the card knows fills in its sending server",
      JSON.stringify(typedHost) === JSON.stringify({ smtp_host: "smtp.fastmail.com", smtp_port: "465" }), typedHost);
    // A saved mailbox that only reads, at a reading server the card knows, with an address at a domain it doesn't: the
    // card fills in that provider's sending server, and keeps the saved reading server.
    await sql`update fabrik_private.mailbox set host = 'mail.privateemail.com', address = 'office@harbour.example' where name = 'drafts'`;
    const known = await e.openCard(ownerToken, "show_mail_setup", { name: "drafts" });
    for (let i = 0; i < 500 && known.value("ms-username") !== USER; i++) await new Promise((r) => setTimeout(r, 10));
    const offered = { host: known.value("ms-host"), smtp_host: known.value("ms-smtp-host"), smtp_port: known.value("ms-smtp-port") };
    known.close();
    await sql`update fabrik_private.mailbox set host = 'localhost', address = ${USER} where name = 'drafts'`;
    check("the card for a saved mailbox that only reads fills in the sending server of its reading server's provider",
      JSON.stringify(offered) === JSON.stringify({ host: "mail.privateemail.com", smtp_host: "mail.privateemail.com", smtp_port: "465" }), offered);

    // ---- A draft ----
    const MESSAGE = { mailbox: "send", to: ["Ann Lee <ann@example.com>"], cc: ["bob@example.com"], bcc: ["carol@example.com"],
      subject: "Invoice KIN-2026-002", body: "Hello Ann,\n\nThe invoice for October is attached.\n",
      attachments: [{ scope: "mail_files", path: "invoices/kin-2026-002.pdf" }] };
    const made = await tool(ownerToken, "mail_draft", MESSAGE);
    const kept = drafts.messages[0];
    check("mail_draft keeps the draft in Drafts from the From address, with the signature, the Bcc header and the scope's file attached, and sends nothing",
      ok(made) && drafts.messages.length === 1 && v(made)?.draft?.uid === kept?.uid && v(made)?.draft?.uid_validity === "53"
        && /^From: harbour@example\.com\r$/m.test(kept?.raw ?? "") && /^Bcc: carol@example\.com\r$/m.test(kept?.raw ?? "")
        && (kept?.raw ?? "").includes("-- \r\nHarbour Office\r\nQuay Street") && (kept?.raw ?? "").includes('filename=kin-2026-002.pdf')
        && (kept?.flags ?? []).includes("\\Draft") && smtp.sent.length === 0
        && JSON.stringify(v(made)?.attachments) === JSON.stringify([{ filename: "kin-2026-002.pdf", size: pdf.length }]),
      { made, raw: kept?.raw?.slice(0, 1500), sent: smtp.sent.length });
    const listed = await tool(ownerToken, "mail_draft_list", { mailbox: "send" });
    const body = await tool(ownerToken, "mail_fetch_body", { mailbox: "send", folder: "drafts", uid: kept?.uid ?? 0, uid_validity: "53" });
    check("mail_draft_list lists the draft, and mail_fetch_body with folder drafts reads its text and signature",
      ok(listed) && JSON.stringify(v(listed)?.messages?.map((m: { uid: number }) => m.uid)) === JSON.stringify([kept?.uid])
        && v(listed)?.messages?.[0]?.subject === "Invoice KIN-2026-002"
        && ok(body) && /The invoice for October is attached\.\n\n-- \nHarbour Office\nQuay Street/.test(v(body)?.body ?? ""), { listed, body });

    // ---- Editing it ----
    // Each LIST "" "*" the server sees, the whole folder list: imapflow's own LIST "" "" on connecting, for the hierarchy
    // delimiter, is not one.
    const folderLists = () => imap.received.filter((x) => x.command === "LIST" && x.line.includes("*")).length;
    const listsBefore = folderLists();
    const edited = await tool(ownerToken, "mail_draft_edit", { ...MESSAGE, uid: kept?.uid ?? 0, uid_validity: "53", subject: "Invoice KIN-2026-002 for October" });
    const newUid = v(edited)?.draft?.uid;
    const lists = folderLists() - listsBefore;
    check("mail_draft_edit keeps the new draft under a new uid, moves the old one to Trash, and lists the folders once",
      ok(edited) && drafts.messages.length === 1 && drafts.messages[0].uid === newUid && newUid !== kept?.uid
        && drafts.messages[0].subject === "Invoice KIN-2026-002 for October" && smtp.sent.length === 0
        && JSON.stringify(trash.messages.map((m) => m.subject)) === '["Invoice KIN-2026-002"]' && lists === 1,
      { edited, drafts: drafts.messages.map((m) => [m.uid, m.subject]), trash: trash.messages.map((m) => m.subject), lists });

    // ---- Refusals before anything is sent ----
    const stale = await tool(ownerToken, "mail_draft_send", { mailbox: "send", uid: newUid ?? 0, uid_validity: "99" });
    const missing = await tool(ownerToken, "mail_send", { ...MESSAGE, attachments: [{ scope: "mail_files", path: "invoices/none.pdf" }] });
    const reader = await tool(readerToken, "mail_send", MESSAGE);
    const noSmtp = await tool(ownerToken, "mail_send", { ...MESSAGE, mailbox: "drafts" });
    const draftsDraft = await tool(ownerToken, "mail_draft", { ...MESSAGE, mailbox: "drafts", attachments: [] });
    const injected = await tool(ownerToken, "mail_send", { ...MESSAGE, to: ["ann@example.com\r\nBcc: eve@example.com"] });
    const subjectBreak = await tool(ownerToken, "mail_send", { ...MESSAGE, subject: "Invoice\r\nBcc: eve@example.com" });
    const plainEdit = await tool(ownerToken, "mail_draft_edit", { ...MESSAGE, mailbox: "plain", uid: 1, uid_validity: "53" });
    const plainDelete = await tool(ownerToken, "mail_delete", { mailbox: "plain", folder: "inbox", uids: [1], uid_validity: "51" });
    drafts.messages.push({ uid: 900, from: ["Eve", "eve@example.com"], to: ["Ann Lee", "ann@example.com"], subject: "Not ours", date: day,
      messageId: "<eve@example.com>", text: "Pay me.\n", flags: ["\\Draft"] });
    const foreign = await tool(ownerToken, "mail_draft_send", { mailbox: "send", uid: 900, uid_validity: "53" });
    drafts.messages.pop();
    // A draft written in another mail program, to more recipients than a message takes.
    const many = Array.from({ length: 51 }, (_, i) => `r${i}@example.com`).join(", ");
    drafts.messages.push({ uid: 901, from: ["Harbour", USER], to: ["Ann Lee", "ann@example.com"], subject: "Many", date: day,
      messageId: "<many@example.com>", text: "Hello.\n", flags: ["\\Draft"],
      raw: `From: ${USER}\r\nTo: ann@example.com\r\nBcc: ${many}\r\nSubject: Many\r\nMessage-ID: <many@example.com>\r\n\r\nHello.\r\n` });
    const crowded = await tool(ownerToken, "mail_draft_send", { mailbox: "send", uid: 901, uid_validity: "53" });
    drafts.messages.pop();
    check("a stale uid_validity, a file not in the scope, a restricted person, a mailbox with no SMTP host, a line break in a recipient or subject, " +
      "a draft from another address and a draft to over 50 recipients are refused, and nothing is sent",
      /uid_validity is now 53, not 99/.test(said(stale) ?? "") && /invoices\/none\.pdf in Mail files could not be read/.test(said(missing) ?? "")
        && said(reader) === "Only an administrator lists mailboxes" && /has no SMTP host, so it drafts but does not send/.test(said(noSmtp) ?? "")
        && ok(draftsDraft) && said(injected) !== null && said(subjectBreak) !== null
        && /The draft is from eve@example\.com, not the mailbox's From address/.test(said(foreign) ?? "")
        && /The draft has over 50 recipients/.test(said(crowded) ?? "") && smtp.sent.length === 0,
      { stale, missing, reader, noSmtp, draftsDraft, injected, subjectBreak, foreign, crowded, sent: smtp.sent.length });
    // A file over the 20 MB a message takes, refused by its stated length before its bytes are read.
    await sql`insert into storage.objects(bucket_id, name, owner_id, metadata) values ('mail_files', 'big.bin', ${e.actor}, ${sql.json({ mimetype: "application/octet-stream" })})`;
    e.files.set("mail_files/big.bin", new Uint8Array(21 * 1024 * 1024));
    const draftsBefore = drafts.messages.length;
    const big = await tool(ownerToken, "mail_draft", { ...MESSAGE, attachments: [{ scope: "mail_files", path: "big.bin" }] });
    const { withoutBcc } = await import("../../setup/functions/fabrik-apps/mail-send.ts");
    const { Buffer } = await import("node:buffer");
    const stripped = withoutBcc(Buffer.from("From: a@example.com\nBcc: carol@example.com,\n dave@example.com\nSubject: x\n\nBcc: stays in the body\n", "latin1")).toString("latin1");
    check("an attachment over 20 MB is refused, and nothing is kept; withoutBcc takes out a folded Bcc header from LF-only bytes and leaves the body",
      /over 20 MB/.test(said(big) ?? "") && drafts.messages.length === draftsBefore
        && stripped === "From: a@example.com\r\nSubject: x\r\n\r\nBcc: stays in the body\r\n", { big, stripped });
    check("on a server with neither UIDPLUS nor MOVE, mail_draft_edit and mail_delete are refused, and nothing is moved",
      /only by expunging every message marked deleted/.test(said(plainEdit) ?? "") && /only by expunging every message marked deleted/.test(said(plainDelete) ?? "")
        && !plain.received.some((x) => /^(UID )?(STORE|EXPUNGE|MOVE|COPY)/.test(x.command)), { plainEdit, plainDelete });

    // A read from a server that has gone away: the person gets the category, and the function's log gets one line with
    // the address it connected to, how far it got and the error's own words, and never the password.
    // A read that stops after the inbox opens: its log line holds the connection's last commands and replies, up to the
    // FETCH the server dropped, with the sign-in masked.
    const dropSaved = await setupSave(ownerToken, { ...SEND, name: "dropper", port: dropper.port, smtp_host: "" }, PASSWORD);
    const dropLogged: string[] = [];
    const quietDrop = console.error;
    console.error = (...a: unknown[]) => { dropLogged.push(a.map(String).join(" ")); };
    let dropped: Answer;
    try { dropped = await tool(ownerToken, "mail_read", { mailbox: "dropper" }); } finally { console.error = quietDrop; }
    const dropLine = dropLogged.find((l) => l.startsWith("fabrik-apps mail failure "));
    const dropRecord = dropLine ? JSON.parse(dropLine.slice("fabrik-apps mail failure ".length)) : null;
    const protocol: string[] = dropRecord?.protocol ?? [];
    check("a read the server drops after the inbox opens is logged with its stage, folder and last commands, up to the FETCH, the sign-in masked",
      ok(dropSaved) && said(dropped) !== null && dropRecord?.stage === "signed in" && dropRecord?.folder === "INBOX"
        && protocol.some((l) => / C \S+ EXAMINE INBOX/.test(l)) && / C \S+ (UID )?FETCH /.test(protocol.at(-1) ?? "")
        && protocol.some((l) => / C \S+ (LOGIN|AUTHENTICATE)/.test(l)) && !dropLogged.some((l) => l.includes(PASSWORD) || l.includes(SECRET_B64)),
      { dropped, protocol });
    // mail_check reads the newest message once. On a server that answers, it works and brings the message's bytes. On
    // the server that drops a FETCH, it fails, with the FETCH among its last commands.
    const checked = await tool(ownerToken, "mail_check", { mailbox: "send" });
    const failedCheck = await tool(ownerToken, "mail_check", { mailbox: "dropper" });
    const c = v(checked), f = v(failedCheck);
    check("mail_check reads the newest message once, working on a server that answers and failing at the FETCH on one that drops it",
      c?.ok === true && c.bytes > 0 && c.bytes <= 64 * 1024 && typeof c.ms === "number" && !("checks" in (c ?? {}))
        && f?.ok === false && f.failure === "disconnect" && / C \S+ (UID )?FETCH /.test(f.last?.at(-1) ?? "")
        && !JSON.stringify([checked, failedCheck]).includes(PASSWORD), { checked: c, failedCheck: f });
    await plain.close();
    const logged: string[] = [];
    const quiet = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    let lost: Answer;
    try { lost = await tool(ownerToken, "mail_read", { mailbox: "plain" }); } finally { console.error = quiet; }
    const failure = logged.find((l) => l.startsWith("fabrik-apps mail failure "));
    const record = failure ? JSON.parse(failure.slice("fabrik-apps mail failure ".length)) : null;
    check("a read that fails is logged once with the mailbox, the address it connected to, its stage and the error's words, and no password",
      /could not be read: /.test(said(lost) ?? "") && record?.mailbox === "plain" && record?.host === "localhost"
        && /^(127\.0\.0\.1|::1)$/.test(record?.address ?? "") && record?.stage === "connect" && typeof record?.message === "string"
        && record.message.length > 0 && typeof record?.elapsed_ms === "number" && !logged.some((l) => l.includes(PASSWORD)),
      { lost, logged });
    // An error whose words quote the password, the username and the recipients, as a server's reply can.
    const { logFailure } = await import("../../setup/functions/fabrik-apps/mail.ts");
    const quoted: string[] = [];
    console.error = (...a: unknown[]) => { quoted.push(a.map(String).join(" ")); };
    try {
      logFailure({ name: "send", host: "localhost", port: 465, username: USER, password: PASSWORD },
        Object.assign(new Error(`550 rejected for ann@example.com and Bob <bob@example.org>: login ${USER} ${PASSWORD} refused`), { responseText: `no such user carol@example.net` }));
    } finally { console.error = quiet; }
    // A password with a zero-width space, a two-letter username, the sign-in in base64 as AUTH PLAIN sends it, and an
    // address with no dot in its domain.
    const odd = { name: "odd", host: "localhost", port: 465, username: "jo", password: "pa​ss-word" };
    const plainAuth = Buffer.from(`\u0000jo\u0000pa​ss-word`).toString("base64");
    console.error = (...a: unknown[]) => { quoted.push(a.map(String).join(" ")); };
    try { logFailure(odd, new Error(`AUTH PLAIN ${plainAuth} failed for jo with pa​ss-word and pass-word; bounce to root@localhost`)); }
    finally { console.error = quiet; }
    check("a logged failure has the password, the username, the base64 sign-in and every word with an @ taken out of the error's words",
      quoted.length === 2 && !quoted[0].includes(PASSWORD) && !quoted[0].includes(USER) && !/@/.test(quoted.join(" "))
        && quoted[0].includes("550 rejected for <address> and Bob <<address>>")
        && !quoted[1].includes(plainAuth.replace(/=+$/, "")) && !/\bjo\b/.test(quoted[1]) && !quoted[1].includes("pass-word")
        && quoted[1].includes("bounce to <address>"), quoted);
    // A password with " and \, as IMAP's LOGIN escapes it, and 200 KB of reply with no @, which the scrub takes in time
    // that grows with its length alone.
    const escaped = { name: "esc", host: "localhost", port: 993, username: "joan", password: 'pa"ss\\word' };
    const { scrubbed } = await import("../../setup/functions/fabrik-apps/mail.ts");
    const said3 = scrubbed('A1 LOGIN "joan" "pa\\"ss\\\\word" failed', escaped);
    const long = "x".repeat(200_000);
    const t0 = performance.now();
    const longOut = scrubbed(long, escaped);
    const took = performance.now() - t0;
    check("a password IMAP escapes is scrubbed in its escaped form, and 200 KB with no @ is scrubbed in under 100 ms",
      said3 === 'A1 LOGIN "***" "***" failed' && longOut === long && took < 100, { said3, took });
    drafts.messages.splice(0, drafts.messages.length, ...drafts.messages.filter((m) => m.uid === newUid));

    // ---- Sending the draft ----
    const sentDraft = await tool(ownerToken, "mail_draft_send", { mailbox: "send", uid: newUid ?? 0, uid_validity: "53" });
    const out = smtp.sent[0];
    check("mail_draft_send sends the draft with every recipient in the envelope and no Bcc header, files it in Sent, and moves it to Trash",
      ok(sentDraft) && smtp.sent.length === 1 && out?.from === USER
        && JSON.stringify([...(out?.to ?? [])].sort()) === JSON.stringify(["ann@example.com", "bob@example.com", "carol@example.com"])
        && !/^bcc:/im.test(out?.data ?? "") && /^Subject: Invoice KIN-2026-002 for October\r$/m.test(out?.data ?? "")
        && sent.messages.length === 1 && sent.messages[0].messageId === v(sentDraft)?.message_id && drafts.messages.length === 0
        && v(sentDraft)?.sent_copy === "filed in Sent" && v(sentDraft)?.draft === "moved to Trash"
        && trash.messages.length === 2 && trash.messages[1].messageId === v(sentDraft)?.message_id, { sentDraft, out: out?.data?.slice(0, 800), sent: sent.messages.length, drafts: drafts.messages.length });

    // ---- Replying, and moving the reply to Trash ----
    const replied = await tool(ownerToken, "mail_reply", { mailbox: "send", uid: 1, uid_validity: "51", body: "It is on its way.\n" });
    const back = smtp.sent[1];
    check("mail_reply goes to the message's sender, threaded to it with Re: and its Message-ID, with the signature, and is filed in Sent",
      ok(replied) && JSON.stringify(back?.to) === '["ann@example.com"]' && /^Subject: Re: Invoice please\r$/m.test(back?.data ?? "")
        && /^In-Reply-To: <ask@example\.com>\r$/m.test(back?.data ?? "") && /^References: <ask@example\.com>\r$/m.test(back?.data ?? "")
        && (back?.data ?? "").includes("-- \r\nHarbour Office") && sent.messages.length === 2, { replied, back: back?.data?.slice(0, 800) });
    const replyUid = sent.messages[1]?.uid ?? 0;
    const moved = await tool(ownerToken, "mail_delete", { mailbox: "send", folder: "sent", uids: [replyUid], uid_validity: "52" });
    const gone = await tool(ownerToken, "mail_delete", { mailbox: "send", folder: "sent", uids: [replyUid], uid_validity: "52" });
    check("mail_delete moves the reply to Trash, and a uid no longer there is refused",
      ok(moved) && sent.messages.length === 1 && trash.messages.length === 3 && trash.messages[2].messageId === v(replied)?.message_id
        && /No message in Sent has the uid/.test(said(gone) ?? ""), { moved, gone });
    check("the IMAP server saw APPEND and UID MOVE, and never an EXPUNGE: every message taken out of a folder went to Trash",
      ["APPEND", "UID MOVE"].every((c) => imap.received.some((x) => x.command === c))
        && !imap.received.some((x) => /EXPUNGE/.test(x.command)), [...new Set(imap.received.map((x) => x.command))]);

    // ---- A reply late in a thread, from a mailbox whose From address is not its username ----
    const alias = await setupSave(ownerToken, { ...SEND, name: "alias", address: "office@example.com" }, PASSWORD);
    const all = await tool(ownerToken, "mail_reply", { mailbox: "alias", uid: 2, uid_validity: "51", body: "Berth 4.\n", reply_all: true });
    const late = smtp.sent[smtp.sent.length - 1];
    check("mail_reply keeps the thread's References and adds the message's, and reply_all leaves out the mailbox's own username",
      ok(alias) && ok(all) && /^References: <one@example\.com> <two@example\.com> <three@example\.com>\r$/m.test(late?.data ?? "")
        && /^In-Reply-To: <three@example\.com>\r$/m.test(late?.data ?? "") && JSON.stringify(v(all)?.to) === '["dan@example.com"]'
        && JSON.stringify(v(all)?.cc) === '["bob@example.com"]' && /^From: office@example\.com\r$/m.test(late?.data ?? ""),
      { alias, all, late: late?.data?.slice(0, 600) });

    // ---- A failure once the message has gone ----
    const left = await tool(ownerToken, "mail_draft", { ...MESSAGE, attachments: [], subject: "Mooring fees" });
    const sentBefore = smtp.sent.length;
    duringSend = () => { drafts.uidValidity = 60; };
    const afterOut = await tool(ownerToken, "mail_draft_send", { mailbox: "send", uid: v(left)?.draft?.uid ?? 0, uid_validity: "53" });
    duringSend = undefined;
    drafts.uidValidity = 53;
    check("mail_draft_send whose Drafts folder changes while SMTP takes the message answers that it was sent and the draft left in Drafts, not a refusal",
      ok(afterOut) && smtp.sent.length === sentBefore + 1 && v(afterOut)?.sent_copy === "filed in Sent"
        && /^sent, but left in Drafts: The folder's uid_validity is now 60, not 53/.test(v(afterOut)?.draft ?? "") && drafts.messages.length === 1,
      { afterOut, sent: smtp.sent.length - sentBefore });

    // ---- Signatures in HTML ----
    // A signature as a whole page, its typography on its table, its <body> styled with layout alone.
    const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Harbour signature</title></head><body style="margin:0;padding:24px;">\n' +
      '<table style="border-collapse:collapse;font-family:Inter,Arial,sans-serif;color:#0b0b0b;"><tr><td>' +
      '<div style="font-size:15px;">Ann Lee</div><div>Harbour Office<br>Quay Street</div></td></tr></table>\n</body></html>';
    const branded = await setupSave(ownerToken, { ...SEND, name: "branded", signature: "" }, PASSWORD);
    const scripted = await tool(ownerToken, "mail_signature_set", { mailbox: "branded", html: '<div onclick="x()">Ann</div>' });
    const scriptTag = await tool(ownerToken, "mail_signature_set", { mailbox: "branded", text: "Ann", html: "<div>Ann</div><script>x()</script>" });
    const linked = await tool(ownerToken, "mail_signature_set", { mailbox: "branded", html: '<a href="JavaScript:x()">Ann</a>' });
    const empty = await tool(ownerToken, "mail_signature_set", { mailbox: "branded" });
    const encoded = await tool(ownerToken, "mail_signature_set", { mailbox: "branded", html: '<a href="java&#x09;script&#58;x()">Ann</a>' });
    const framed = await tool(ownerToken, "mail_signature_set", { mailbox: "branded", html: '<html><head></head><body><meta http-equiv="refresh" content="0;url=https://example.com"></body></html>' });
    const [unsigned] = await sql`select signature, signature_html from fabrik_private.mailbox where name = 'branded'`;
    check("mail_signature_set refuses an HTML signature with an on…= attribute, a script or a javascript: address, and a call with neither part, and stores nothing",
      ok(branded) && /on…= attribute/.test(said(scripted) ?? "") && /a script/.test(said(scriptTag) ?? "") && /javascript: address/.test(said(linked) ?? "")
        && /Give text, html or both/.test(said(empty) ?? "") && /javascript: address/.test(said(encoded) ?? "") && /loads or runs another page/.test(said(framed) ?? "")
        && unsigned?.signature === null && unsigned?.signature_html === null,
      { branded, scripted, scriptTag, linked, empty, encoded, framed, unsigned });
    // A signature written straight to the table, not through mail_signature_set, is refused when a draft is made.
    await sql`update fabrik_private.mailbox set signature_html = '<div onmouseover="x()">Ann</div>' where name = 'branded'`;
    const keptBefore = drafts.messages.length;
    const storedBad = await tool(ownerToken, "mail_draft", { ...MESSAGE, mailbox: "branded", attachments: [] });
    await sql`update fabrik_private.mailbox set signature_html = null where name = 'branded'`;
    check("a draft from a mailbox whose stored HTML signature holds an on…= attribute is refused, and nothing is kept",
      /HTML signature holds an on…= attribute, so nothing is drafted or sent/.test(said(storedBad) ?? "") && drafts.messages.length === keptBefore, storedBad);
    const setSig = await tool(ownerToken, "mail_signature_set", { mailbox: "branded", text: "Ann Lee\nHarbour Office", html: PAGE });
    const listedSig = await tool(ownerToken, "mail_list_mailboxes", {});
    check("mail_signature_set stores both signatures, and mail_list_mailboxes gives the HTML one",
      ok(setSig) && v(setSig)?.signature === "Ann Lee\nHarbour Office" && v(setSig)?.signature_html === PAGE
        && v(listedSig)?.items?.find((x: { name: string }) => x.name === "branded")?.signature_html === PAGE, { setSig });
    const { simpleParser } = await import("npm:mailparser@3.9.12");
    const before = drafts.messages.length;
    const htmlDraft = await tool(ownerToken, "mail_draft", { ...MESSAGE, mailbox: "branded", attachments: [], body: "Hello Ann,\n\nThe <invoice> is attached.\nThanks\n" });
    const rawHtml = drafts.messages[drafts.messages.length - 1]?.raw ?? "";
    const parsedHtml = await simpleParser(rawHtml);
    const html = String(parsedHtml.html || "");
    check("a draft from a mailbox with an HTML signature is multipart/alternative: the plain part with the plain signature, the HTML part with " +
      "the body in the signature's typography and the HTML signature, and neither with the other's signature",
      ok(htmlDraft) && drafts.messages.length === before + 1 && /^Content-Type: multipart\/alternative/m.test(rawHtml)
        && parsedHtml.text === "Hello Ann,\n\nThe <invoice> is attached.\nThanks\n\n-- \nAnn Lee\nHarbour Office\n"
        && html.startsWith('<div style="font-family:Inter,Arial,sans-serif;color:#0b0b0b"><p>Hello Ann,</p><p>The &lt;invoice&gt; is attached.<br>Thanks</p>')
        && html.includes('<table style="border-collapse:collapse;') && !/<title|<body|padding:24px/.test(html) && !html.includes("-- "),
      { htmlDraft, text: parsedHtml.text, html });
    const htmlOnly = await tool(ownerToken, "mail_signature_set", { mailbox: "branded", text: "" });
    const htmlOnlySent = await tool(ownerToken, "mail_send", { ...MESSAGE, mailbox: "branded", attachments: [], body: "Hello Ann.\n" });
    const parsedOnly = await simpleParser(smtp.sent[smtp.sent.length - 1]?.data ?? "");
    check("with an HTML signature and no plain one, a sent message's plain part carries the HTML signature's text, a line for each line it shows",
      ok(htmlOnly) && v(htmlOnly)?.signature === null && v(htmlOnly)?.signature_html === PAGE && ok(htmlOnlySent)
        && parsedOnly.text === "Hello Ann.\n\n-- \nAnn Lee\nHarbour Office\nQuay Street\n" && String(parsedOnly.html || "").includes("<table"),
      { htmlOnly, text: parsedOnly.text });
    // Markup a browser reads differently from a simple pattern: a > inside a quoted value, a comment closed at once by
    // <!-->, a tag left open at the end, and a data: address.
    const quotedGt = await tool(ownerToken, "mail_signature_set", { mailbox: "branded", html: '<img alt=">" onerror="x()" src="https://example.com/a.png">' });
    const abrupt = await tool(ownerToken, "mail_signature_set", { mailbox: "branded", html: '<!--><img src="https://example.com/a.png" onerror="x()">-->' });
    const open = await tool(ownerToken, "mail_signature_set", { mailbox: "branded", html: '<div>Ann</div><img src="https://example.com/a.png" alt="Ann' });
    const dataLink = await tool(ownerToken, "mail_signature_set", { mailbox: "branded", html: '<a href="data:text/html,hi">Ann</a>' });
    const [stillPage] = await sql`select signature_html from fabrik_private.mailbox where name = 'branded'`;
    check("mail_signature_set refuses an on…= attribute after a quoted >, one hidden behind <!-->, a tag left open and a data: address, and keeps the stored signature",
      /on…= attribute/.test(said(quotedGt) ?? "") && /on…= attribute/.test(said(abrupt) ?? "") && /left open/.test(said(open) ?? "")
        && /data: address/.test(said(dataLink) ?? "") && stillPage?.signature_html === PAGE,
      { quotedGt, abrupt, open, dataLink });
    // A whole page whose <head> holds a script and the styles its body's classes use, and whose root is styled in single quotes.
    const STYLED = "<html><head><script>track()</script><style>.n{color:#c00}</style></head>" +
      "<body onload=\"track()\"><!-- signature --><div style='font-family:Georgia;color:#123456'><span class=\"n\">Ann Lee</span></div></body></html>";
    const styled = await tool(ownerToken, "mail_signature_set", { mailbox: "branded", html: STYLED });
    const styledDraft = await tool(ownerToken, "mail_draft", { ...MESSAGE, mailbox: "branded", attachments: [], body: "Hello Ann,\n \nThe list:\n  one\n\tthree\n" });
    const styledHtml = String((await simpleParser(drafts.messages[drafts.messages.length - 1]?.raw ?? "")).html || "");
    check("a signature page's head styles go with its body and its script stays out, its single-quoted root type styles the text, and a blank line of spaces starts a paragraph",
      ok(styled) && ok(styledDraft) && styledHtml.startsWith('<div style="font-family:Georgia;color:#123456"><p>Hello Ann,</p><p>The list:<br>&nbsp; one<br>&nbsp; &nbsp; three</p>')
        && styledHtml.includes("<style>.n{color:#c00}</style>") && styledHtml.includes('<span class="n">Ann Lee</span>') && !/track\(\)|<script|onload/.test(styledHtml),
      { styled, styledDraft, styledHtml });
    check("a mailbox with no HTML signature drafts and sends plain text, with no HTML part",
      !/text\/html/i.test(kept?.raw ?? "") && !/text\/html/i.test(back?.data ?? "") && /^Content-Type: text\/plain/m.test(back?.data ?? ""),
      { back: back?.data?.slice(0, 600) });

    // ---- The SMTP ports that upgrade with STARTTLS ----
    const { STARTTLS_PORTS, limits } = await import("../../setup/functions/fabrik-apps/mail.ts");
    const modes = Object.fromEntries([465, 587, 25, 2525, 4465].map((port) => [port, STARTTLS_PORTS.has(port) ? "starttls" : "implicit"]));
    check("SMTP on 587, 25 and 2525 upgrades with STARTTLS, and on 465 or any other port uses implicit TLS",
      JSON.stringify(modes) === JSON.stringify({ 25: "starttls", 465: "implicit", 587: "starttls", 2525: "starttls", 4465: "implicit" }), modes);

    // ---- Over Deno's own TLS ----
    // The fake STARTTLS server's port is taken as one that upgrades with STARTTLS, for this check alone. So
    // mail_setup_save and mail_send go through Deno.connect and Deno.startTls, and sign in once the connection is TLS.
    // Deno's own connections are counted as they open. A read and an implicit TLS send each open theirs with
    // Deno.connectTls. A STARTTLS send upgrades with Deno.startTls.
    const opened = { connectTls: 0, startTls: 0 };
    const deno = Deno as unknown as Record<"connectTls" | "startTls", (...a: unknown[]) => unknown>;
    const real = { connectTls: deno.connectTls, startTls: deno.startTls };
    for (const k of ["connectTls", "startTls"] as const) deno[k] = (...a: unknown[]) => { opened[k]++; return real[k].apply(Deno, a); };
    STARTTLS_PORTS.add(starttls.port);
    let upgraded: Answer, upgradedSend: Answer, readOver: Answer, sentOver: Answer;
    const counts: Record<string, typeof opened> = {};
    try {
      readOver = await tool(ownerToken, "mail_read", { mailbox: "send" });
      counts.read = { ...opened };
      sentOver = await tool(ownerToken, "mail_send", { mailbox: "send", to: ["ann@example.com"], subject: "Over TLS", body: "Sent over implicit TLS." });
      counts.sent = { ...opened };
      upgraded = await setupSave(ownerToken, { ...SEND, name: "upgrade", smtp_port: starttls.port }, PASSWORD);
      upgradedSend = await tool(ownerToken, "mail_send", { mailbox: "upgrade", to: ["ann@example.com"], subject: "Over STARTTLS", body: "Sent after STARTTLS." });
      counts.upgraded = { ...opened };
    } finally {
      STARTTLS_PORTS.delete(starttls.port);
      deno.connectTls = real.connectTls;
      deno.startTls = real.startTls;
    }
    check("mail_read and mail_send connect with Deno.connectTls, and a STARTTLS send upgrades with Deno.startTls",
      ok(readOver) && ok(sentOver) && counts.read.connectTls === 1 && counts.read.startTls === 0
        && counts.sent.connectTls >= 2 && counts.sent.startTls === 0 && counts.upgraded.startTls >= 2, counts);
    const plainCommands = starttls.commands.slice(0, starttls.commands.indexOf("STARTTLS"));
    check("SMTP with STARTTLS upgrades over Deno.startTls, then signs in and sends over TLS alone",
      ok(upgraded) && ok(upgradedSend) && starttls.commands.includes("STARTTLS")
        && plainCommands.every((x) => /^(EHLO|STARTTLS)/.test(x)) && starttls.commands.some((x) => /^AUTH .* \(TLS\)$/.test(x))
        && starttls.sent.length === 1 && /Sent after STARTTLS\./.test(starttls.sent[0].data),
      { upgraded, upgradedSend, commands: starttls.commands });

    // A name that passes the look-up and then reaches a loopback address. FABRIK_MAIL_LOOPBACK is taken away once each
    // connection is made, after the look-up allowed it. mail_read, mail_send over implicit TLS
    // and mail_send over STARTTLS are each refused, and each server is sent nothing.
    const env = Deno.env;
    const after: Record<string, (...a: unknown[]) => unknown> = {};
    for (const k of ["connect", "connectTls"]) {
      after[`real${k}`] = (Deno as unknown as Record<string, (...a: unknown[]) => unknown>)[k];
      (Deno as unknown as Record<string, unknown>)[k] = async (...a: unknown[]) => {
        const conn = await after[`real${k}`].apply(Deno, a);
        env.delete("FABRIK_MAIL_LOOPBACK");
        return conn;
      };
    }
    const beforeRebound = { imap: imap.received.length, smtp: smtp.commands.length, starttls: starttls.commands.length };
    const rebound: Record<string, Answer> = {};
    STARTTLS_PORTS.add(starttls.port);
    try {
      for (const [name, call] of [
        ["read", () => tool(ownerToken, "mail_read", { mailbox: "send" })],
        ["implicit", () => tool(ownerToken, "mail_send", { mailbox: "send", to: ["ann@example.com"], subject: "Moved", body: "Never sent." })],
        ["starttls", () => tool(ownerToken, "mail_send", { mailbox: "upgrade", to: ["ann@example.com"], subject: "Moved", body: "Never sent." })],
      ] as const) {
        env.set("FABRIK_MAIL_LOOPBACK", "allow");
        rebound[name] = await call();
      }
    } finally {
      STARTTLS_PORTS.delete(starttls.port);
      for (const k of ["connect", "connectTls"]) (Deno as unknown as Record<string, unknown>)[k] = after[`real${k}`];
      env.set("FABRIK_MAIL_LOOPBACK", "allow");
    }
    const refusedAll = Object.values(rebound).every((r) => /private or local address/.test(said(r) ?? ""));
    check("a host that reaches a loopback address after its look-up is refused once connected by mail_read and by mail_send over implicit TLS and STARTTLS, and no server is sent anything",
      refusedAll && imap.received.length === beforeRebound.imap && smtp.commands.length === beforeRebound.smtp
        && starttls.commands.length === beforeRebound.starttls, { rebound, beforeRebound });

    // A server that takes the connection and never answers: the TLS handshake, or the greeting before STARTTLS, never
    // comes. Each fails as a timeout within limits.timeout, and the connection is closed.
    const silent = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const silentPort = (silent.addr as Deno.NetAddr).port;
    let silentV6: Deno.Listener | undefined;
    try { silentV6 = Deno.listen({ hostname: "::1", port: silentPort }); } catch { /* 127.0.0.1 alone */ }
    const closedByClient: Promise<string>[] = [];
    const accepted: Deno.Conn[] = [];
    for (const l of [silent, silentV6]) {
      if (!l) continue;
      (async () => {
        for await (const conn of l) {
          accepted.push(conn);
          closedByClient.push((async () => { const b = new Uint8Array(1024); try { while (await conn.read(b) !== null); } catch { /* reset */ } try { conn.close(); } catch { /* closed */ } return "closed"; })());
        }
      })().catch(() => {});
    }
    const timeout = limits.timeout;
    limits.timeout = 300;
    const timedOut: Record<string, Answer> = {};
    const silentTook: Record<string, number> = {};
    try {
      for (const [name, starts] of [["implicit", false], ["starttls", true]] as const) {
        if (starts) STARTTLS_PORTS.add(silentPort);
        const started = Date.now();
        try { timedOut[name] = await setupSave(ownerToken, { ...SEND, name: `silent_${name}`, smtp_port: silentPort }, PASSWORD); }
        finally { STARTTLS_PORTS.delete(silentPort); }
        silentTook[name] = Date.now() - started;
      }
    } finally { limits.timeout = timeout; }
    // Deno keeps the implicit TLS connection open while its handshake is under way, so the plain one alone is awaited.
    const plainClosed = await Promise.race([closedByClient[1], new Promise((r) => setTimeout(() => r("open"), 2000))]);
    silent.close(); silentV6?.close();
    // The server's side closed, which ends the handshake Deno keeps open.
    for (const conn of accepted) { try { conn.close(); } catch { /* closed */ } }
    check("an SMTP server that never answers the TLS handshake, or the greeting before STARTTLS, fails as a timeout, and the plain connection is closed",
      said(timedOut.implicit) === "SMTP: timeout" && said(timedOut.starttls) === "SMTP: timeout" && silentTook.implicit < 3000 && silentTook.starttls < 3000
        && closedByClient.length === 2 && plainClosed === "closed", { timedOut, silentTook, connections: closedByClient.length, plainClosed });
  } finally {
    await imap.close();
    await plain.close();
    await dropper.close();
    await smtp.close();
    await other.close();
    await starttls.close();
  }
}
