// How chats and senders are named: the plugin's server started as Claude starts it, a stand-in phone, and a stand-in
// fabrik whose Storage refuses a key as Supabase Storage does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./client.mjs";
import { dm, savedSignIn, standInFabrik } from "./stand-ins.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECENT = 3, PUSH_NAME = 4;
const ME = "447700900123@s.whatsapp.net";
const MY_LID = "151333290147945@lid";
const group = (id, jid, text, { from, participant, at = 1795000000 } = {}) =>
  ({ key: { id, remoteJid: jid, participant, fromMe: false }, message: { conversation: text }, ...(from ? { pushName: from } : {}), messageTimestamp: at });
const mine = (id, jid, text, at = 1795000000) => ({ key: { id, remoteJid: jid, fromMe: true }, message: { conversation: text }, pushName: "Pat", messageTimestamp: at });

async function setUp({ history = [], groups = { "120363000000000001@g.us": "Family" } } = {}) {
  const home = mkdtempSync(join(tmpdir(), "wa-names-"));
  const fabrik = await standInFabrik();
  const { email } = savedSignIn(home, fabrik.url);
  const files = { messages: join(home, "messages.json"), history: join(home, "history.json"), calls: join(home, "calls.jsonl"), groups: join(home, "groups.json") };
  writeFileSync(files.messages, "[]");
  writeFileSync(files.history, JSON.stringify(history));
  writeFileSync(files.calls, "");
  writeFileSync(files.groups, JSON.stringify(groups));
  const server = startServer({
    HOME: home, FABRIK_SESSION_FOLDER: home, TZ: "Europe/London", WHATSAPP_TEST_HOOKS: join(HERE, "hooks.mjs"),
    WHATSAPP_TEST_MESSAGES: files.messages, WHATSAPP_TEST_HISTORY: files.history, WHATSAPP_TEST_CALLS: files.calls,
    WHATSAPP_TEST_GROUPS: files.groups, WHATSAPP_TEST_HISTORY_QUIET_MS: "400",
  });
  await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  const t = {
    fabrik, server, keys: join(home, ".config", "fabrik", "whatsapp", email),
    queue: list => writeFileSync(files.messages, JSON.stringify(list)),
    nameGroups: names => writeFileSync(files.groups, JSON.stringify(names)),
    saved: () => [...fabrik.files.keys()].filter(k => k.startsWith("me_private/whatsapp/")).map(k => k.slice("me_private/".length)).sort(),
    file: name => fabrik.files.get(`me_private/whatsapp/${name}`),
    check: async () => (await server.tool("whatsapp_check")).text,
    async link(withHistory = false) {
      await server.tool("whatsapp_link", { phone: "+447700900123", history: withHistory });
      return server.tool("whatsapp_link_wait");
    },
    async end() { await server.stop(); await fabrik.close(); },
  };
  return t;
}

