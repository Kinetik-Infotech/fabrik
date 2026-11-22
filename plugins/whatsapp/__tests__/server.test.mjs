// The plugin's server, started as Claude starts it and called tool by tool: link by code, check, check again, unlink.
// Only WhatsApp's side is a stand-in (hooks.mjs); fabrik's sign-in, scopes and Storage calls go over HTTP to a stand-in
// project, through the same code a real check uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./client.mjs";
import { dm, savedSignIn, standInFabrik } from "./stand-ins.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MESSAGES = [
  dm("A1", "Are we still on for the 23rd?\nLet me know by Friday."),
  dm("A2", "Yes, see you then", { fromMe: true, at: 1795000100 }),
  { key: { id: "G1", remoteJid: "120363000000000001@g.us", participant: "447222000222@s.whatsapp.net", fromMe: false }, message: { imageMessage: { caption: "the cake" } }, pushName: "Sam", messageTimestamp: 1795000200 },
  { key: { id: "D1", remoteJid: "99988877766655@lid", remoteJidAlt: "447333000333@s.whatsapp.net", fromMe: false }, message: { documentMessage: { fileName: "invoice.pdf" } }, pushName: "Lee", messageTimestamp: 1795086400 },
  { key: { id: "S1", remoteJid: "447111000111@s.whatsapp.net", fromMe: false }, message: { stickerMessage: {} }, pushName: "Kate", messageTimestamp: 1795000300 },
  { key: { id: "B1", remoteJid: "status@broadcast", fromMe: false }, message: { conversation: "a status" }, messageTimestamp: 1795000300 },
];

async function setUp() {
  const home = mkdtempSync(join(tmpdir(), "wa-home-"));
  const fabrik = await standInFabrik();
  const { email } = savedSignIn(home, fabrik.url);
  const messages = join(home, "messages.json");
  const calls = join(home, "calls.jsonl");
  writeFileSync(messages, "[]");
  writeFileSync(calls, "");
  const server = startServer({ HOME: home, FABRIK_SESSION_FOLDER: home, TZ: "Europe/London", WHATSAPP_TEST_HOOKS: join(HERE, "hooks.mjs"), WHATSAPP_TEST_MESSAGES: messages, WHATSAPP_TEST_CALLS: calls });
  await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  return {
    home, fabrik, server, keys: join(home, ".config", "fabrik", "whatsapp", email),
    queue: list => writeFileSync(messages, JSON.stringify(list)),
    calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)),
    async end() { await server.stop(); await fabrik.close(); },
  };
}

