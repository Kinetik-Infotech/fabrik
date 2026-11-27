// fabrik update, run on fabrik's own setup folder and a scratch project folder, with fabrik-upgrade answered by a
// stand-in that keeps a ledger and applies what it is sent, as the deployed function does for a signed upgrade, and
// Supabase's Management API by the tests' stand-in for it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { aboutOf, update } from "../cli/update.mjs";
import { functionHash, PROJECT_FILE, SETUP_FOLDER } from "../cli/owner-setup.mjs";
import { startManagementApi } from "./stand-in-management-api.mjs";

const REF = "abcdefghijklmnopqrst";
const TOKEN = "sbp_madeup0000token1111for2222tests";
/** A token prompt that fails the test when it is asked. */
const noToken = async () => { throw new Error("asked for a token"); };

const build = await import(pathToFileURL(join(SETUP_FOLDER, "build.mjs")).href);
const FUNCTIONS = build.functions(SETUP_FOLDER);

/** A project folder whose project file says every function but those named was deployed as it is now. */
function project(t, stale = []) {
  const folder = mkdtempSync(join(tmpdir(), "fabrik-update-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const functions = Object.fromEntries(FUNCTIONS.map(f => [f.name, stale.includes(f.name) ? "0".repeat(64) : functionHash(f)]));
  writeFileSync(join(folder, PROJECT_FILE), JSON.stringify({ ref: REF, name: "fabrik", functions }));
  return folder;
}

/** fabrik-upgrade as deployed, holding the ledgers given, or as before it listed them when old is true. */
function upgrader(ledgers, { old = false, refuse = null } = {}) {
  const sent = [];
  const call = async body => {
    sent.push(body);
    if (body.list) return old ? { ok: false, problem: "Give the upgrade's four-digit number and its name, as its file is named." } : { ok: true, ledgers: structuredClone(ledgers) };
    const id = `${body.number}-${body.name}`;
    if (ledgers[body.series].includes(id)) return { ok: false, problem: `Upgrade ${body.number} is already applied here, so it was not applied again.` };
    if (refuse === id) return { ok: false, problem: `Upgrade ${id} failed, and nothing of it was kept: boom` };
    ledgers[body.series].push(id);
    return { ok: true, upgrade: id, ledger: ledgers[body.series] };
  };
  return { call, sent, ledgers };
}
const fabrikUpTo = n => ["0001-baseline", "0002-set-based-lookups", "0003-second-factor", "0004-graph-reader", "0005-private-sessions",
  "0006-record-source", "0007-ported-tools", "0008-mailbox", "0009-save-version-check", "0010-mail-send", "0011-mail-signature", "0012-public-agent", "0013-public-agent-sitekey", "0014-public-agents", "0015-public-exchanges", "0016-waiting-for-classes", "0017-glossary-tags", "0018-unextracted-terms", "0019-shared-logins", "0020-own-records-set", "0021-public-agent-topic", "0022-public-agent-greeting"].slice(0, n);
const SEARCH = ["0001-baseline", "0002-sentence-claim", "0003-graph-reader", "0004-claim-once", "0005-worker-budget", "0006-claim-source", "0007-any-word", "0008-retired-chunks", "0009-add-extraction", "0010-add-keeps-saves"];

test("update --check names the upgrades the project lacks, with what each brings, and the functions that changed, fabrik-upgrade first", async t => {
  const { call } = upgrader({ fabrik: fabrikUpTo(8), file_search: SEARCH });
  const out = await update(["--check"], project(t, ["fabrik-apps", "fabrik-upgrade"]), call);
  assert.equal(out.ok, true);
  assert.equal(out.behind, true);
  assert.deepEqual(out.upgrades.map(u => u.id), ["0009-save-version-check", "0010-mail-send", "0011-mail-signature", "0012-public-agent", "0013-public-agent-sitekey", "0014-public-agents", "0015-public-exchanges", "0016-waiting-for-classes", "0017-glossary-tags", "0018-unextracted-terms", "0019-shared-logins", "0020-own-records-set", "0021-public-agent-topic", "0022-public-agent-greeting"]);
  assert.match(out.upgrades[1].about, /drafts and sending/);
  assert.match(out.upgrades[2].about, /HTML signature/);
  assert.deepEqual(out.functions, ["fabrik-upgrade", "fabrik-apps"]);
  assert.deepEqual(out.unsigned, []);
});

test("update --check on an up-to-date project answers behind false, and never lists fabrik-setup", async t => {
  const { call } = upgrader({ fabrik: fabrikUpTo(22), file_search: SEARCH });
  const out = await update(["--check"], project(t, ["fabrik-setup"]), call);
  assert.equal(out.behind, false);
  assert.deepEqual(out.upgrades, []);
  assert.deepEqual(out.functions, []);
});

test("update --apply with only upgrades missing asks for no token, applies them in order, and passes over what an old fabrik-upgrade says is applied", async t => {
  const fresh = upgrader({ fabrik: fabrikUpTo(8), file_search: SEARCH });
  const out = await update(["--apply"], project(t), fresh.call, { askHidden: noToken });
  assert.deepEqual(out.applied, ["0009-save-version-check", "0010-mail-send", "0011-mail-signature", "0012-public-agent", "0013-public-agent-sitekey", "0014-public-agents", "0015-public-exchanges", "0016-waiting-for-classes", "0017-glossary-tags", "0018-unextracted-terms", "0019-shared-logins", "0020-own-records-set", "0021-public-agent-topic", "0022-public-agent-greeting"]);
  assert.deepEqual(out.deployed, []);
  assert.deepEqual(out.ledgers.fabrik, fabrikUpTo(22));
  const old = upgrader({ fabrik: fabrikUpTo(8), file_search: SEARCH }, { old: true });
  const fromOld = await update(["--apply"], project(t), old.call, { askHidden: noToken });
  assert.deepEqual(fromOld.applied, ["0009-save-version-check", "0010-mail-send", "0011-mail-signature", "0012-public-agent", "0013-public-agent-sitekey", "0014-public-agents", "0015-public-exchanges", "0016-waiting-for-classes", "0017-glossary-tags", "0018-unextracted-terms", "0019-shared-logins", "0020-own-records-set", "0021-public-agent-topic", "0022-public-agent-greeting"]);
  assert.ok(old.sent.filter(b => !b.list).every(b => typeof b.signature === "string" && b.signature.length > 40));
});

test("a fabrik-upgrade that fails to list its ledgers stops check and apply, and no upgrade is sent", async t => {
  const sent = [];
  const call = async body => { sent.push(body); return { ok: false, problem: "fabrik-upgrade answered 500: relation \"file_search.schema_upgrade\" does not exist" }; };
  for (const flag of ["--check", "--apply"]) {
    const out = await update([flag], project(t), call, { askHidden: noToken });
    assert.equal(out.ok, false);
    assert.match(out.problem, /fabrik-upgrade didn't list the project's upgrades: .*does not exist/);
  }
  assert.ok(sent.every(b => b.list === true), JSON.stringify(sent));
});

test("update --apply stops at the first refusal, and says which upgrade and why", async t => {
  const { call, ledgers } = upgrader({ fabrik: fabrikUpTo(8), file_search: SEARCH }, { refuse: "0009-save-version-check" });
  const out = await update(["--apply"], project(t), call, { askHidden: noToken });
  assert.equal(out.ok, false);
  assert.match(out.problem, /^Upgrade 0009-save-version-check was not applied: .*boom/);
  assert.deepEqual(ledgers.fabrik, fabrikUpTo(8));
});

test("update --apply deploys fabrik-upgrade from this computer's files before the upgrades and the other functions after, records each, and the next check is up to date", async t => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  t.after(() => api.stop());
  const folder = project(t, ["fabrik-apps", "fabrik-upgrade"]);
  const up = upgrader({ fabrik: fabrikUpTo(8), file_search: SEARCH });
  // What Supabase holds when each upgrade arrives.
  const seen = [];
  const call = async body => { if (!body.list) seen.push(api.state.functions.map(f => f.slug).sort().join(",")); return up.call(body); };
  const lines = [];
  const out = await update(["--apply"], folder, call, { askHidden: async () => TOKEN, say: l => lines.push(l), base: api.url });
  assert.equal(out.ok, true, out.problem);
  assert.deepEqual(out.deployed, ["fabrik-upgrade", "fabrik-apps"]);
  assert.deepEqual(out.applied, ["0009-save-version-check", "0010-mail-send", "0011-mail-signature", "0012-public-agent", "0013-public-agent-sitekey", "0014-public-agents", "0015-public-exchanges", "0016-waiting-for-classes", "0017-glossary-tags", "0018-unextracted-terms", "0019-shared-logins", "0020-own-records-set", "0021-public-agent-topic", "0022-public-agent-greeting"]);
  assert.deepEqual(seen, Array(14).fill("fabrik-upgrade"));
  const apps = api.state.functions.find(f => f.slug === "fabrik-apps");
  const made = FUNCTIONS.find(f => f.name === "fabrik-apps");
  assert.equal(apps.verify_jwt, made.verify_jwt);
  assert.deepEqual(apps.files.map(f => f.name), made.files.map(f => f.name));
  assert.ok(apps.files.every((f, i) => f.text === readFileSync(made.files[i].path, "utf8")), "a deployed file differs from the one on disk");
  assert.ok(lines.some(l => l.startsWith("Delete the access token")), lines.join("\n"));
  assert.equal((await update(["--check"], folder, up.call)).behind, false);
});

test("update --apply with a token Supabase refuses says so, and records nothing", async t => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  t.after(() => api.stop());
  const folder = project(t, ["fabrik-apps"]);
  const before = readFileSync(join(folder, PROJECT_FILE), "utf8");
  const { call } = upgrader({ fabrik: fabrikUpTo(19), file_search: SEARCH });
  const out = await update(["--apply"], folder, call, { askHidden: async () => "sbp_wrong", base: api.url });
  assert.equal(out.ok, false);
  assert.match(out.problem, /^Supabase refused the token/);
  assert.equal(readFileSync(join(folder, PROJECT_FILE), "utf8"), before);
});

test("update in a folder with no project file refuses, naming the file", async t => {
  const folder = mkdtempSync(join(tmpdir(), "fabrik-update-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const out = await update(["--check"], folder, async () => ({}));
  assert.equal(out.ok, false);
  assert.match(out.problem, /\.fabrik-setup-project\.json is missing or unreadable/);
});

test("aboutOf takes an upgrade's own sentences from its header", () => {
  assert.equal(aboutOf("-- 0099-x\n-- base: abc\n-- redeploy: fabrik-apps\n-- It adds a thing.\n-- And another.\n-- The same text is in setup.sql.\nselect 1;\n"),
    "It adds a thing. And another.");
});
