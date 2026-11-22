// Recent history, chosen at linking: the plugin's server started as Claude starts it, with a stand-in phone that sends
// its history in chunks to the first connection after the link, as WhatsApp does. fabrik is a stand-in project over HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./client.mjs";
import { dm, savedSignIn, standInFabrik } from "./stand-ins.mjs";
import { readPending } from "../mcp/pull.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INITIAL = 0, FULL = 2, RECENT = 3, ON_DEMAND = 6;
const DAY = 86400;
const jid = n => `4470000${String(n).padStart(5, "0")}@s.whatsapp.net`;

async function setUp({ history = [], messages = [], env = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "wa-hist-"));
  const fabrik = await standInFabrik();
  const { email } = savedSignIn(home, fabrik.url);
  const files = { messages: join(home, "messages.json"), history: join(home, "history.json"), calls: join(home, "calls.jsonl") };
  writeFileSync(files.messages, JSON.stringify(messages));
  writeFileSync(files.history, JSON.stringify(history));
  writeFileSync(files.calls, "");
  const start = async () => {
    const server = startServer({
      HOME: home, FABRIK_SESSION_FOLDER: home, TZ: "Europe/London", WHATSAPP_TEST_HOOKS: join(HERE, "hooks.mjs"),
      WHATSAPP_TEST_MESSAGES: files.messages, WHATSAPP_TEST_HISTORY: files.history, WHATSAPP_TEST_CALLS: files.calls,
      WHATSAPP_TEST_HISTORY_QUIET_MS: "400", ...env,
    });
    await server.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    return server;
  };
  const t = {
    home, fabrik, keys: join(home, ".config", "fabrik", "whatsapp", email), start,
    server: await start(),
    queue: list => writeFileSync(files.messages, JSON.stringify(list)),
    saved: () => [...fabrik.files.entries()].filter(([k]) => k.startsWith("me_private/whatsapp/")),
    async link(history) {
      await t.server.tool("whatsapp_link", { phone: "+447700900123", history });
      return t.server.tool("whatsapp_link_wait");
    },
    async end() { await t.server.stop(); await fabrik.close(); },
  };
  return t;
}

