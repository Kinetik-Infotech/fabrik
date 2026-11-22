// The keys folder, ~/.config/fabrik/whatsapp/<fabrik email>, and what a check saves in fabrik. Shared by the server's
// tools and the timed check, so both check the same way.
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { linkedState } from "./baileys.mjs";
import { saveChats } from "./archive.mjs";
import { openFabrik, privateScope, scopeFiles } from "./fabrik.mjs";

/** The keys folder for the person fabrik signs in as. */
export const keysPath = (email, home = homedir()) => join(home, ".config", "fabrik", "whatsapp", email);

/** Makes the keys folder, readable by the person alone. */
export function makeKeysFolder(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function lockDown(dir) {
  try { for (const f of readdirSync(dir)) chmodSync(join(dir, f), 0o600); } catch { /* gone */ }
}

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };
export const settingsOf = dir => readJson(join(dir, "settings.json"), {});
export const saveSettings = (dir, value) => writeFileSync(join(dir, "settings.json"), JSON.stringify(value, null, 1), { mode: 0o600 });
export const credsOf = dir => readJson(join(dir, "creds.json"), null);
export const stateOf = dir => linkedState(credsOf(dir));

/** Adds the history messages a connection took to the count kept with the link. */
export function countHistory(dir, r) {
  const n = r?.history?.messages ?? 0;
  if (n) { const settings = settingsOf(dir); saveSettings(dir, { ...settings, historyMessages: (settings.historyMessages ?? 0) + n }); }
}

/**
 * The archive a check hands its messages to: it opens the person's fabrik, finds their private scope and saves each
 * chat there. `hooks` are the tests' stand-ins.
 */
export function archiveFor(person, hooks = {}) {
  return async (records, groupNames) => {
    const opened = await (hooks.openFabrik ?? openFabrik)(person);
    if (!opened.ok) throw new Error(opened.problem);
    const settings = settingsOf(person.dir);
    const scope = await (hooks.privateScope ?? privateScope)(opened.access, settings.scope);
    if (!scope.ok) throw new Error(scope.problem);
    const files = (hooks.scopeFiles ?? scopeFiles)(opened.access, scope.code);
    return { scope, ...(await saveChats(records, groupNames, { dir: person.dir, files })) };
  };
}