test("link by code, check, check again and unlink, as the person does them", async () => {
  const t = await setUp();
  try {
    const { request, tool } = t.server;
    const tools = (await request("tools/list", {})).result.tools.map(x => x.name);
    assert.deepEqual(tools, ["whatsapp_status", "whatsapp_link", "whatsapp_link_wait", "whatsapp_check", "whatsapp_unlink"]);

    assert.match((await tool("whatsapp_status")).text, /^WhatsApp isn't linked on this computer\.$/m);
    const early = await tool("whatsapp_check");
    assert.equal(early.isError, true);
    assert.match(early.text, /isn't linked/);

    const link = await tool("whatsapp_link", { phone: "+44 7700 900123" });
    assert.match(link.text, /^Code: ABCD-1234$/m);
    assert.match(link.text, /Link with phone number instead/);
    assert.match((await tool("whatsapp_link_wait")).text, /^WhatsApp is linked as \+447700900123\./);
    assert.match((await tool("whatsapp_status")).text, /^WhatsApp is linked as \+447700900123\.$/m);

    t.queue(MESSAGES);
    const check = await tool("whatsapp_check");
    assert.equal(check.isError, false);
    assert.equal(check.text, "Saved in My notes (me_private):\n- whatsapp/Kate.md: 2 new\n- whatsapp/Family.md: 1 new\n- whatsapp/Lee.md: 1 new");
    assert.equal(t.fabrik.files.get("me_private/whatsapp/Kate.md"), [
      "# WhatsApp: Kate (+447111000111)", "", "## 2026-11-18", "",
      "- 11:06 **Kate:** Are we still on for the 23rd? <!-- wa:A1 -->", "  Let me know by Friday.",
      "- 11:08 **Me:** Yes, see you then <!-- wa:A2 -->", "",
    ].join("\n"));
    assert.equal(t.fabrik.files.get("me_private/whatsapp/Family.md"), "# WhatsApp group: Family\n\n## 2026-11-18\n\n- 11:10 **Sam:** [photo] the cake <!-- wa:G1 -->\n");
    assert.equal(t.fabrik.files.get("me_private/whatsapp/Lee.md"), "# WhatsApp: Lee (+447333000333)\n\n## 2026-11-19\n\n- 11:06 **Lee:** [document] invoice.pdf <!-- wa:D1 -->\n");
    assert.ok(t.fabrik.uploads.every(u => u.type === "text/markdown"));

    // The same messages again leave every file as it was, and upload nothing.
    const uploads = t.fabrik.uploads.length;
    const again = await tool("whatsapp_check");
    assert.equal(again.text, "No new messages.");
    assert.equal(t.fabrik.uploads.length, uploads);

    // The keys folder is the person's alone.
    assert.equal(statSync(t.keys).mode & 0o777, 0o700);
    for (const f of readdirSync(t.keys)) assert.equal(statSync(join(t.keys, f)).mode & 0o077, 0, f);

    const unlink = await tool("whatsapp_unlink");
    assert.match(unlink.text, /^WhatsApp dropped this device, and the keys folder is deleted\./);
    assert.equal(existsSync(t.keys), false);
    await tool("whatsapp_status");
    assert.equal(existsSync(t.keys), false, "status leaves no keys folder behind");

    const calls = t.calls();
    assert.ok(calls.filter(c => c.op === "connect").every(c => c.markOnlineOnConnect === false && c.syncFullHistory === false));
    assert.deepEqual(calls.filter(c => c.op === "pairing-code"), [{ op: "pairing-code", digits: "447700900123" }]);
    assert.equal(calls.filter(c => c.op === "logout").length, 1);
    assert.equal(calls.filter(c => c.op === "connect").length, calls.filter(c => c.op === "end").length, "every connection is closed");
    assert.ok(t.server.lines.every(line => { try { JSON.parse(line); return true; } catch { return false; } }), "stdout carries JSON-RPC alone");
  } finally { await t.end(); }
});

test("messages taken while fabrik refuses wait on the computer, and the next check saves them", async () => {
  const t = await setUp();
  try {
    const { tool } = t.server;
    await tool("whatsapp_link", { phone: "+447700900123" });
    await tool("whatsapp_link_wait");
    // fabrik refuses the sign-in: the token no longer matches.
    const session = join(t.home, ".config", "supabase-auth", "abcdefghijklmnopqrst", "pat@example.com.json");
    const saved = JSON.parse(readFileSync(session, "utf8"));
    writeFileSync(session, JSON.stringify({ ...saved, accessToken: "token-old" }), { mode: 0o600 });
    t.queue([dm("A1", "first")]);
    const refused = await tool("whatsapp_check");
    assert.equal(refused.isError, true);
    assert.match(refused.text, /The messages weren't saved in fabrik/);
    assert.match(refused.text, /^1 message wait on this computer to be saved at the next check\.$/m);
    assert.equal(t.fabrik.files.size, 0);

    // WhatsApp hands over nothing more: the message is only on this computer now.
    writeFileSync(session, JSON.stringify(saved), { mode: 0o600 });
    t.queue([]);
    const later = await tool("whatsapp_check");
    assert.equal(later.text, "Saved in My notes (me_private):\n- whatsapp/Kate.md: 1 new");
    assert.match(t.fabrik.files.get("me_private/whatsapp/Kate.md"), /\*\*Kate:\*\* first <!-- wa:A1 -->/);
  } finally { await t.end(); }
});
