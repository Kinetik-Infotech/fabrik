import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { confinedPath } from "./content-path.mjs";
import { toolsForProfile } from "./policy.mjs";
import { pagesBranch, TOOLS } from "./tools.mjs";
import { configDir, credentials, missingFolderHint, readConnection, readToken } from "./api.mjs";

const expected = [
  "cf_whoami",
  "cf_zones_list",
  "cf_zone_for_hostname",
  "cf_dns_list",
  "cf_dns_upsert",
  "cf_pages_projects_list",
  "cf_pages_project_create",
  "cf_pages_domain_add",
  "cf_pages_deploy",
];

test("pages-dns exposes only its allowlist and token creation is absent from the source table", () => {
  assert.deepEqual(toolsForProfile(TOOLS, "pages-dns").map(tool => tool.name), expected);
  assert.equal(TOOLS.some(tool => tool.name === "cf_token_create"), false);
});

test("the sole profile defaults safely and unknown profiles fail closed", () => {
  assert.deepEqual(toolsForProfile(TOOLS, undefined).map(tool => tool.name), expected);
  assert.deepEqual(toolsForProfile(TOOLS, "").map(tool => tool.name), expected);
  assert.throws(() => toolsForProfile(TOOLS, "full"), /unknown.*fails closed/i);
});

test("agent guidance names the variables a person sets", () => {
  const skill = readFileSync(fileURLToPath(new URL("../../skills/cloudflare/SKILL.md", import.meta.url)), "utf-8");
  for (const name of ["FABRIK_SECRETS", "FABRIK_WRANGLER", "CLOUDFLARE_CONTENT_ROOT", "CLOUDFLARE_CONFIG_DIR", "CLOUDFLARE_PROFILE", "fabrik-cloudflare"])
    assert.match(skill, new RegExp(name));
  assert.match(skill, /Never ask for a token in chat/);
});

test("the default settings folder is ~/.config/fabrik-cloudflare", () => {
  const before = { config: process.env.CLOUDFLARE_CONFIG_DIR, secrets: process.env.FABRIK_SECRETS };
  try {
    delete process.env.CLOUDFLARE_CONFIG_DIR;
    delete process.env.FABRIK_SECRETS;
    assert.equal(configDir(), join(homedir(), ".config", "fabrik-cloudflare"));
  } finally {
    if (before.config === undefined) delete process.env.CLOUDFLARE_CONFIG_DIR; else process.env.CLOUDFLARE_CONFIG_DIR = before.config;
    if (before.secrets === undefined) delete process.env.FABRIK_SECRETS; else process.env.FABRIK_SECRETS = before.secrets;
  }
});

test("FABRIK_SECRETS wins over CLOUDFLARE_CONFIG_DIR", () => {
  const before = { config: process.env.CLOUDFLARE_CONFIG_DIR, secrets: process.env.FABRIK_SECRETS };
  try {
    delete process.env.CLOUDFLARE_CONFIG_DIR;
    process.env.FABRIK_SECRETS = "/fixture/agent-secrets";
    assert.equal(configDir(), "/fixture/agent-secrets");
    process.env.CLOUDFLARE_CONFIG_DIR = "/fixture/explicit";
    assert.equal(configDir(), "/fixture/agent-secrets");
    delete process.env.FABRIK_SECRETS;
    assert.equal(configDir(), "/fixture/explicit");
  } finally {
    if (before.config === undefined) delete process.env.CLOUDFLARE_CONFIG_DIR; else process.env.CLOUDFLARE_CONFIG_DIR = before.config;
    if (before.secrets === undefined) delete process.env.FABRIK_SECRETS; else process.env.FABRIK_SECRETS = before.secrets;
  }
});

