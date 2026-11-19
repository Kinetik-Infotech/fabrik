// scripts/deploy-check.mjs, run as the operator runs it: the real script, at a real terminal, with the token typed
// at its hidden prompt, against a stand-in for Supabase's Management API and a fake fabrik-apps at the project's
// functions address.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startManagementApi } from "./stand-in-management-api.mjs";
import { FUNCTIONS } from "../../../setup/build.mjs";

// How many files setup deploys fabrik-apps with, as build.mjs lists them.
const APPS_FILES = FUNCTIONS.find((f) => f.name === "fabrik-apps").files.length;

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "../../../scripts/deploy-check.mjs");
const SETUP = resolve(HERE, "../../../setup/functions/fabrik-apps");
const REF = "abcdefghijklmnopqrst";
const TOKEN = "sbp_madeup0000token1111for2222tests";
const KEY = "sb_publishable_madeup0000key";
const REFUSAL = { error: "Sign in first." };
const FILES = FUNCTIONS.find((f) => f.name === "fabrik-apps").files;

// Python's pty module gives the script a real terminal, which Node cannot open on its own. The token comes in on
// this script's stdin, in hex, so it is on no command line, and is typed at the prompt.
const PTY = `
import os, pty, sys, select, time
token = bytes.fromhex(sys.stdin.readline().strip())
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
out, typed = b"", False
while True:
    if not select.select([fd], [], [], 30)[0]: break
    try: chunk = os.read(fd, 4096)
    except OSError: break
    if not chunk: break
    out += chunk
    if not typed and out.endswith(b"token: "):
        time.sleep(0.05); os.write(fd, token); typed = True
_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode(errors="replace").replace("\\r\\n", "\\n"))
sys.exit(os.waitstatus_to_exitcode(status))
`;
const python = spawnSync("python3", ["-c", "import pty"]).status === 0;
const skip = process.platform === "win32" || !python;

/** A fake fabrik-apps at /functions/v1/fabrik-deploy-check, refusing a call with no sign-in. */
async function startFake({ silent = false, status = 401, onCall = () => {} } = {}) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, path: req.url, apikey: req.headers.apikey, body: Buffer.concat(chunks).toString("utf-8") });
    onCall();
    if (silent) return;
    if (req.url !== "/functions/v1/fabrik-deploy-check") { res.writeHead(404).end(); return; }
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(REFUSAL));
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, stop: () => new Promise(done => server.close(done)) };
}

/** Runs the script at a terminal, typing TOKEN at its prompt. Returns { code, out, argv, env, home }. */
async function run(api, url, args = ["--url", url, "--ref", REF], { extraEnv = {}, onChild = () => {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), "fabrik-deploy-check-"));
  const argv = ["-c", PTY, process.execPath, SCRIPT, ...args];
  const env = { PATH: process.env.PATH, HOME: home, FABRIK_TEST_MANAGEMENT_API: api.url, ...extraEnv };
  const child = spawn("python3", argv, { cwd: home, env });
  onChild(child);
  child.stdin.end(`${Buffer.from(`${TOKEN}\r`).toString("hex")}\n`);
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  const code = await new Promise(done => child.on("close", done));
  return { code, out, argv, env, home };
}

function filesUnder(folder) {
  const found = [];
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push(readFileSync(path, "utf-8"));
  }
  return found;
}

const intro = (api, url) => `This run talks to a test stand-in at ${api.url}, and the project's functions are at ${url}, not at Supabase. Paste no real token.\n` +
  "Make a Supabase access token at https://supabase.com/dashboard/account/tokens, with a short expiry, and paste it here. Delete it on that page afterwards.\nNothing shows as you type or paste. Do it once, then press Enter.\nSupabase access token: \n";

test("deploys every file of fabrik-apps, lists them, calls the function and prints the status and body, deletes it, and the token is in no output", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  const fake = await startFake();
  try {
    const { code, out, argv, env, home } = await run(api, fake.url);
    assert.equal(out, intro(api, fake.url) + [
      `Deployed fabrik-deploy-check from fabrik-apps's ${APPS_FILES} files, with verify_jwt off.`,
      "Listed: fabrik-deploy-check is there, verify_jwt false.",
      "Called fabrik-deploy-check with {}: status 401.",
      `Body: ${JSON.stringify(REFUSAL)}`,
      "Deleted fabrik-deploy-check.",
      "Listed again: fabrik-deploy-check is gone.",
    ].map(l => `${l}\n`).join(""));
    assert.equal(code, 0);
    const deploy = api.calls.find(c => c.method === "POST" && c.path.includes("/functions/deploy"));
    assert.equal(deploy.path, `/v1/projects/${REF}/functions/deploy?slug=fabrik-deploy-check`);
    assert.deepEqual(JSON.parse(deploy.body.fields.metadata), { entrypoint_path: "index.ts", name: "fabrik-deploy-check", verify_jwt: false });
    assert.deepEqual(deploy.body.files.map(f => [f.name, f.text]), FILES.map(n => [n, readFileSync(join(SETUP, n), "utf-8")]), "fabrik-apps' own files");
    assert.deepEqual(api.calls.filter(c => c.method !== "GET").map(c => `${c.method} ${c.path.replace(`/v1/projects/${REF}`, "")}`),
      ["POST /functions/deploy?slug=fabrik-deploy-check", "DELETE /functions/fabrik-deploy-check"]);
    assert.deepEqual(fake.seen, [{ method: "POST", path: "/functions/v1/fabrik-deploy-check", apikey: KEY, body: "{}" }], "the function got {} and the publishable key");
    assert.deepEqual(api.state.functions, [], "nothing left deployed");
    // The token reaches Supabase's Authorization header only.
    assert.ok(api.calls.every(c => c.authorization === `Bearer ${TOKEN}`));
    for (const place of [out, JSON.stringify(argv), JSON.stringify(env), ...filesUnder(home), JSON.stringify(fake.seen)])
      assert.ok(!place.includes(TOKEN), "the token is in no output, argument, environment, file or call to the project");
  } finally { await fake.stop(); await api.stop(); }
});

