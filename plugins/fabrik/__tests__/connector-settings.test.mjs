// fabrik connector-settings, run as the owner runs it: the real command, at a real terminal, with the token typed at
// its hidden prompt, against a stand-in for Supabase's Management API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { authConfig, signingKey, startManagementApi } from "./stand-in-management-api.mjs";
import { apiBase, API } from "../cli/connector-settings.mjs";

const FABRIK = resolve(dirname(fileURLToPath(import.meta.url)), "../cli/fabrik.mjs");
const REF = "abcdefghijklmnopqrst";
const URL_ = `https://${REF}.supabase.co`;
const PAGES = "https://fabrik-sign-in-3x7.pages.dev";
const TOKEN = "sbp_madeup0000token1111for2222tests";
const SITE = `${PAGES}/prod`;
/** What the command prints before its prompt, run against the stand-in at url: first that it is a stand-in. */
const intro = url => `This run talks to a test stand-in at ${url}, not to Supabase. Paste no real token.\n` + "Make a Supabase access token at https://supabase.com/dashboard/account/tokens, with a short expiry, and paste it here. Delete it on that page once every line says done.\nNothing shows as you type or paste. Do it once, then press Enter.\nSupabase access token: \n";
const CREATED = "Asymmetric signing key: created. Run this command again in 20 minutes to start using it.";
const WAIT = "Asymmetric signing key: Supabase asks to wait. Run this command again in 5 minutes.";

/**
 * Python's pty module gives the command a real terminal, which Node cannot open on its own. What is typed comes in on
 * this script's stdin, in hex, so it is on no command line, and is typed at the prompt as a person pastes it, with
 * the key that ends it.
 */
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

/** Runs fabrik connector-settings at a terminal, typing typed at its prompt, then end. Returns { code, out, argv, env, home }. */
async function run(api, typed, args = ["--url", URL_, "--site", PAGES], end = "\r") {
  const home = mkdtempSync(join(tmpdir(), "fabrik-connector-settings-"));
  const argv = ["-c", PTY, process.execPath, FABRIK, "connector-settings", ...args];
  const env = { PATH: process.env.PATH, HOME: home, FABRIK_TEST_MANAGEMENT_API: api.url };
  const child = spawn("python3", argv, { cwd: home, env });
  child.stdin.end(`${Buffer.from(typed + end).toString("hex")}\n`);
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  const code = await new Promise(done => child.on("close", done));
  return { code, out, argv, env, home };
}

const DONE = [
  "OAuth server, with dynamic OAuth apps: done.",
  "Authorization path /oauth/consent: done.",
  `Site URL ${SITE}: done.`,
  "Public sign-up off: done.",
];
const ALREADY = DONE.map(l => l.replace(": done.", ": already done."));
const lines = list => list.map(l => `${l}\n`).join("");
const writes = api => api.calls.filter(c => c.method !== "GET");
const asked = api => api.calls.map(c => `${c.method} ${c.path.replace(`/v1/projects/${REF}`, "")}`);

/** Every file under folder, read, so a test can say the token is in none of them. */
function filesUnder(folder) {
  const found = [];
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) found.push(...filesUnder(path));
    else found.push(readFileSync(path, "utf-8"));
  }
  return found;
}

test("first run on a project on the legacy JWT secret: it imports the secret, creates an ES256 key on standby, makes the four auth settings, and exits 3 to be run again", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  try {
    const { code, out } = await run(api, TOKEN);
    assert.equal(out, intro(api.url) + lines([CREATED, ...DONE]));
    assert.equal(code, 3, "3 means run again later");
    const key = api.calls.find(c => c.method === "POST" && c.path.endsWith("/signing-keys"));
    assert.deepEqual(key.body, { algorithm: "ES256", status: "standby" }, "the new key starts on standby, as the dashboard makes it");
    assert.deepEqual(asked(api), [
      "GET /config/auth/signing-keys",
      "GET /config/auth/signing-keys/legacy",
      "POST /config/auth/signing-keys/legacy",
      "GET /config/auth/signing-keys",
      "POST /config/auth/signing-keys",
      "GET /config/auth",
      "PATCH /config/auth",
      "GET /config/auth/signing-keys",
      "GET /config/auth",
    ], "no key is put in use in the run that creates it");
    assert.deepEqual(api.calls.find(c => c.method === "PATCH" && c.path.endsWith("/config/auth")).body, {
      oauth_server_enabled: true, oauth_server_allow_dynamic_registration: true, oauth_server_authorization_path: "/oauth/consent", site_url: SITE, disable_signup: true });
    // The legacy secret stays the key in use, and the new key waits on standby while Supabase's caches pick it up.
    assert.deepEqual(api.state.keys.map(k => [k.algorithm, k.status]), [["HS256", "in_use"], ["ES256", "standby"]]);
  } finally { await api.stop(); }
});