test("strict connection documents win over inherited and legacy credentials", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloudflare-connection-"));
  chmodSync(root, 0o700);
  writeFileSync(join(root, "cloudflare.env"), "CLOUDFLARE_API_TOKEN=legacy-fixture\n", { mode: 0o600 });
  const document = { version: 1, apiToken: "json-fixture", accountId: "a".repeat(32), accountName: "Fixture", connectedAt: "2026-09-05T00:00:00Z" };
  writeFileSync(join(root, "cloudflare.json"), JSON.stringify(document), { mode: 0o600 });
  const before = {
    config: process.env.CLOUDFLARE_CONFIG_DIR,
    token: process.env.CLOUDFLARE_API_TOKEN,
    account: process.env.CLOUDFLARE_ACCOUNT_ID,
  };
  try {
    process.env.CLOUDFLARE_CONFIG_DIR = root;
    process.env.CLOUDFLARE_API_TOKEN = "inherited-fixture";
    process.env.CLOUDFLARE_ACCOUNT_ID = "b".repeat(32);
    assert.deepEqual(readConnection(), document);
    assert.equal(readToken(), document.apiToken);
    let fetched = false;
    assert.deepEqual(await credentials(async () => { fetched = true; throw new Error("must not fetch"); }), {
      ok: true, creds: { token: document.apiToken, accountId: document.accountId }, problem: null,
    });
    assert.equal(fetched, false);
  } finally {
    if (before.config === undefined) delete process.env.CLOUDFLARE_CONFIG_DIR; else process.env.CLOUDFLARE_CONFIG_DIR = before.config;
    if (before.token === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = before.token;
    if (before.account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = before.account;
  }
});

test("with FABRIK_SECRETS set, no other credential is read", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloudflare-disconnected-"));
  chmodSync(root, 0o700);
  writeFileSync(join(root, "cloudflare.env"), "CLOUDFLARE_API_TOKEN=legacy-fixture\n", { mode: 0o600 });
  const before = {
    secrets: process.env.FABRIK_SECRETS,
    config: process.env.CLOUDFLARE_CONFIG_DIR,
    token: process.env.CLOUDFLARE_API_TOKEN,
    account: process.env.CLOUDFLARE_ACCOUNT_ID,
  };
  try {
    process.env.FABRIK_SECRETS = root;
    process.env.CLOUDFLARE_CONFIG_DIR = root;
    process.env.CLOUDFLARE_API_TOKEN = "inherited-fixture";
    process.env.CLOUDFLARE_ACCOUNT_ID = "b".repeat(32);
    assert.equal(readToken(), null);
    let fetched = false;
    const result = await credentials(async () => { fetched = true; throw new Error("must not fetch"); });
    assert.equal(result.ok, false);
    assert.match(result.problem, /not connected/i);
    assert.doesNotMatch(JSON.stringify(result), /legacy-fixture|inherited-fixture/);
    assert.equal(fetched, false);
  } finally {
    if (before.secrets === undefined) delete process.env.FABRIK_SECRETS; else process.env.FABRIK_SECRETS = before.secrets;
    if (before.config === undefined) delete process.env.CLOUDFLARE_CONFIG_DIR; else process.env.CLOUDFLARE_CONFIG_DIR = before.config;
    if (before.token === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = before.token;
    if (before.account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = before.account;
  }
});

test("legacy token files remain usable when no connection document exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloudflare-legacy-"));
  writeFileSync(join(root, "cloudflare.env"), "CLOUDFLARE_API_TOKEN=legacy-fixture\n", { mode: 0o600 });
  const before = process.env.CLOUDFLARE_CONFIG_DIR;
  try {
    process.env.CLOUDFLARE_CONFIG_DIR = root;
    const result = await credentials(async () => new Response(JSON.stringify({ success: true, result: [{ id: "b".repeat(32), name: "Legacy" }] }), { status: 200 }));
    assert.equal(result.ok && result.creds.accountId, "b".repeat(32));
  } finally {
    if (before === undefined) delete process.env.CLOUDFLARE_CONFIG_DIR; else process.env.CLOUDFLARE_CONFIG_DIR = before;
  }
});

