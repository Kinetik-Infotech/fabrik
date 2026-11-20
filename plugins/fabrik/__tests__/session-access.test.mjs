// sessionAccess against a stand-in for Supabase Auth's token renewal, which counts renewals, swaps the refresh token
// on each, refuses a used one, and can answer 429. Each test signs in to a home folder of its own.
// Run with: node scripts/test.mjs plugins/fabrik/__tests__/session-access.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RATE_LIMITED, sessionAccess, sessionPath, writeSession } from "../cli/lib/session.mjs";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const SESSION = join(PLUGIN, "cli", "lib", "session.mjs");
const OPEN_ACCESS = join(PLUGIN, "cli", "fabrik-session.mjs");
const REF = "abcdefghijklmnopqrst";
const EMAIL = "person@example.com";

/** The stand-in: its address, its renewal count, and a switch for 429. Each renewal waits 200 ms. */
async function standIn(t) {
  const state = { renewals: 0, limited: false, live: "refresh-0" };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => setTimeout(() => {
      const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (state.limited) return send(429, { error_code: "over_request_rate_limit", msg: "Request rate limit reached" });
      if (JSON.parse(body).refresh_token !== state.live) return send(400, { error_code: "refresh_token_already_used", msg: "Invalid Refresh Token: Already Used" });
      state.renewals += 1;
      state.live = `refresh-${state.renewals}`;
      send(200, { access_token: `access-${state.renewals}`, refresh_token: state.live, expires_in: 3600, user: { email: EMAIL } });
    }, 200));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, state };
}

/** A home folder of its own, with a saved sign-in and no access token. */
function signedIn(t, url) {
  const home = mkdtempSync(join(tmpdir(), "session-access-"));
  const before = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = before; });
  writeSession(REF, EMAIL, { projectRef: REF, url, publishableKey: "key", email: EMAIL, refreshToken: "refresh-0" });
  return home;
}

test("40 calls in one process renew once", async t => {
  const { url, state } = await standIn(t);
  signedIn(t, url);
  for (let i = 0; i < 40; i++) assert.equal((await sessionAccess(REF, EMAIL)).token, "access-1");
  assert.equal(state.renewals, 1);
});

test("10 processes started together on an expired token renew once, and all get a token", async t => {
  const { url, state } = await standIn(t);
  const home = signedIn(t, url);
  const script = `import(${JSON.stringify(SESSION)}).then(m => m.sessionAccess(${JSON.stringify(REF)}, ${JSON.stringify(EMAIL)})).then(a => console.log(a.ok ? a.token : a.problem))`;
  const run = () => new Promise(done => {
    const child = spawn(process.execPath, ["-e", script], { env: { ...process.env, HOME: home, USERPROFILE: home } });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("close", () => done(out.trim()));
  });
  const tokens = await Promise.all(Array.from({ length: 10 }, run));
  assert.deepEqual(tokens, Array(10).fill("access-1"));
  assert.equal(state.renewals, 1);
});

test("openAccess in 10 processes started together, then 5 in a row, renews once", async t => {
  const { url, state } = await standIn(t);
  const home = signedIn(t, url);
  const script = `import(${JSON.stringify(OPEN_ACCESS)}).then(m => m.openAccess({ project: ${JSON.stringify(REF)}, email: ${JSON.stringify(EMAIL)} })).then(a => console.log(a.ok ? a.access.token : a.problem))`;
  const run = () => new Promise(done => {
    const child = spawn(process.execPath, ["-e", script], { env: { ...process.env, HOME: home, USERPROFILE: home } });
    let out = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.on("close", () => done(out.trim()));
  });
  assert.deepEqual(await Promise.all(Array.from({ length: 10 }, run)), Array(10).fill("access-1"));
  for (let i = 0; i < 5; i++) assert.equal(await run(), "access-1");
  assert.equal(state.renewals, 1);
});

test("a lock 31 seconds old is removed and the renewal goes ahead", async t => {
  const { url, state } = await standIn(t);
  signedIn(t, url);
  const lock = `${sessionPath(REF, EMAIL)}.lock`;
  writeFileSync(lock, "1");
  const old = (Date.now() - 31_000) / 1000;
  utimesSync(lock, old, old);
  assert.equal((await sessionAccess(REF, EMAIL)).token, "access-1");
  assert.equal(state.renewals, 1);
});

test("Supabase's rate limit is reported as a wait, and the saved refresh token is kept", async t => {
  const { url, state } = await standIn(t);
  signedIn(t, url);
  state.limited = true;
  const answer = await sessionAccess(REF, EMAIL);
  assert.equal(answer.ok, false);
  assert.equal(answer.rateLimited, true);
  assert.equal(answer.problem, RATE_LIMITED);
  assert.equal(JSON.parse(readFileSync(sessionPath(REF, EMAIL), "utf8")).refreshToken, "refresh-0");
});