test("a deploy Supabase refuses: Supabase's message, a delete tried anyway, nothing called, exit 1", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN, refuse: { method: "POST", path: "/functions/deploy?slug=fabrik-deploy-check", status: 403, message: "Your token cannot deploy functions." } });
  const fake = await startFake();
  try {
    const { code, out } = await run(api, fake.url);
    assert.equal(out, intro(api, fake.url) + "Failed: Supabase refused (403): Your token cannot deploy functions.\nDeleted fabrik-deploy-check.\n");
    assert.equal(code, 1);
    assert.deepEqual(fake.seen, [], "the function was never called");
  } finally { await fake.stop(); await api.stop(); }
});

test("a function that cannot be reached is still deleted, and the run exits 1", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  const fake = await startFake();
  const url = fake.url;
  await fake.stop();
  try {
    const { code, out } = await run(api, url);
    assert.match(out, /Listed: fabrik-deploy-check is there/);
    assert.match(out, /Failed: .*\nDeleted fabrik-deploy-check\.\n$/);
    assert.equal(code, 1);
    assert.deepEqual(api.state.functions, []);
  } finally { await api.stop(); }
});

test("a project address that is not a project's, or a missing one: the usage line, exit 2, no prompt", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  try {
    for (const args of [[], ["--url", "https://example.com"], ["--url", "http://127.0.0.1:1"]]) {
      const home = mkdtempSync(join(tmpdir(), "fabrik-deploy-check-"));
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: home, env: { PATH: process.env.PATH, HOME: home, FABRIK_TEST_MANAGEMENT_API: api.url }, encoding: "utf-8" });
      assert.equal(r.stdout, "Usage: node scripts/deploy-check.mjs --url https://<project reference>.supabase.co\n");
      assert.equal(r.status, 2);
    }
  } finally { await api.stop(); }
});

test("a deploy that fails after the function was made: the function is still deleted, and the run exits 1", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  api.state.failDeployAfterCreate = true;
  const fake = await startFake();
  try {
    const { code, out } = await run(api, fake.url);
    assert.equal(out, intro(api, fake.url) + "Failed: Supabase refused (500): Internal error after the function was made.\nDeleted fabrik-deploy-check.\n");
    assert.equal(code, 1);
    assert.deepEqual(api.state.functions, [], "nothing left deployed");
    assert.deepEqual(fake.seen, []);
  } finally { await fake.stop(); await api.stop(); }
});

test("with a stand-in named, a real project address is a usage error: exit 2, no prompt", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  try {
    for (const args of [["--url", `https://${REF}.supabase.co`], ["--url", `https://${REF}.supabase.co`, "--ref", REF]]) {
      const home = mkdtempSync(join(tmpdir(), "fabrik-deploy-check-"));
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: home, env: { PATH: process.env.PATH, HOME: home, FABRIK_TEST_MANAGEMENT_API: api.url }, encoding: "utf-8" });
      assert.equal(r.stdout, "Usage: node scripts/deploy-check.mjs --url https://<project reference>.supabase.co\n");
      assert.equal(r.status, 2);
    }
    assert.deepEqual(api.calls, [], "Supabase was not called");
  } finally { await api.stop(); }
});

test("a function that never answers: the call times out, the function is deleted, exit 1", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  const fake = await startFake({ silent: true });
  try {
    const { code, out } = await run(api, fake.url, undefined, { extraEnv: { FABRIK_TEST_CALL_TIMEOUT_MS: "500" } });
    assert.match(out, /Listed: fabrik-deploy-check is there/);
    assert.match(out, /Failed: fabrik-deploy-check gave no answer in 0\.5 seconds\.\nDeleted fabrik-deploy-check\.\n$/);
    assert.equal(code, 1);
    assert.deepEqual(api.state.functions, []);
  } finally { await fake.stop(); await api.stop(); }
});

test("Ctrl-C while the function is running: the function is deleted before the script exits 1", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  let child;
  const fake = await startFake({ silent: true, onCall: () => { spawnSync("pkill", ["-INT", "-P", String(child.pid)]); } });
  try {
    const { code, out } = await run(api, fake.url, undefined, { onChild: c => { child = c; } });
    assert.match(out, /Stopped\.\nDeleted fabrik-deploy-check\.\n$/);
    assert.equal(code, 1);
    assert.deepEqual(api.state.functions, []);
  } finally { await fake.stop(); await api.stop(); }
});

test("a function Supabase cannot start, answering 503: it is deleted, and the run says so and exits 1", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  const fake = await startFake({ status: 503 });
  try {
    const { code, out } = await run(api, fake.url);
    assert.ok(out.includes("Called fabrik-deploy-check with {}: status 503.\n"), out);
    assert.ok(out.endsWith("Listed again: fabrik-deploy-check is gone.\nfabrik-deploy-check did not start: Supabase answered 503.\n"), out);
    assert.equal(code, 1);
    assert.deepEqual(api.state.functions, [], "nothing left deployed");
  } finally { await fake.stop(); await api.stop(); }
});