test("malformed connection documents refuse without exposing contents or falling back", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloudflare-malformed-"));
  const secret = "malformed-fixture-secret";
  writeFileSync(join(root, "cloudflare.env"), "CLOUDFLARE_API_TOKEN=legacy-fixture\n", { mode: 0o600 });
  writeFileSync(join(root, "cloudflare.json"), JSON.stringify({ version: 1, apiToken: secret }), { mode: 0o600 });
  const before = process.env.CLOUDFLARE_CONFIG_DIR;
  try {
    process.env.CLOUDFLARE_CONFIG_DIR = root;
    const result = await credentials();
    assert.equal(result.ok, false);
    assert.match(result.problem, /invalid/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.doesNotMatch(JSON.stringify(result), /legacy-fixture/);
  } finally {
    if (before === undefined) delete process.env.CLOUDFLARE_CONFIG_DIR; else process.env.CLOUDFLARE_CONFIG_DIR = before;
  }
});

test("Pages deployments default to preview and require an explicit production branch", () => {
  assert.equal(pagesBranch(undefined), "preview");
  assert.equal(pagesBranch("main"), "main");
  const deploy = TOOLS.find(tool => tool.name === "cf_pages_deploy");
  assert.match(deploy.schema.properties.branch.description, /Defaults to preview/);
  assert.match(deploy.schema.properties.branch.description, /production branch explicitly/);
});

