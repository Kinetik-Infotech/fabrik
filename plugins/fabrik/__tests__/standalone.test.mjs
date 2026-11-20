// The fabrik plugin's server and sign-in: what the server starts with, the sign-in, and the database
// tools, against a local stand-in for Supabase's Auth and REST endpoints.
//
// A request without a key gets the 401 `message` Supabase gave on 2026-09-25. A missing bucket
// gets the body Supabase Storage gave on 2026-09-26. Other bodies follow Supabase's documented shapes.
// Run with: node scripts/test.mjs plugins/fabrik/__tests__/standalone.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, readFileSync, statSync, writeFileSync, mkdirSync, chmodSync, symlinkSync, truncateSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { options, signIn, USAGE } from "../cli/lib/sign-in-flow.mjs";
import { sessionPath, uploadSource } from "../cli/lib/session.mjs";
import { ACTOR_FILE } from "../cli/lib/actor-file.mjs";
import { spawnSync } from "node:child_process";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const PAGE_TOOLS = ["check_text", "copy_samples", "create_workbook", "draw_board", "draw_graph", "draw_reference", "draw_search", "draw_sop", "draw_state_machine", "edit_workbook", "embed_pictures", "print_pdf", "report_page", "run_code", "state_machine_payload"];
const DATABASE_TOOLS = ["call_function", "check_plugins", "copy_to_agent_folder", "download_file", "list_files", "read_file", "rpc", "upload_file", "whoami"];
const REF = "abcdefghijklmnopqrst";
const KEY = "sb_publishable_test";
const USER = { id: "0b6c1f5e-0000-4000-8000-000000000001", email: "auditor@example.com" };
// The quote the sign-in command puts round each argument, for the shell of the user's system.
const Q = process.platform === "win32" ? '"' : "'";

/**
 * Makes a link. Windows makes links only for an administrator, or in Developer Mode; where it
 * refuses, the test is skipped and says so.
 */
function link(t, target, path) {
  try { symlinkSync(target, path); return true; }
  catch (err) {
    if (process.platform !== "win32" || err?.code !== "EPERM") throw err;
    t.skip("Windows refused to make a link: this account is not an administrator and Developer Mode is off.");
    return false;
  }
}

