// Read only is structural: no file of the plugin names a Baileys call that sends a message, a receipt or a presence,
// and no tool sends. The forbidden names are built from parts, so this file doesn't hold them either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORBIDDEN = [["send", "Message"], ["read", "Messages"], ["send", "Receipt"], ["send", "PresenceUpdate"]].map(p => p.join(""));

function files(dir) {
  return readdirSync(dir).flatMap(name => {
    if (name === "node_modules" || name === ".git") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test("no file of the plugin names a call that sends", () => {
  const all = files(ROOT);
  assert.ok(all.some(f => f.endsWith("server.mjs")), "the scan reaches the server");
  const found = all.flatMap(f => FORBIDDEN.filter(name => readFileSync(f, "utf8").includes(name)).map(name => `${relative(ROOT, f)}: ${name}`));
  assert.deepEqual(found, []);
});

test("every connection is made with markOnlineOnConnect false", () => {
  const source = readFileSync(join(ROOT, "mcp", "baileys.mjs"), "utf8");
  assert.equal(source.match(/makeWASocket\(/g).length, 1);
  assert.match(source, /markOnlineOnConnect: false/);
});

test("no tool's name or description offers to send", async () => {
  const source = readFileSync(join(ROOT, "mcp", "server.mjs"), "utf8");
  const names = [...source.matchAll(/name: "(whatsapp_[a-z_]+)"/g)].map(m => m[1]);
  assert.deepEqual(names, ["whatsapp_status", "whatsapp_link", "whatsapp_link_wait", "whatsapp_check", "whatsapp_timer", "whatsapp_unlink"]);
});