test("second run, 20 minutes later: the standby key is put in use, the legacy secret is kept as previously used, and it exits 0", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  try {
    assert.equal((await run(api, TOKEN)).code, 3);
    api.state.keyChangedAt -= 20 * 60 * 1000;
    const before = api.calls.length;
    const { code, out } = await run(api, TOKEN);
    assert.equal(out, intro(api.url) + lines(["Asymmetric signing key: done.", ...ALREADY]));
    assert.equal(code, 0);
    const id = api.state.keys.find(k => k.algorithm === "ES256").id;
    assert.deepEqual(api.calls.slice(before).filter(c => c.method !== "GET").map(c => [`${c.method} ${c.path.replace(`/v1/projects/${REF}`, "")}`, c.body]),
      [[`PATCH /config/auth/signing-keys/${id}`, { status: "in_use" }]], "the one write is the standby key put in use");
    // The legacy secret is kept as a previously used key, so tokens it signed stay valid until they expire.
    assert.deepEqual(api.state.keys.map(k => [k.algorithm, k.status]), [["HS256", "previously_used"], ["ES256", "in_use"]]);
  } finally { await api.stop(); }
});

test("a second run Supabase throttles: the wait line, exit 3, and the key stays on standby", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  try {
    assert.equal((await run(api, TOKEN)).code, 3);
    const { code, out } = await run(api, TOKEN);
    assert.equal(out, intro(api.url) + lines([WAIT, ...ALREADY]));
    assert.equal(code, 3);
    assert.equal(api.calls.filter(c => c.method === "PATCH" && /signing-keys\//.test(c.path)).length, 1, "it asked once, and Supabase said wait");
    assert.deepEqual(api.state.keys.map(k => [k.algorithm, k.status]), [["HS256", "in_use"], ["ES256", "standby"]]);
  } finally { await api.stop(); }
});

test("a token pasted between a terminal's paste markers, or ended with Ctrl-D, reaches Supabase as the token alone", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN, keys: [signingKey("ES256", "in_use")] });
  try {
    const pasted = await run(api, `\u001b[200~${TOKEN}\u001b[201~`);
    assert.equal(pasted.out, intro(api.url) + lines(["Asymmetric signing key: already done.", ...DONE]));
    assert.equal(pasted.code, 0);
    const ended = await run(api, TOKEN, undefined, "\u0004");
    assert.equal(ended.out, intro(api.url) + lines(["Asymmetric signing key: already done.", ...ALREADY]));
    assert.equal(ended.code, 0);
    assert.ok(api.calls.every(c => c.authorization === `Bearer ${TOKEN}`), "no marker or Ctrl-D is in the token");
  } finally { await api.stop(); }
});

test("a project already done: five lines already done, and no write call", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN, keys: [signingKey("ES256", "in_use")],
    config: authConfig({ site_url: SITE, oauth_server_enabled: true, oauth_server_allow_dynamic_registration: true, oauth_server_authorization_path: "/oauth/consent", disable_signup: true }) });
  try {
    const { code, out } = await run(api, TOKEN);
    assert.equal(out, intro(api.url) + [
      "Asymmetric signing key: already done.",
      "OAuth server, with dynamic OAuth apps: already done.",
      "Authorization path /oauth/consent: already done.",
      `Site URL ${SITE}: already done.`,
      "Public sign-up off: already done.",
    ].map(l => `${l}\n`).join(""));
    assert.equal(code, 0);
    assert.deepEqual(writes(api), []);
  } finally { await api.stop(); }
});

test("a project with an RS256 key in use and the OAuth server off: the key is left alone, and only the auth settings are made", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN, keys: [signingKey("HS256", "previously_used"), signingKey("RS256", "in_use")] });
  try {
    const { code, out } = await run(api, TOKEN);
    assert.match(out, /^Asymmetric signing key: already done\.$/m);
    assert.match(out, /^OAuth server, with dynamic OAuth apps: done\.$/m);
    assert.equal(code, 0);
    assert.deepEqual(writes(api).map(c => `${c.method} ${c.path.replace(`/v1/projects/${REF}`, "")}`), ["PATCH /config/auth"]);
  } finally { await api.stop(); }
});