test("whatsapp_link without history is refused, and a link with history false saves no history message", async () => {
  const t = await setUp({ history: [{ syncType: RECENT, progress: 100, messages: [dm("H1", "from history")] }] });
  try {
    const refused = await t.server.tool("whatsapp_link", { phone: "+447700900123" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /^Ask the person whether to bring in recent history first/);
    assert.match(refused.text, /only at linking/);

    assert.equal((await t.link(false)).text, "WhatsApp is linked as +447700900123. Check for messages with whatsapp_check.");
    assert.match((await t.server.tool("whatsapp_status")).text, /^Recent history wasn't brought in\. The phone sends it only at linking, so linking again with relink brings it\.$/m);
    t.queue([dm("N1", "new")]);
    assert.equal((await t.server.tool("whatsapp_check")).text, "Saved in My notes (me_private):\n- whatsapp/Kate.md: 1 new");
    const kate = t.fabrik.files.get("me_private/whatsapp/Kate.md");
    assert.match(kate, /wa:N1 /);
    assert.doesNotMatch(kate, /wa:H1 /);
  } finally { await t.end(); }
});

test("history of the two recent sync types is saved, FULL and ON_DEMAND are not, and a message that also comes new is saved once", async () => {
  const t = await setUp({
    history: [
      { syncType: INITIAL, chunkOrder: 1, messages: [dm("I1", "bootstrap", { at: 1795000000 - 30 * DAY })] },
      { syncType: RECENT, chunkOrder: 2, progress: 100, messages: [dm("R1", "recent", { at: 1795000000 - 10 * DAY }), dm("BOTH", "in both", { at: 1795000000 - DAY })] },
      { syncType: FULL, messages: [dm("F1", "full", { at: 1795000000 - 400 * DAY })] },
      { syncType: ON_DEMAND, messages: [dm("O1", "on demand", { at: 1795000000 - 200 * DAY })] },
    ],
  });
  try {
    const linked = await t.link(true);
    assert.equal(linked.text, [
      "WhatsApp is linked as +447700900123.",
      "Recent history brought 3 messages from 1 chat.",
      "3 messages from 1 chat wait on this computer to be saved.",
      "Save them with whatsapp_check. Each check saves 20 chats, so check again while it says chats wait.",
    ].join("\n"));
    assert.equal(t.saved().length, 0, "the link itself saves nothing");
    assert.match((await t.server.tool("whatsapp_status")).text, /^Recent history was brought in at linking\.$/m);

    t.queue([dm("BOTH", "in both", { at: 1795000000 - DAY }), dm("N1", "new")]);
    assert.equal((await t.server.tool("whatsapp_check")).text, "Saved in My notes (me_private):\n- whatsapp/Kate.md: 4 new");
    const kate = t.fabrik.files.get("me_private/whatsapp/Kate.md");
    for (const id of ["I1", "R1", "BOTH", "N1"]) assert.equal(kate.match(new RegExp(`wa:${id} `, "g"))?.length, 1, id);
    assert.doesNotMatch(kate, /wa:F1 |wa:O1 /);
    assert.deepEqual(kate.match(/^## .*/gm), ["## 2026-10-19", "## 2026-11-08", "## 2026-11-17", "## 2026-11-18"]);
  } finally { await t.end(); }
});

test("45 chats of history take three checks, of 20, 20 and 5 chats", async () => {
  const chats = Array.from({ length: 45 }, (_, i) => dm(`H${i}`, `hello ${i}`, { jid: jid(i), from: `Person ${i}`, at: 1795000000 - (45 - i) * 3600 }));
  const t = await setUp({ history: [{ syncType: RECENT, progress: 100, messages: chats }] });
  try {
    assert.match((await t.link(true)).text, /^45 messages from 45 chats wait on this computer to be saved\. Each check saves 20 chats\.$/m);
    const sizes = [];
    const answers = [];
    for (let i = 0; i < 3; i += 1) {
      const before = t.saved().length;
      const r = await t.server.tool("whatsapp_check");
      answers.push(r.text);
      sizes.push(t.saved().length - before);
    }
    assert.deepEqual(sizes, [20, 20, 5]);
    assert.match(answers[0], /^25 messages from 25 chats wait on this computer to be saved at the next check\. Each check saves 20 chats\.$/m);
    assert.match(answers[1], /^5 messages from 5 chats wait on this computer to be saved at the next check\.$/m);
    assert.doesNotMatch(answers[2], /wait/);
    // The oldest chats go first.
    assert.ok(answers[0].includes("whatsapp/Person 0.md") && answers[2].includes("whatsapp/Person 44.md"));
    assert.equal((await t.server.tool("whatsapp_check")).text, "No new messages.");
  } finally { await t.end(); }
});

test("a chat whose file would pass 1 MB keeps its newest month, and its older months go to a file each, never one it doesn't own", async () => {
  // Three months of one chat, about 1.2 MB in all.
  const at = (month, i) => Date.UTC(2026, month, 1 + (i % 27), 9, 0, 0) / 1000 + (i % 600);
  const long = "x".repeat(110);
  const history = [8, 9, 10].map(month => ({
    syncType: RECENT, progress: month === 10 ? 100 : 50,
    messages: Array.from({ length: 3000 }, (_, i) => dm(`M${month}-${i}`, `${long} ${i}`, { at: at(month, i) })),
  }));
  const t = await setUp({ history });
  try {
    // The person's own notes already have the name September's file would take.
    const notes = "# Kate, September\n\nMy own notes.\n";
    t.fabrik.files.set("me_private/whatsapp/Kate 2026-09.md", notes);
    await t.link(true);
    assert.equal((await t.server.tool("whatsapp_check")).text, "Saved in My notes (me_private):\n- whatsapp/Kate.md: 9000 new");
    assert.equal(t.fabrik.files.get("me_private/whatsapp/Kate 2026-09.md"), notes);
    t.fabrik.files.delete("me_private/whatsapp/Kate 2026-09.md");
    const files = Object.fromEntries(t.saved().map(([k, v]) => [k.slice("me_private/".length), v]));
    assert.deepEqual(Object.keys(files).sort(), ["whatsapp/Kate 2026-10.md", "whatsapp/Kate 447111000111 2026-09.md", "whatsapp/Kate.md"]);
    for (const [name, text] of Object.entries(files)) assert.ok(Buffer.byteLength(text) < 1024 * 1024, name);
    assert.deepEqual([...new Set(files["whatsapp/Kate.md"].match(/^## (\d{4}-\d{2})/gm))], ["## 2026-11"]);
    assert.deepEqual([...new Set(files["whatsapp/Kate 447111000111 2026-09.md"].match(/^## (\d{4}-\d{2})/gm))], ["## 2026-09"]);
    assert.match(files["whatsapp/Kate 447111000111 2026-09.md"], /^# WhatsApp: Kate \(\+447111000111\), 2026-09\n<!-- wa-chat:447111000111@s\.whatsapp\.net -->\n/);
    assert.equal(Object.values(files).join("").match(/<!-- wa:M/g).length, 9000);

    // A later message of a month that has its own file goes there, once.
    t.queue([dm("M9-5", `${long} 5`, { at: at(9, 5) }), dm("LATE", "late for September", { at: at(8, 1) + 5 })]);
    assert.equal((await t.server.tool("whatsapp_check")).text, "Saved in My notes (me_private):\n- whatsapp/Kate.md: 1 new");
    const september = t.fabrik.files.get("me_private/whatsapp/Kate 447111000111 2026-09.md");
    assert.match(september, /wa:LATE /);
    assert.doesNotMatch(t.fabrik.files.get("me_private/whatsapp/Kate.md"), /wa:LATE /);
  } finally { await t.end(); }
});

test("linking waits for the phone's last chunk", async () => {
  const t = await setUp({
    history: [
      { syncType: INITIAL, afterMs: 0, messages: [dm("C1", "one", { at: 1795000000 - 3 * DAY })] },
      { syncType: RECENT, afterMs: 300, progress: 40, messages: [dm("C2", "two", { at: 1795000000 - 2 * DAY })] },
      { syncType: RECENT, afterMs: 700, progress: 100, status: "complete", messages: [dm("C3", "three", { at: 1795000000 - DAY })] },
    ],
    env: { WHATSAPP_TEST_HISTORY_QUIET_MS: "5000" },
  });
  try {
    const started = Date.now();
    assert.match((await t.link(true)).text, /^Recent history brought 3 messages from 1 chat\.$/m);
    assert.ok(Date.now() - started < 4000, "Baileys' word that the sync is complete ends the wait, not the quiet period");
  } finally { await t.end(); }
});

test("a session closed while the history comes keeps what came, and the next check saves it", async () => {
  const t = await setUp({
    history: [
      { syncType: RECENT, afterMs: 0, progress: 30, messages: [dm("C1", "one", { at: 1795000000 - 2 * DAY }), dm("C2", "two", { at: 1795000000 - DAY })] },
      { syncType: RECENT, afterMs: 60_000, progress: 100, messages: [dm("C3", "never comes")] },
    ],
    env: { WHATSAPP_TEST_HISTORY_QUIET_MS: "60000", WHATSAPP_TEST_WAIT_MS: "600" },
  });
  try {
    await t.server.tool("whatsapp_link", { phone: "+447700900123", history: true });
    let wait = await t.server.tool("whatsapp_link_wait");
    while (/code to be typed/.test(wait.text)) wait = await t.server.tool("whatsapp_link_wait");
    assert.equal(wait.text, "WhatsApp is linked as +447700900123. The phone is still sending recent history: 2 messages from 1 chat so far. Call whatsapp_link_wait again.");
    assert.match((await t.server.tool("whatsapp_status")).text, /^The phone is sending recent history: 2 messages from 1 chat so far\.$/m);

    await t.server.kill();
    assert.deepEqual(readPending(t.keys).map(m => m.id), ["C1", "C2"]);

    t.server = await t.start();
    assert.equal((await t.server.tool("whatsapp_check")).text, "Saved in My notes (me_private):\n- whatsapp/Kate.md: 2 new");
    assert.deepEqual(readPending(t.keys), []);
  } finally { await t.end(); }
});
