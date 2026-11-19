// fabrik setup --owner's options, its project file and its first questions. The whole run, against a stand-in for
// Supabase's Management API on the stand-in database, is test/stand-in/setup-flow.ts's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerSetup, PROJECT_FILE, readProject, REGIONS } from "../cli/owner-setup.mjs";
import { API } from "../cli/management.mjs";
import { organization, startManagementApi } from "./stand-in-management-api.mjs";

const TOKEN = "sbp_madeup0000owner1111setup2222";

/** ownerSetup against the Management API's stand-in, in a scratch folder, answering each prompt from answers. */
async function ownerRun(t, apiOptions, answers, kept, env = {}) {
  const folder = mkdtempSync(join(tmpdir(), "fabrik-owner-"));
  const home = mkdtempSync(join(tmpdir(), "fabrik-owner-home-"));
  t.after(() => { rmSync(folder, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  if (kept) writeFileSync(join(folder, PROJECT_FILE), JSON.stringify(kept));
  const api = await startManagementApi({ ref: "abcdefghijklmnopqrst", token: TOKEN, ...apiOptions });
  t.after(() => api.stop());
  const said = [];
  const asked = [];
  const ask = async prompt => {
    asked.push(prompt);
    if (!answers.length) throw new Error("cancelled.");
    return answers.shift();
  };
  const code = await ownerSetup(["--folder", folder], { ask, askHidden: async () => TOKEN, say: line => said.push(line), base: api.url, env, home });
  return { code, said, asked, api, folder, home };
}

test("setup --owner takes --folder alone, and the folder must be there", async () => {
  const said = [];
  const say = line => said.push(line);
  assert.equal(await ownerSetup(["--folder", join(tmpdir(), "no-such-folder-fabrik-owner")], { say }), 2);
  assert.match(said.join("\n"), /is not a folder\.\nUsage: node fabrik\.mjs setup --owner/);
  const folder = mkdtempSync(join(tmpdir(), "fabrik-owner-"));
  try {
    said.length = 0;
    assert.equal(await ownerSetup(["--folder", folder, "--email", "a@b.example"], { say }), 2);
    assert.match(said[0], /^--email is not an option of setup --owner\.\nUsage: node fabrik\.mjs setup --owner/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("with the real Management API, no stand-in is named, and an empty token stops at once", async () => {
  const folder = mkdtempSync(join(tmpdir(), "fabrik-owner-"));
  try {
    const said = [];
    const code = await ownerSetup(["--folder", folder], { base: API, askHidden: async () => "", say: line => said.push(line) });
    assert.equal(code, 1);
    assert.ok(!said.some(line => line.includes("test stand-in")), said.join("\n"));
    assert.equal(said.at(-1), "No token was pasted. Run this again, and paste the token at the prompt.");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("an edited project file whose reference is not a project reference, or whose site is not a web address, is not used", async t => {
  const folder = mkdtempSync(join(tmpdir(), "fabrik-owner-"));
  const home = mkdtempSync(join(tmpdir(), "fabrik-owner-home-"));
  t.after(() => { rmSync(folder, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  const write = kept => { writeFileSync(join(folder, PROJECT_FILE), JSON.stringify(kept)); return readProject(folder); };
  assert.equal(write({ name: "fabrik", ref: "x/../../v1/organizations" }), null);
  assert.equal(write({ name: "fabrik", ref: "abcdefghijklmnopqrst", site: "https://evil.example/../x" }), null);
  assert.equal(write({ name: "fabrik", ref: "abcdefghijklmnopqrst", site: "https://fabrik-sign-in.pages.dev" }).ref, "abcdefghijklmnopqrst");
  // The whole run: the file is passed over, a new project's name is asked, and no call goes to the edited path.
  const ran = await ownerRun(t, {}, [], { name: "Evil", ref: "x/../../v1/organizations", organization: "acme-homes-org" });
  assert.equal(ran.code, 1);
  assert.deepEqual(ran.asked, ["A name for your new Supabase project, such as fabrik: "]);
  assert.ok(!ran.said.some(line => line.startsWith("Carrying on")), ran.said.join("\n"));
  assert.ok(ran.api.calls.every(c => !c.path.includes("..") && !c.path.includes("x/")), JSON.stringify(ran.api.calls.map(c => c.path)));
});

test("a new project goes in the region the owner picks by number, and a number off the list is asked again", async t => {
  const ran = await ownerRun(t, { organizations: [{ ...organization("acme-homes-org", "Acme Homes"), plan: "free" }] }, ["fabrik", "0", "99", "4"], undefined, { FABRIK_TEST_HEALTH_WAIT_MS: "300" });
  const made = ran.api.calls.find(c => c.method === "POST" && c.path === "/v1/projects");
  assert.ok(made, ran.said.join("\n"));
  assert.deepEqual(made.body.region_selection, { type: "specific", code: REGIONS[3][0] });
  assert.equal(made.body.name, "fabrik");
  assert.equal(ran.asked.filter(p => p.startsWith("Where should your project be?")).length, 3);
  assert.ok(ran.said.includes(`Creating your project in ${REGIONS[3][1]}: done.`), ran.said.join("\n"));
  assert.match(readProject(ran.folder).ref, /^[a-z0-9]{20}$/, "the new project's reference is kept for the next run");
});

test("an organisation whose plan Supabase does not give: the charge is said plainly, and no answer of yes creates nothing", async t => {
  const ran = await ownerRun(t, { organizations: [{ ...organization("acme-homes-org", "Acme Homes"), plan: undefined }] }, ["fabrik", "1", "no"]);
  assert.equal(ran.code, 1);
  assert.ok(ran.said.includes("This organisation's plan is not Free, so Supabase charges for a project."), ran.said.join("\n"));
  assert.ok(!ran.said.some(line => line.includes("undefined")), ran.said.join("\n"));
  assert.equal(ran.said.at(-1), "Nothing was created.");
  assert.ok(!ran.api.calls.some(c => c.method === "POST" && c.path === "/v1/projects"));
});

test("a saved project the token cannot see: one plain line at once, with no ten-minute wait", async t => {
  const started = Date.now();
  const ran = await ownerRun(t, {}, [], { name: "fabrik", ref: "zzzzzzzzzzzzzzzzzzzz", organization: "acme-homes-org" });
  assert.equal(ran.code, 1);
  assert.equal(ran.said.at(-1), "Supabase shows this token no such project. Make the token in the account that holds your project, and run this again.");
  assert.equal(ran.api.calls.filter(c => c.path.includes("/health")).length, 1);
  assert.ok(Date.now() - started < 5000);
});

test("a new project whose answer names no project reference: one plain line, and no project file written", async t => {
  const ran = await ownerRun(t, { madeAnswer: () => ({ name: "fabrik", status: "COMING_UP" }) }, ["fabrik", "1", "yes"]);
  assert.equal(ran.code, 1);
  assert.equal(ran.said.at(-1), "Supabase made the project fabrik, but its answer did not say which project it is. Run this command again, and choose fabrik from the list.");
  assert.equal(readProject(ran.folder), null);
  assert.ok(!ran.api.calls.some(c => c.path.includes("/health")), "no poll goes to a project it cannot name");
});

test("a project picked from the list is used only once the owner types yes to its name; anything else lists the projects again", async t => {
  const projects = [{ ref: "abcdefghijklmnopqrst", name: "acme-kb", status: "ACTIVE_HEALTHY", organization_slug: "acme-homes-org" }];
  const rows = query => /fabrik_built/.test(query) ? [{ fabrik_built: false, setup_finished: false, actors: 0, records: 0, files: 0, runner_ready: false }] : [];
  const ran = await ownerRun(t, { projects, rows, healthyAfter: 0 }, ["1", "no"]);
  assert.equal(ran.code, 1);
  assert.deepEqual(ran.asked, ["Which project is for fabrik? Type its number: ", "fabrik's tables, functions and settings go into acme-kb. Type 'yes' to set fabrik up there: ",
    "Which project is for fabrik? Type its number: "]);
  assert.equal(readProject(ran.folder), null, "no project file names it");
  assert.ok(!ran.api.calls.some(c => c.method === "POST" && c.path.includes("/functions/deploy")), "nothing is deployed");
  assert.ok(ran.api.state.queries.every(q => /fabrik_built/.test(q.query)), "only state.sql, which reads, ran there");
});

test("a run after one stopped at the checks turns the Data API on again before checking", async t => {
  const projects = [{ ref: "abcdefghijklmnopqrst", name: "fabrik-dev", status: "ACTIVE_HEALTHY", organization_slug: "acme-homes-org" }];
  const rows = query => /fabrik_built/.test(query) ? [{ fabrik_built: true, setup_finished: true, actors: 1, records: 0, files: 0, runner_ready: true }] : [];
  const kept = { name: "fabrik-dev", ref: "abcdefghijklmnopqrst", organization: "acme-homes-org" };
  const folder = mkdtempSync(join(tmpdir(), "fabrik-owner-"));
  const home = mkdtempSync(join(tmpdir(), "fabrik-owner-home-"));
  t.after(() => { rmSync(folder, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  writeFileSync(join(folder, PROJECT_FILE), JSON.stringify(kept));
  writeFileSync(join(folder, ".fabrik-actor.json"), JSON.stringify({ auth_email: "owner@example.com", project_ref: "abcdefghijklmnopqrst" }));
  const api = await startManagementApi({ ref: "abcdefghijklmnopqrst", token: TOKEN, projects, rows, healthyAfter: 0 });
  t.after(() => api.stop());
  const said = [];
  await ownerSetup(["--folder", folder], { ask: async () => { throw new Error("cancelled."); }, askHidden: async () => TOKEN, say: line => said.push(line), base: api.url, env: {}, home });
  const patch = api.calls.findIndex(c => c.method === "PATCH" && c.path.endsWith("/postgrest"));
  const health = api.calls.findIndex(c => c.method === "POST" && c.path.endsWith("/database/query") && /health/i.test(JSON.stringify(c.body)) && !/fabrik_built/.test(JSON.stringify(c.body)));
  assert.ok(patch >= 0, said.join("\n"));
  assert.equal(api.state.postgrest.db_schema, "public, graphql_public, fabrik");
  assert.ok(said.includes("Turning on the Data API: done."), said.join("\n"));
  assert.ok(health === -1 || patch < health, "the Data API is turned on before the checks");
});

test("a saved project that is paused: one plain line naming the dashboard at once, with no ten-minute wait", async t => {
  const projects = [{ ref: "abcdefghijklmnopqrst", name: "fabrik", status: "INACTIVE", organization_slug: "acme-homes-org" }];
  const started = Date.now();
  const ran = await ownerRun(t, { projects }, [], { name: "fabrik", ref: "abcdefghijklmnopqrst", organization: "acme-homes-org" });
  assert.equal(ran.code, 1);
  assert.equal(ran.said.at(-1), "Your Supabase project is paused. Restore it at https://supabase.com/dashboard/project/abcdefghijklmnopqrst, then run this command again.");
  assert.ok(Date.now() - started < 5000);
});

test("a finished fabrik picked from the list is carried on with when the folder is signed in to it, and refused when it is not", async t => {
  const projects = [{ ref: "abcdefghijklmnopqrst", name: "fabrik-dev", status: "ACTIVE_HEALTHY", organization_slug: "acme-homes-org" }];
  const rows = query => /fabrik_built/.test(query) ? [{ fabrik_built: true, setup_finished: true, actors: 1, records: 3, files: 0, runner_ready: false }] : [];
  // Not signed in: refused, with the way to carry on, and listed again.
  const refused = await ownerRun(t, { projects, rows, healthyAfter: 0 }, ["1"]);
  assert.ok(refused.said.some(line => line.startsWith("fabrik-dev already holds a fabrik.") && line.includes("sign-in --folder")), refused.said.join("\n"));
  assert.equal(readProject(refused.folder), null);
  // Signed in to it: carried on with, and kept for the next run.
  const folder = mkdtempSync(join(tmpdir(), "fabrik-owner-"));
  const home = mkdtempSync(join(tmpdir(), "fabrik-owner-home-"));
  t.after(() => { rmSync(folder, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  writeFileSync(join(folder, ".fabrik-actor.json"), JSON.stringify({ auth_email: "owner@example.com", project_ref: "abcdefghijklmnopqrst" }));
  const api = await startManagementApi({ ref: "abcdefghijklmnopqrst", token: TOKEN, projects, rows, healthyAfter: 0 });
  t.after(() => api.stop());
  const said = [];
  const answers = ["1"];
  await ownerSetup(["--folder", folder], { ask: async () => { if (!answers.length) throw new Error("cancelled."); return answers.shift(); },
    askHidden: async () => TOKEN, say: line => said.push(line), base: api.url, env: {}, home });
  assert.ok(!said.some(line => line.includes("already holds a fabrik")), said.join("\n"));
  assert.ok(said.includes("fabrik is already set up in fabrik-dev."), said.join("\n"));
  assert.equal(readProject(folder)?.ref, "abcdefghijklmnopqrst");
  // The sign-in page's folder is made in the home it is given, never in the home of whoever runs the tests.
  assert.ok(existsSync(join(home, ".config", "fabrik", "sign-in", "abcdefghijklmnopqrst", "index.html")), said.join("\n"));
});

test("a project whose state.sql answers no row: one plain line, not a JavaScript error", async t => {
  const projects = [{ ref: "abcdefghijklmnopqrst", name: "fabrik", status: "ACTIVE_HEALTHY", organization_slug: "acme-homes-org" }];
  const ran = await ownerRun(t, { projects, rows: () => [], healthyAfter: 0 }, [], { name: "fabrik", ref: "abcdefghijklmnopqrst", organization: "acme-homes-org" });
  assert.equal(ran.code, 1);
  assert.equal(ran.said.at(-1), "Reading where your project stands: failed. Supabase's answer held no row. Run this command again to carry on.");
});