test("a token Supabase refuses: the refusal line, exit 1, and no write call", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  try {
    const { code, out } = await run(api, "sbp_not_the_owners_token");
    assert.equal(out, `${intro(api.url)}Supabase refused the token: Unauthorized. Make a new one at https://supabase.com/dashboard/account/tokens, and run this again.\n`);
    assert.equal(code, 1);
    assert.deepEqual(writes(api), []);
  } finally { await api.stop(); }
});

test("a call Supabase turns down: its own message, exit 1, and nothing after it", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN, keys: [signingKey("ES256", "in_use")],
    refuse: { method: "PATCH", path: "/config/auth", status: 402, message: "OAuth server is not available on the Free plan" } });
  try {
    const { code, out } = await run(api, TOKEN);
    assert.equal(out, `${intro(api.url)}OAuth server and Site URL: failed. Supabase said: OAuth server is not available on the Free plan\n`);
    assert.equal(code, 1);
    assert.equal(asked(api).at(-1), "PATCH /config/auth", "it stops at the refused call");
  } finally { await api.stop(); }
});

test("a bad sign-in page or project address stops before the prompt, with no call made", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  try {
    for (const [args, said] of [
      [["--url", URL_, "--site", "fabrik-sign-in.pages.dev"], "fabrik-sign-in.pages.dev is not a web address such as https://fabrik-sign-in.pages.dev."],
      [["--url", URL_, "--site", "http://fabrik-sign-in.pages.dev"], "is not a web address"],
      [["--url", URL_, "--site", `${PAGES}/prod`], "is not a web address"],
      [["--url", URL_, "--site", "https://localhost"], "is not a web address"],
      [["--url", "https://abc.supabase.co", "--site", PAGES], "https://abc.supabase.co is not a Supabase project's address"],
      [["--url", `http://${REF}.supabase.co`, "--site", PAGES], "is not a Supabase project's address"],
      [["--url", `https://${REF}.example.com`, "--site", PAGES], "is not a Supabase project's address"],
      [["--site", PAGES], "connector-settings needs --url and --site."],
    ]) {
      const { code, out } = await run(api, TOKEN, args);
      assert.equal(code, 2, args.join(" "));
      assert.ok(out.includes(said), `${args.join(" ")}: ${out}`);
      assert.ok(!out.includes("Supabase access token:"), "no prompt is shown");
    }
    assert.deepEqual(api.calls, []);
  } finally { await api.stop(); }
});

test("the token goes to Supabase in the Authorization header alone: it is in no argument, no environment variable, no output and no file", { skip }, async () => {
  const api = await startManagementApi({ ref: REF, token: TOKEN });
  try {
    const { code, out, argv, env, home } = await run(api, TOKEN);
    assert.equal(code, 3, "a project on the legacy secret is run again later");
    assert.ok(api.calls.length > 0 && api.calls.every(c => c.authorization === `Bearer ${TOKEN}`), "every call carries it");
    assert.ok(!api.calls.some(c => JSON.stringify(c.body ?? "").includes(TOKEN)), "no body carries it");
    assert.ok(!argv.some(a => a.includes(TOKEN)), "no argument");
    assert.ok(!Object.values(env).some(v => v.includes(TOKEN)), "no environment variable");
    assert.ok(!out.includes(TOKEN), "the terminal never shows it");
    assert.ok(!filesUnder(home).some(text => text.includes(TOKEN)), "no file in the home or working folder");
  } finally { await api.stop(); }
});

test("only a loopback http address stands in for the Management API", () => {
  assert.equal(API, "https://api.supabase.com");
  assert.equal(apiBase({}), API);
  assert.equal(apiBase({ FABRIK_TEST_MANAGEMENT_API: "http://127.0.0.1:5123" }), "http://127.0.0.1:5123");
  assert.equal(apiBase({ FABRIK_TEST_MANAGEMENT_API: "http://localhost:5123" }), "http://localhost:5123");
  for (const other of ["https://evil.example.com", "http://10.0.0.5:80", "http://127.0.0.1.example.com:80", "http://127.0.0.1:5123/path"])
    assert.equal(apiBase({ FABRIK_TEST_MANAGEMENT_API: other }), API, other);
});