test("a chat whose name Storage refuses is saved under a name it takes, the full name in its first line, and stays there", async () => {
  const sceptics = "120363000000000002@g.us";
  const social = "120363000000000003@g.us";
  const t = await setUp({ groups: { [sceptics]: "The Sceptics’ Sceptics", [social]: "Social Club🥂 Freedom Group" } });
  try {
    await t.link();
    // The keys folder from before the fix: the chat is already given a name Storage refused.
    writeFileSync(join(t.keys, "chats.json"), JSON.stringify({ [sceptics]: "whatsapp/The Sceptics’ Sceptics.md" }));
    t.queue([group("S1", sceptics, "hello", { from: "Ann", participant: "447111000111@s.whatsapp.net" }), group("C1", social, "cheers", { from: "Bo", participant: "447222000222@s.whatsapp.net" })]);
    const first = await t.check();
    assert.doesNotMatch(first, /wasn't saved|waits? on this computer/, first);
    assert.deepEqual(t.saved(), ["whatsapp/Social Club Freedom Group.md", "whatsapp/The Sceptics' Sceptics.md"]);
    assert.match(t.file("The Sceptics' Sceptics.md"), /^# WhatsApp group: The Sceptics’ Sceptics\n/);
    assert.match(t.file("Social Club Freedom Group.md"), /^# WhatsApp group: Social Club🥂 Freedom Group\n/);

    t.queue([group("S2", sceptics, "again", { from: "Ann", participant: "447111000111@s.whatsapp.net", at: 1795000100 })]);
    assert.equal(await t.check(), "Saved in My notes (me_private):\n- whatsapp/The Sceptics' Sceptics.md: 1 new");
    assert.match(t.file("The Sceptics' Sceptics.md"), /wa:S1 [\s\S]*wa:S2 /);
  } finally { await t.end(); }
});

test("a sender WhatsApp names by a LID is shown by name or phone number, and never with the LID as a number", async () => {
  const family = "120363000000000001@g.us";
  // Robin is named by history's contacts and push names; Sam's number is in Baileys' own store of LIDs (hooks.mjs);
  // Ali gave a name in one message and none in the next; nothing names the last sender.
  const t = await setUp({
    history: [
      { syncType: PUSH_NAME, chats: [], messages: [], contacts: [{ id: "55555555555555@lid", notify: "Robin" }] },
      { syncType: RECENT, progress: 100, chats: [{ id: family }], messages: [group("H1", family, "from history", { participant: "55555555555555@lid", at: 1794990000 })] },
    ],
  });
  try {
    await t.link(true);
    t.queue([
      group("A1", family, "hi", { from: "Ali", participant: "44444444444444@lid", at: 1795000000 }),
      group("M1", family, "Sam here", { participant: "88888888888888@lid", at: 1795000010 }),
    ]);
    await t.check();
    t.queue([
      group("A2", family, "me again", { participant: "44444444444444@lid", at: 1795000020 }),
      group("U1", family, "who am I", { participant: "66666666666666@lid", at: 1795000030 }),
    ]);
    await t.check();
    const text = t.file("Family.md");
    assert.match(text, /\*\*Robin:\*\* from history /);
    assert.match(text, /\*\*Ali:\*\* hi /);
    assert.match(text, /\*\*Ali:\*\* me again /);
    assert.match(text, /\*\*\+447222000222:\*\* Sam here /);
    assert.match(text, /\*\*Unknown \(WhatsApp id 66666666666666\):\*\* who am I /);
    assert.doesNotMatch(text, /\+(55555555555555|44444444444444|88888888888888|66666666666666)/);
  } finally { await t.end(); }
});

test("the person's chat with themself is one file, named by their number once", async () => {
  const t = await setUp();
  try {
    await t.link();
    // WhatsApp names the chat by the person's number in one message and by their own LID in the next.
    t.queue([mine("N1", ME, "note to self"), mine("N2", MY_LID, "another", 1795000100)]);
    await t.check();
    assert.deepEqual(t.saved(), ["whatsapp/+447700900123.md"]);
    assert.match(t.file("+447700900123.md"), /wa:N1 [\s\S]*wa:N2 /);
  } finally { await t.end(); }
});

test("a chat with themself already saved in two files is joined into the one named once", async () => {
  const t = await setUp();
  try {
    await t.link();
    // The keys folder and fabrik before the fix: the LID took the plain name, and the number took the doubled one.
    mkdirSync(t.keys, { recursive: true });
    writeFileSync(join(t.keys, "chats.json"), JSON.stringify({ [MY_LID]: "whatsapp/+447700900123.md", [ME]: "whatsapp/+447700900123 447700900123.md" }));
    t.fabrik.files.set("me_private/whatsapp/+447700900123.md", `# WhatsApp: +447700900123\n<!-- wa-chat:${MY_LID} -->\n\n## 2026-11-17\n\n- 09:00 **Me:** old one <!-- wa:O1 -->\n`);
    t.fabrik.files.set("me_private/whatsapp/+447700900123 447700900123.md", `# WhatsApp: +447700900123\n<!-- wa-chat:${ME} -->\n\n## 2026-11-17\n\n- 10:00 **Me:** old two <!-- wa:O2 -->\n`);
    t.queue([mine("N1", ME, "new")]);
    const report = await t.check();
    assert.match(report, /^- whatsapp\/\+447700900123 447700900123\.md was the same chat as whatsapp\/\+447700900123\.md\. Its messages are now in whatsapp\/\+447700900123\.md too, so it can be deleted\.$/m);
    assert.match(t.file("+447700900123.md"), /wa:O1 [\s\S]*wa:O2 [\s\S]*wa:N1 /);
    t.queue([mine("N2", ME, "newer", 1795000100)]);
    assert.equal(await t.check(), "Saved in My notes (me_private):\n- whatsapp/+447700900123.md: 1 new");
    assert.deepEqual(JSON.parse(readFileSync(join(t.keys, "chats.json"), "utf8"))[ME], "whatsapp/+447700900123.md");
  } finally { await t.end(); }
});

test("a group is named from history's chats, and a group saved under its id keeps its file and gains its name", async () => {
  const runners = "120363000000000004@g.us";
  const books = "120363000000000005@g.us";
  const t = await setUp({
    groups: {},
    history: [{ syncType: RECENT, progress: 100, chats: [{ id: runners, name: "Runners" }], messages: [group("R1", runners, "5k?", { from: "Jo", participant: "447111000111@s.whatsapp.net" })] }],
  });
  try {
    await t.link(true);
    t.queue([group("B1", books, "chapter 3", { from: "Kit", participant: "447222000222@s.whatsapp.net" })]);
    await t.check();
    assert.deepEqual(t.saved(), ["whatsapp/Runners.md", "whatsapp/group 120363000000000005.md"]);
    assert.match(t.file("Runners.md"), /^# WhatsApp group: Runners\n/);

    // The book club's name comes later, with no new message.
    t.nameGroups({ [books]: "Book Club" });
    t.queue([]);
    assert.equal(await t.check(), "- whatsapp/group 120363000000000005.md is the group Book Club, and now says so in its first line.");
    assert.match(t.file("group 120363000000000005.md"), /^# WhatsApp group: Book Club\n<!-- wa-chat:120363000000000005@g\.us -->\n[\s\S]*wa:B1 /);

    t.queue([group("B2", books, "chapter 4", { from: "Kit", participant: "447222000222@s.whatsapp.net", at: 1795000100 })]);
    assert.equal(await t.check(), "Saved in My notes (me_private):\n- whatsapp/group 120363000000000005.md: 1 new");
    assert.deepEqual(t.saved(), ["whatsapp/Runners.md", "whatsapp/group 120363000000000005.md"]);
  } finally { await t.end(); }
});