/** A stand-in for one project's Auth and REST endpoints, holding one user. */
async function supabase() {
  // factors holds the account's authenticator apps, and code the six digits the app shows. The answers' shapes are
  // those of supabase/auth-js's types for enroll, challenge and verify.
  const state = { password: "first-password", refresh: new Set(), access: new Set(), n: 0, calls: [], objects: new Map(), factors: [], code: "123456" };
  const claims = aal => Buffer.from(JSON.stringify({ sub: USER.id, aal })).toString("base64url");
  const user = () => state.factors.length ? { ...USER, factors: state.factors.map(({ id, status }) => ({ id, factor_type: "totp", status, friendly_name: "fabrik" })) } : USER;
  const issue = (aal = "aal1") => {
    state.n += 1;
    // A sign-in that gave a code carries aal2 in its token's claims, as Supabase's does.
    const session = { access_token: aal === "aal2" ? `header.${claims(aal)}.at-${state.n}` : `at-${state.n}`, refresh_token: `rt-${state.n}`, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: USER };
    state.refresh.add(session.refresh_token);
    state.access.add(session.access_token);
    return session;
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const json = raw.length && req.headers["content-type"] === "application/json" ? JSON.parse(raw.toString("utf-8")) : {};
    const url = new URL(req.url, "http://x");
    state.calls.push({ method: req.method, path: url.pathname, headers: req.headers, body: json, raw });
    const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.apikey !== KEY) return send(401, { message: "No API key found in request" });
    const bearer = req.headers.authorization?.replace(/^Bearer /, "");

    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "password") {
      if (json.email !== USER.email || json.password !== state.password)
        return send(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" });
      return send(200, issue());
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token") {
      if (!state.refresh.delete(json.refresh_token))
        return send(400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token: Refresh Token Not Found" });
      return send(200, issue(state.renewAs));
    }
    if (!state.access.has(bearer)) return send(403, { code: 403, error_code: "bad_jwt", msg: "invalid JWT" });
    if (url.pathname === "/auth/v1/user" && req.method === "GET") return send(200, user());
    if (url.pathname === "/auth/v1/factors" && req.method === "POST") {
      if (state.factors.some(f => f.status !== "verified")) return send(422, { code: 422, error_code: "mfa_factor_name_conflict", msg: "A factor with the friendly name \"fabrik\" for this user already exists" });
      const factor = { id: `factor-${state.factors.length + 1}`, status: "unverified" };
      state.factors.push(factor);
      return send(200, { id: factor.id, type: "totp", friendly_name: json.friendly_name, totp: { qr_code: "<svg/>", secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/fabrik:auditor@example.com?secret=JBSWY3DPEHPK3PXP&issuer=fabrik" } });
    }
    const factorPath = /^\/auth\/v1\/factors\/([^/]+)(\/challenge|\/verify)?$/.exec(url.pathname);
    if (factorPath) {
      const factor = state.factors.find(f => f.id === factorPath[1]);
      if (!factor) return send(404, { code: 404, error_code: "mfa_factor_not_found", msg: "MFA factor not found" });
      if (req.method === "DELETE") { state.factors = state.factors.filter(f => f !== factor); return send(200, { id: factor.id }); }
      if (factorPath[2] === "/challenge") return send(200, { id: `challenge-${factor.id}`, type: "totp", expires_at: Math.floor(Date.now() / 1000) + 300 });
      if (json.challenge_id !== `challenge-${factor.id}` || json.code !== state.code) return send(422, { code: 422, error_code: "mfa_verification_failed", msg: "Invalid TOTP code entered" });
      factor.status = "verified";
      return send(200, { ...issue("aal2"), user: user() });
    }
    // Supabase Auth refuses a new password that is the one the user has.
    if (url.pathname === "/auth/v1/user" && req.method === "PUT" && json.password === state.password)
      return send(422, { code: 422, error_code: "same_password", msg: "New password should be different from the old password." });
    if (url.pathname === "/auth/v1/user" && req.method === "PUT") {
      // A password under 6 characters is refused, as Supabase Auth does by default.
      if (String(json.password).length < 6) return send(422, { code: 422, error_code: "weak_password", msg: "Password should be at least 6 characters." });
      state.password = json.password;
      return send(200, USER);
    }
    if (url.pathname === "/rest/v1/rpc/get_scopes") return send(200, [{ scope: "sales" }]);
    if (url.pathname === "/rest/v1/rpc/echo_args") return send(200, { received: json });
    if (url.pathname === "/rest/v1/rpc/get_version") return send(200, { cutoff: 7, version: { version_id: "v-1", version_number: 2, title: "A model", payload: { graph: { nodes: [1, 2, 3] } } }, links: [{}, {}] });
    if (url.pathname === "/functions/v1/echo") return send(200, { received: json, as: bearer });
    // A hosted function's own refusal: ok false and a problem sentence, with more beside it.
    if (url.pathname === "/functions/v1/refuses") return send(403, { ok: false, problem: REFUSAL, allowed_offices: ["High Street"] });
    // A hosted function may answer a refused field of its own, which is a result.
    if (url.pathname === "/functions/v1/answers_refused") return send(200, { ok: true, refused: true });
    if (url.pathname.startsWith("/functions/v1/")) return send(404, { code: "NOT_FOUND", message: "Requested function was not found" });
    // fabrik answers a permission refusal, which it has logged as change_refused; before, it raised it as PostgREST's 403.
    if (url.pathname === "/rest/v1/rpc/answers_refusal") return send(200, { refused: true, problem: "Action outside authority scope" });
    if (url.pathname === "/rest/v1/rpc/raises_refusal") return send(403, { code: "42501", details: null, hint: null, message: "Action outside authority scope" });
    // A database error's details: JSON where a function lists each problem, else Postgres's own text.
    if (url.pathname === "/rest/v1/rpc/refuses_rows") return send(400, { code: "23514", details: '[{"line": 1, "rule": "The glossary has no term X.", "field": "term", "value": "X"}]', hint: null, message: "The rows break 1 of fabrik's rules" });
    if (url.pathname === "/rest/v1/rpc/refuses_text") return send(400, { code: "23505", details: "Key (id)=(1) already exists.", hint: null, message: "duplicate key value violates unique constraint" });
    // A move preview lists the records a move would refuse, which is a result.
    if (url.pathname === "/rest/v1/rpc/preview_move") return send(200, { operation: "move", refused: [{ record: "Kept elsewhere" }] });
    if (url.pathname === "/rest/v1/rpc/many_rows") return send(200, Array.from({ length: 600 }, (_, i) => ({ i })));
    const listed = url.pathname.match(/^\/storage\/v1\/object\/list\/([^/]+)$/);
    if (listed && listed[1] === "many") return send(200, Array.from({ length: 600 }, (_, i) => ({ name: `f${i}`, id: `id-${i}`, updated_at: "2026-09-26T00:00:00Z", metadata: { size: 1 } })));
    if (listed) {
      const prefix = `${listed[1]}/${json.prefix}/`;
      return send(200, [...state.objects.keys()].filter(one => one.startsWith(prefix)).map(one => ({ name: one.slice(prefix.length), id: "id-1", updated_at: "2026-09-26T00:00:00Z", metadata: { size: state.objects.get(one).length } })));
    }
    const fetched = url.pathname.match(/^\/storage\/v1\/object\/authenticated\/([^/]+)\/(.+)$/);
    if (fetched && req.method === "GET") {
      const [, bucket, path] = fetched;
      // Over 50 MB, once with its length stated and once without.
      if (bucket === "large") {
        const stated = path === "stated.bin";
        res.writeHead(200, { "Content-Type": "application/octet-stream", ...(stated ? { "Content-Length": 51 * 1024 * 1024 } : {}) });
        const part = Buffer.alloc(1024 * 1024);
        for (let i = 0; i < 51; i++) if (!res.write(part)) await new Promise(done => res.once("drain", done));
        return res.end();
      }
      const key = `${bucket}/${decodeURIComponent(path)}`;
      if (!state.objects.has(key)) return send(400, { statusCode: "404", error: "not_found", message: "Object not found", code: "NoSuchKey" });
      res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      return res.end(state.objects.get(key));
    }
    const object = url.pathname.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (object && req.method === "POST") {
      const [, bucket, path] = object;
      if (bucket !== "reports") return send(400, { statusCode: "404", error: "Bucket not found", message: "Bucket not found", code: "NoSuchBucket" });
      const key = `${bucket}/${decodeURIComponent(path)}`;
      if (state.objects.has(key) && req.headers["x-upsert"] !== "true") return send(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      state.objects.set(key, raw);
      return send(200, { Key: key, Id: "5b1e0000-0000-4000-8000-000000000002" });
    }
    return send(404, { code: "PGRST202", message: `Could not find the function ${url.pathname}` });
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise(done => server.close(done));
  return state;
}

/** A private home folder, so the session file lands somewhere the test owns. */
function home() {
  const dir = mkdtempSync(join(tmpdir(), "supabase-home-"));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return dir;
}

function savedSession(dir, session, email = USER.email) {
  const folder = join(dir, ".config", "supabase-auth", REF);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, `${email}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, projectRef: REF, publishableKey: KEY, email, ...session }));
  chmodSync(file, 0o600);
  return file;
}

/** Scripted answers, in order, and the questions they were given for. */
function answers(...values) {
  const asked = [];
  return { asked, ask: async (prompt, hidden = false) => { asked.push({ prompt, hidden }); return values.shift(); } };
}



test("sign-in keeps the refresh token in a private file and never the password", async () => {
  const dir = home();
  const project = await supabase();
  try {
    // The stand-in's URL does not show the reference, so it is asked for, as for a custom domain.
    const { ask, asked } = answers(project.url, REF, KEY, USER.email, "first-password");
    const path = await signIn({ newPassword: false }, ask, () => {});

    assert.deepEqual(asked.map(one => one.prompt), ["Project URL: ", "Project reference: ", "Publishable key: ", "Email: ", "Password: "]);
    assert.equal(path, sessionPath(REF, USER.email));
    const saved = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(saved.refreshToken, "rt-1");
    assert.equal(JSON.stringify(saved).includes("first-password"), false);
    assert.equal(asked.find(one => one.prompt === "Password: ").hidden, true);
    if (process.platform !== "win32") {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
    }
  } finally {
    await project.close();
  }
});

test("a plugin that knows its project gives the URL and key, and the person is asked only for email and password", async () => {
  home();
  const project = await supabase();
  try {
    const { ask, asked } = answers(REF, USER.email, "first-password");
    const path = await signIn({ url: project.url, key: KEY, newPassword: false }, ask, () => {});

    // The stand-in's URL hides the reference, so it is still asked for; a supabase.co address gives it.
    assert.deepEqual(asked.map(one => one.prompt), ["Project reference: ", "Email: ", "Password: "]);
    const saved = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(saved.url, project.url);
    assert.equal(saved.publishableKey, KEY);
  } finally {
    await project.close();
  }
});

test("an email given on the command line is not asked for, and the sign-in says whom it signs in", async () => {
  home();
  const project = await supabase();
  try {
    const { ask, asked } = answers(REF, "first-password");
    const said = [];
    await signIn({ url: project.url, key: KEY, email: USER.email, newPassword: false }, ask, line => said.push(line));

    assert.deepEqual(asked.map(one => one.prompt), ["Project reference: ", "Password: "]);
    assert.equal(said[0], `Signing in to ${REF} as ${USER.email}.`);
  } finally {
    await project.close();
  }
});

test("an account with an authenticator app is asked for its code after the password, and the code's session is saved", async () => {
  home();
  const project = await supabase();
  try {
    project.factors.push({ id: "factor-1", status: "verified" });
    const { ask, asked } = answers(REF, "first-password", "000000", "123 456");
    const said = [];
    const path = await signIn({ url: project.url, key: KEY, email: USER.email, newPassword: false }, ask, line => said.push(line));

    // A refused code is asked for again, and a code typed with a space is taken.
    assert.deepEqual(asked.map(one => [one.prompt, one.hidden]), [["Project reference: ", false], ["Password: ", true], ["Code: ", false], ["Code: ", false]]);
    assert.match(said.find(line => line.startsWith("Supabase refused the code")) ?? "", /Invalid TOTP code entered/);
    // The password's session is rt-1, and the code's is rt-2.
    assert.equal(JSON.parse(readFileSync(path, "utf-8")).refreshToken, "rt-2");
    const verify = project.calls.find(c => c.path === "/auth/v1/factors/factor-1/verify" && c.body.code === "123456");
    assert.deepEqual(verify.body, { challenge_id: "challenge-factor-1", code: "123456" });
    assert.equal(verify.headers.authorization, "Bearer at-1");
  } finally {
    await project.close();
  }
});

test("with an authenticator app, no code typed stops the sign-in, and nothing is saved", async () => {
  home();
  const project = await supabase();
  try {
    project.factors.push({ id: "factor-1", status: "verified" });
    const { ask } = answers(REF, "first-password", "");
    await assert.rejects(signIn({ url: project.url, key: KEY, email: USER.email, newPassword: false }, ask, () => {}), /no code was typed\. Nothing was saved\./);
    assert.equal(existsSync(sessionPath(REF, USER.email)), false);
  } finally {
    await project.close();
  }
});

test("--second-factor adds an authenticator app, printing its secret and address, and saves the code's session", async () => {
  home();
  const project = await supabase();
  try {
    const { ask, asked } = answers(REF, "first-password", "123456");
    const said = [];
    const path = await signIn({ url: project.url, key: KEY, email: USER.email, newPassword: false, secondFactor: true }, ask, line => said.push(line));

    assert.deepEqual(asked.map(one => one.prompt), ["Project reference: ", "Password: ", "Code: "]);
    assert.ok(said.includes("Secret: JBSWY3DPEHPK3PXP"), said.join("\n"));
    assert.ok(said.includes("Address: otpauth://totp/fabrik:auditor@example.com?secret=JBSWY3DPEHPK3PXP&issuer=fabrik"), said.join("\n"));
    assert.deepEqual(project.calls.find(c => c.path === "/auth/v1/factors" && c.method === "POST").body, { factor_type: "totp", friendly_name: "fabrik", issuer: "fabrik" });
    assert.deepEqual(project.factors, [{ id: "factor-1", status: "verified" }]);
    assert.equal(JSON.parse(readFileSync(path, "utf-8")).refreshToken, "rt-2");
  } finally {
    await project.close();
  }
});

test("--second-factor with no code typed removes the app it started, and one left by a stopped run is replaced", async () => {
  home();
  const project = await supabase();
  try {
    await assert.rejects(signIn({ url: project.url, key: KEY, email: USER.email, newPassword: false, secondFactor: true }, answers(REF, "first-password", "").ask, () => {}),
      /no code was typed\. The authenticator app was not added\./);
    assert.deepEqual(project.factors, []);
    // An app started and never finished, as a closed terminal leaves it.
    project.factors.push({ id: "factor-9", status: "unverified" });
    await signIn({ url: project.url, key: KEY, email: USER.email, newPassword: false, secondFactor: true }, answers(REF, "first-password", "123456").ask, () => {});
    assert.deepEqual(project.factors.map(f => f.status), ["verified"]);
    assert.ok(project.calls.some(c => c.method === "DELETE" && c.path === "/auth/v1/factors/factor-9"));
  } finally {
    await project.close();
  }
});

test("a new password is set, and the saved session is one signed in with it", async () => {
  const dir = home();
  const project = await supabase();
  try {
    savedSession(dir, { url: project.url, refreshToken: "stale" });
    const { ask } = answers("first-password", "second-password", "second-password");
    await signIn({ project: REF, email: USER.email, newPassword: true }, ask, () => {});

    assert.equal(project.password, "second-password");
    assert.equal(JSON.parse(readFileSync(sessionPath(REF, USER.email), "utf-8")).refreshToken, "rt-2");
  } finally {
    await project.close();
  }
});

test("the password the person has, typed again as the new one, is kept, and the sign-in is saved", async () => {
  const dir = home();
  const project = await supabase();
  try {
    savedSession(dir, { url: project.url, refreshToken: "stale" });
    const { ask } = answers("first-password", "first-password", "first-password");
    const said = [];
    await signIn({ project: REF, email: USER.email, newPassword: true }, ask, line => said.push(line));

    assert.equal(project.password, "first-password");
    assert.equal(said[1], "The new password is the one you have, and stays.");
    assert.equal(project.calls.filter(one => one.path === "/auth/v1/user" && one.method === "PUT").length, 0, "no password change is asked for");
    assert.equal(JSON.parse(readFileSync(sessionPath(REF, USER.email), "utf-8")).refreshToken, "rt-1");
  } finally {
    await project.close();
  }
});

test("mismatched or refused new passwords are asked for again, and the matching pair is set", async () => {
  const dir = home();
  const project = await supabase();
  try {
    savedSession(dir, { url: project.url, refreshToken: "stale" });
    const { ask, asked } = answers("first-password", "second-password", "typo", "short", "short", "second-password", "second-password");
    const said = [];
    await signIn({ project: REF, email: USER.email, newPassword: true }, ask, line => said.push(line));

    assert.deepEqual(asked.map(one => one.prompt), ["Password: ", ...Array(3).fill(["New password: ", "New password again: "]).flat()]);
    assert.ok(said.includes("The two passwords differ. Type the new password again, or press Return with nothing typed to stop."), said.join("\n"));
    assert.ok(said.includes("Supabase refused the new password: Password should be at least 6 characters. Type the new password again, or press Return with nothing typed to stop."), said.join("\n"));
    assert.equal(project.password, "second-password");
    assert.ok(said.includes("Password changed."), said.join("\n"));
  } finally {
    await project.close();
  }
});

test("no new password, first or after a mismatch, changes nothing and saves nothing", async () => {
  const dir = home();
  const project = await supabase();
  try {
    const file = savedSession(dir, { url: project.url, refreshToken: "kept" });
    await assert.rejects(signIn({ project: REF, email: USER.email, newPassword: true }, answers("first-password", "").ask, () => {}), /no password was typed/);
    await assert.rejects(signIn({ project: REF, email: USER.email, newPassword: true }, answers("first-password", "second-password", "typo", "").ask, () => {}), /no password was typed/);
    assert.equal(project.password, "first-password");
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).refreshToken, "kept");
  } finally {
    await project.close();
  }
});

test("a wrong password is refused with Supabase's own sentence", async () => {
  const dir = home();
  const project = await supabase();
  try {
    savedSession(dir, { url: project.url, refreshToken: "kept" });
    await assert.rejects(signIn({ project: REF, email: USER.email, newPassword: false }, answers("wrong").ask, () => {}), /Invalid login credentials/);
  } finally {
    await project.close();
  }
});

test("sign-in options accept a project reference and nothing that could be taken for one", () => {
  const none = { secondFactor: false, folder: undefined, owner: false };
  assert.deepEqual(options(["--project", REF, "--email", USER.email, "--new-password"]), { project: REF, email: USER.email, url: undefined, key: undefined, newPassword: true, ...none });
  assert.deepEqual(options(["--url", `https://${REF}.supabase.co`, "--key", KEY]), { project: undefined, email: undefined, url: `https://${REF}.supabase.co`, key: KEY, newPassword: false, ...none });
  assert.throws(() => options(["--url", `https://${REF}.supabase.co`]), /go together/);
  assert.throws(() => options(["--url", "ftp://elsewhere", "--key", KEY]), /not a project URL/);
  assert.throws(() => options(["--project", "../elsewhere", "--email", USER.email]), /not a project reference/);
  assert.throws(() => options(["--project", REF]), /go together/);
  assert.deepEqual(options(["--email", USER.email]), { project: undefined, email: USER.email, url: undefined, key: undefined, newPassword: false, ...none });
  assert.throws(() => options(["--project", REF, "--email", "../../x"]), /not an email address/);
  assert.throws(() => options(["--password", "x"]), /unknown option/);
  // The owner's first sign-in takes the project's address and key and the setup folder, and nothing else.
  const folder = home();
  assert.deepEqual(options(["--owner", "--url", `https://${REF}.supabase.co`, "--key", KEY, "--folder", folder]),
    { project: undefined, email: undefined, url: `https://${REF}.supabase.co`, key: KEY, newPassword: false, secondFactor: false, folder, owner: true });
  assert.throws(() => options(["--owner", "--url", `https://${REF}.supabase.co`, "--key", KEY]), /--owner takes --url, --key and --folder/);
  assert.throws(() => options(["--owner", "--url", `https://${REF}.supabase.co`, "--key", KEY, "--folder", folder, "--email", USER.email]), /--owner takes --url, --key and --folder/);
  assert.throws(() => options(["--owner", "--url", `https://${REF}.supabase.co`, "--key", KEY, "--folder", folder, "--new-password"]), /--owner takes --url, --key and --folder/);
  assert.throws(() => options(["--owner", "--url", `https://${REF}.supabase.co`, "--key", KEY, "--folder", folder, "--second-factor"]), /--owner takes --url, --key and --folder/);
  assert.equal(options(["--project", REF, "--email", USER.email, "--second-factor"]).secondFactor, true);
  // There is no first sign-in with an invitation code.
  assert.throws(() => options(["--join", "--url", `https://${REF}.supabase.co`, "--key", KEY]), /unknown option --join/);
});

const REFUSAL = "This function books valuations only for the High Street office, and Station Road is another. Nothing was booked.";
/** An agent folder, with a subfolder. */
function agentFolder(dir) {
  const folder = join(dir, "agent");
  mkdirSync(join(folder, "sub"), { recursive: true });
  return folder;
}

/** An agent folder holding a file to upload and a hidden file, and one file beside it, outside. It was the upload folder
 * before the agent folder was the only folder, and a test of an older setup still uses it as one. */
function uploads(dir) {
  const folder = join(dir, "uploads");
  mkdirSync(join(folder, "sub"), { recursive: true });
  writeFileSync(join(folder, "report.pdf"), "%PDF-1.7 test");
  writeFileSync(join(folder, ".DS_Store"), "hidden");
  writeFileSync(join(dir, "outside.txt"), "not for upload");
  return folder;
}

test("a file swapped for a link after it is checked is never read", async () => {
  if (process.platform === "win32") return;
  const dir = home();
  const folder = uploads(dir);
  const secret = join(dir, "secret.txt");
  const file = join(folder, "report.txt");
  writeFileSync(secret, "SECRET");
  writeFileSync(file, "report");
  // Another process swaps the checked file for a link to one outside the folder, and back.
  // It stops on its own after five seconds, so a killed test run cannot leave it behind.
  const swapper = spawn(process.execPath, ["-e", `
    const fs = require("fs");
    const file = ${JSON.stringify(file)}, secret = ${JSON.stringify(secret)};
    for (const until = Date.now() + 5000; Date.now() < until;) {
      fs.writeFileSync(file + ".reg", "report"); fs.renameSync(file + ".reg", file);
      try { fs.unlinkSync(file + ".lnk"); } catch {}
      fs.symlinkSync(secret, file + ".lnk"); fs.renameSync(file + ".lnk", file);
    }`], { stdio: "ignore" });
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    let read = 0, refused = 0;
    for (const until = Date.now() + 1500; Date.now() < until;) {
      const out = uploadSource(folder, file);
      if (!out.ok) { refused++; continue; }
      read++;
      assert.equal(out.body.toString(), "report");
    }
    // The swap was really running: it was still alive, and it was seen and refused.
    assert.equal(swapper.exitCode, null);
    assert.ok(refused > 0);
    assert.ok(read > 0);
  } finally {
    swapper.kill();
  }
});

test("only a file directly in the agent folder is read, so no folder on its path can be swapped", () => {
  const dir = home();
  const folder = uploads(dir);
  mkdirSync(join(folder, "nested"), { recursive: true });
  writeFileSync(join(folder, "nested", "report.txt"), "report");
  writeFileSync(join(folder, "report.txt"), "report");

  assert.match(uploadSource(folder, join(folder, "nested", "report.txt")).problem, /Only files directly inside it/);
  assert.equal(uploadSource(folder, join(folder, "report.txt")).body.toString(), "report");
});


test("a folder an earlier fabrik setup made keeps its uploads folder, whose files no longer upload, and a file directly in the folder uploads", () => {
  const dir = home();
  const agent = join(dir, "admin-folder");
  mkdirSync(join(agent, "uploads"), { recursive: true });
  writeFileSync(join(agent, "uploads", "workbook.xlsx"), "workbook");
  writeFileSync(join(agent, "note.md"), "note");

  assert.equal(uploadSource(agent, join(agent, "note.md")).body.toString(), "note", "a file directly in the agent folder uploads");
  assert.equal(uploadSource(agent, join(agent, "uploads", "workbook.xlsx")).problem, `${join(agent, "uploads", "workbook.xlsx")} is in a folder within the agent folder, ${agent}. Only files directly inside it can be uploaded.`);
});

test("a named pipe in the agent folder is refused at once rather than waited on", () => {
  if (process.platform === "win32") return;
  const dir = home();
  const folder = uploads(dir);
  execFileSync("mkfifo", [join(folder, "pipe")]);

  const out = uploadSource(folder, join(folder, "pipe"));

  assert.equal(out.ok, false);
  assert.match(out.problem, /is not a file/);
});

/** Python's pty module gives the sign-in a real terminal, which Node cannot open on its own. */
const PTY = `
import os, pty, sys, time, select, json
steps = [s.split("=>", 1) for s in sys.argv[2:]]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], [sys.argv[1], os.environ["SIGN_IN"]] + json.loads(os.environ.get("SIGN_IN_ARGS", "[]")))
out = b""
def pump(until, timeout):
    global out
    start, end = len(out), time.time() + timeout
    while time.time() < end:
        if select.select([fd], [], [], 0.1)[0]:
            try: chunk = os.read(fd, 4096)
            except OSError: return False
            if not chunk: return False
            out += chunk
            if until and until.encode() in out[start:]: return True
    return until is None
for prompt, answer in steps:
    if not pump(prompt, 10): break
    os.write(fd, answer.encode() + b"\\r")
pump(None, 3)
sys.stdout.write(out.decode(errors="replace"))
`;
const python = spawnSync("python3", ["-c", "import pty"]).status === 0;

test("the sign-in answers every question in a real terminal, and echoes no password", { skip: process.platform === "win32" || !python }, async () => {
  const dir = home();
  const project = await supabase();
  try {
    const run = spawn("python3", ["-c", PTY, process.execPath,
      `Project URL: =>${project.url}`, `Project reference: =>${REF}`, `Publishable key: =>${KEY}`, `Email: =>${USER.email}`, "Password: =>first-password"],
      { env: { ...process.env, HOME: dir, SIGN_IN: join(PLUGIN, "cli", "sign-in.mjs") } });
    let out = "";
    run.stdout.on("data", chunk => { out += chunk; });
    await new Promise(done => run.on("exit", done));

    assert.match(out, new RegExp(`Signed in as ${USER.email}`));
    assert.equal(out.includes("first-password"), false);
    // Each answer is echoed once, by the script, and never a second time by the terminal.
    assert.equal(out.split(KEY).length - 1, 1);
    assert.equal(JSON.parse(readFileSync(sessionPath(REF, USER.email), "utf-8")).refreshToken, "rt-1");
  } finally {
    await project.close();
  }
});

test("sign-in --folder refuses a folder that does not exist before any question, and --upload-folder is no option", () => {
  const dir = mkdtempSync(join(tmpdir(), "actor-options-"));
  mkdirSync(join(dir, "uploads"));
  assert.deepEqual(options(["--email", USER.email, "--folder", dir]), { project: undefined, email: USER.email, url: undefined, key: undefined, newPassword: false, secondFactor: false, folder: dir, owner: false });
  assert.throws(() => options(["--folder", join(dir, "missing")]), /given as --folder, is not a folder/);
  assert.throws(() => options(["--folder", dir, "--upload-folder", join(dir, "uploads")]), /unknown option --upload-folder\. Usage: node sign-in\.mjs .*\[--folder <session folder>\]$/);
  assert.doesNotMatch(USAGE, /upload/);
});