test("Pages deployment invokes only the configured Wrangler entry", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cloudflare-wrangler-")));
  const content = join(base, "content");
  const wrangler = join(base, "server", "node_modules", "wrangler", "bin", "wrangler.js");
  const log = join(base, "invocation.json");
  mkdirSync(content);
  mkdirSync(join(wrangler, ".."), { recursive: true });
  writeFileSync(wrangler, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.FIXTURE_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), token: Boolean(process.env.CLOUDFLARE_API_TOKEN), account: process.env.CLOUDFLARE_ACCOUNT_ID })); console.log("https://fixture.pages.dev");`);
  const before = { root: process.env.CLOUDFLARE_CONTENT_ROOT, wrangler: process.env.FABRIK_WRANGLER, log: process.env.FIXTURE_LOG };
  try {
    process.env.CLOUDFLARE_CONTENT_ROOT = content;
    process.env.FABRIK_WRANGLER = wrangler;
    process.env.FIXTURE_LOG = log;
    const deploy = TOOLS.find(tool => tool.name === "cf_pages_deploy");
    const result = await deploy.handler({ token: "fixture-token", accountId: "a".repeat(32) }, { project: "fixture", directory: content });
    assert.deepEqual(result, { ok: true, result: { project: "fixture", url: "https://fixture.pages.dev" }, problem: null });
    assert.deepEqual(JSON.parse(readFileSync(log, "utf-8")), {
      args: ["pages", "deploy", realpathSync(content), "--project-name", "fixture", "--branch=preview"],
      cwd: realpathSync(content), token: true, account: "a".repeat(32),
    });
  } finally {
    for (const [key, value] of Object.entries(before)) {
      const env = key === "root" ? "CLOUDFLARE_CONTENT_ROOT" : key === "wrangler" ? "FABRIK_WRANGLER" : "FIXTURE_LOG";
      if (value === undefined) delete process.env[env]; else process.env[env] = value;
    }
  }
});

test("Pages deployment runs where the handlers are, and refuses a root the site is not under", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cloudflare-wrangler-root-")));
  const content = join(base, "content");
  // The artifact: functions/ and wrangler.toml beside the published directory, never inside it.
  const site = join(content, "site");
  const elsewhere = join(content, "elsewhere");
  const wrangler = join(base, "server", "node_modules", "wrangler", "bin", "wrangler.js");
  const log = join(base, "invocation.json");
  mkdirSync(site, { recursive: true });
  mkdirSync(join(content, "functions", "api"), { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  mkdirSync(join(wrangler, ".."), { recursive: true });
  writeFileSync(wrangler, `import { writeFileSync } from "node:fs"; writeFileSync(process.env.FIXTURE_LOG, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); console.log("https://fixture.pages.dev");`);
  const before = { root: process.env.CLOUDFLARE_CONTENT_ROOT, wrangler: process.env.FABRIK_WRANGLER, log: process.env.FIXTURE_LOG };
  try {
    process.env.CLOUDFLARE_CONTENT_ROOT = content;
    process.env.FABRIK_WRANGLER = wrangler;
    process.env.FIXTURE_LOG = log;
    const deploy = TOOLS.find(tool => tool.name === "cf_pages_deploy");

    const out = await deploy.handler({ token: "fixture-token", accountId: "a".repeat(32) }, { project: "fixture", directory: site, root: content });
    assert.equal(out.ok, true);
    const ran = JSON.parse(readFileSync(log, "utf-8"));
    // Uploaded: the published directory. Run from: the root, where Pages finds functions/.
    assert.deepEqual(ran.args, ["pages", "deploy", realpathSync(site), "--project-name", "fixture", "--branch=preview"]);
    assert.equal(ran.cwd, realpathSync(content));

    // A root the built directory does not sit under would deploy somebody else's handlers.
    const wrong = await deploy.handler({ token: "fixture-token", accountId: "a".repeat(32) }, { project: "fixture", directory: site, root: elsewhere });
    assert.equal(wrong.ok, false);
    assert.match(wrong.problem, /not inside the project root/);

    // Omitted, it is the built directory: what every caller got before, unchanged.
    await deploy.handler({ token: "fixture-token", accountId: "a".repeat(32) }, { project: "fixture", directory: site });
    assert.equal(JSON.parse(readFileSync(log, "utf-8")).cwd, realpathSync(site));
  } finally {
    for (const [key, value] of Object.entries(before)) {
      const env = key === "root" ? "CLOUDFLARE_CONTENT_ROOT" : key === "wrangler" ? "FABRIK_WRANGLER" : "FIXTURE_LOG";
      if (value === undefined) delete process.env[env]; else process.env[env] = value;
    }
  }
});

test("Pages deployment refuses PATH lookup and gives failed Wrangler output with the token taken out", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cloudflare-wrangler-fail-")));
  const content = join(base, "content");
  const wrangler = join(base, "node_modules", "wrangler", "bin", "wrangler.js");
  mkdirSync(content);
  mkdirSync(join(wrangler, ".."), { recursive: true });
  writeFileSync(wrangler, `process.stderr.write(process.env.CLOUDFLARE_API_TOKEN); process.exit(9);`);
  const before = { root: process.env.CLOUDFLARE_CONTENT_ROOT, wrangler: process.env.FABRIK_WRANGLER };
  try {
    process.env.CLOUDFLARE_CONTENT_ROOT = content;
    process.env.FABRIK_WRANGLER = wrangler;
    const deploy = TOOLS.find(tool => tool.name === "cf_pages_deploy");
    const result = await deploy.handler({ token: "fixture-secret", accountId: "a".repeat(32) }, { project: "fixture", directory: content, branch: "main" });
    assert.equal(result.ok, false);
    assert.match(result.problem, /exit 9/);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
    // What wrangler said comes back, the token taken out of it.
    assert.match(result.problem, /\[token\]/);
    process.env.FABRIK_WRANGLER = "wrangler";
    assert.match((await deploy.handler({ token: "fixture-secret", accountId: "a".repeat(32) }, { project: "fixture", directory: content })).problem, /does not name a usable Wrangler/);
  } finally {
    if (before.root === undefined) delete process.env.CLOUDFLARE_CONTENT_ROOT; else process.env.CLOUDFLARE_CONTENT_ROOT = before.root;
    if (before.wrangler === undefined) delete process.env.FABRIK_WRANGLER; else process.env.FABRIK_WRANGLER = before.wrangler;
  }
});

test("the server refuses excluded direct calls before reading credentials", () => {
  const index = fileURLToPath(new URL("../index.mjs", import.meta.url));
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cf_token_create", arguments: {} } }),
  ].join("\n") + "\n";
  const run = spawnSync(process.execPath, [index], {
    input,
    encoding: "utf-8",
    env: { ...process.env, CLOUDFLARE_PROFILE: "pages-dns", CLOUDFLARE_API_TOKEN: "transcript-secret" },
  });
  assert.equal(run.status, 0, run.stderr);
  const replies = run.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(replies[0].result.tools.map(tool => tool.name), expected);
  assert.match(replies[1].result.content[0].text, /No such tool: cf_token_create/);
  assert.doesNotMatch(run.stdout + run.stderr, /transcript-secret/);
});

test("content paths accept real children and reject siblings, traversal and symlink escapes", () => {
  const base = mkdtempSync(join(tmpdir(), "cloudflare-content-"));
  const root = join(base, "root");
  const sibling = join(base, "sibling");
  mkdirSync(root);
  mkdirSync(sibling);
  const artifact = join(root, "site", "release", "index.html");
  mkdirSync(join(root, "site", "release"), { recursive: true });
  writeFileSync(artifact, "ok");
  const outside = join(sibling, "secret");
  writeFileSync(outside, "no");
  symlinkSync(sibling, join(root, "escape"));
  const env = { CLOUDFLARE_CONTENT_ROOT: root };

  assert.equal(confinedPath(artifact, { env }), realpathSync(artifact));
  assert.throws(() => confinedPath(outside, { env }), /outside/);
  assert.throws(() => confinedPath(join(root, "..", "sibling", "secret"), { env }), /outside/);
  assert.throws(() => confinedPath(join(root, "escape", "secret"), { env }), /symlink/);
  assert.throws(() => confinedPath(join(root, "escape", "new"), { env, write: true }), /symlink/);
});

test("content roots reject missing, relative and symlink roots", () => {
  const base = mkdtempSync(join(tmpdir(), "cloudflare-root-"));
  const root = join(base, "root");
  mkdirSync(root);
  const linked = join(base, "linked");
  symlinkSync(root, linked);
  assert.throws(() => confinedPath(join(root, "x"), { env: {} }), /required/);
  assert.throws(() => confinedPath(join(root, "x"), { env: { CLOUDFLARE_CONTENT_ROOT: "relative" } }), /absolute/);
  assert.throws(() => confinedPath(join(base, "missing", "x"), { env: { CLOUDFLARE_CONTENT_ROOT: join(base, "missing") } }), /does not exist/);
  assert.throws(() => confinedPath(join(linked, "x"), { env: { CLOUDFLARE_CONTENT_ROOT: linked }, write: true }), /must not be a symlink/);
});

test("pages-dns is the only profile, the table holds exactly its tools, and none deletes or mints a token", () => {
  for (const other of ["site-forms", "inventory", "proposals", "proposal-delivery"])
    assert.throws(() => toolsForProfile(TOOLS, other), /unknown.*fails closed/i);
  assert.deepEqual(TOOLS.map(tool => tool.name), expected);
  for (const name of TOOLS.map(tool => tool.name)) assert.doesNotMatch(name, /delete|token|access|d1|r2|tunnel/);
});

test("a missing settings folder is named, with how to point at another", () => {
  const before = { config: process.env.CLOUDFLARE_CONFIG_DIR, secrets: process.env.FABRIK_SECRETS };
  try {
    delete process.env.FABRIK_SECRETS;
    process.env.CLOUDFLARE_CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "cf-folder-")), "absent");
    assert.match(missingFolderHint(), /does not exist.*set CLOUDFLARE_CONFIG_DIR/);
    process.env.CLOUDFLARE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cf-folder-present-"));
    assert.equal(missingFolderHint(), "");
  } finally {
    if (before.config === undefined) delete process.env.CLOUDFLARE_CONFIG_DIR; else process.env.CLOUDFLARE_CONFIG_DIR = before.config;
    if (before.secrets === undefined) delete process.env.FABRIK_SECRETS; else process.env.FABRIK_SECRETS = before.secrets;
  }
});
