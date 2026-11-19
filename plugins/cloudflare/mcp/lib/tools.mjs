// Every Cloudflare operation this connector exposes, as one table: the account, zones and DNS,
// and Pages. Nothing here knows about an install directory, an account id belonging to a
// tenant, or a brand — the only account in play is the Cloudflare one the token can see.
import { statSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { spawn } from "node:child_process";
import { callRaw, callAccount } from "./api.mjs";
import { confinedPath } from "./content-path.mjs";

const S = (props, required = []) => ({ type: "object", properties: props, required });
const str = description => ({ type: "string", description });
const num = description => ({ type: "number", description });
const bool = description => ({ type: "boolean", description });

const ok = result => ({ ok: true, result, problem: null });
const no = problem => ({ ok: false, result: null, problem });
export const pagesBranch = branch => branch ?? "preview";

function wranglerPath(env = process.env) {
  const configured = env.FABRIK_WRANGLER;
  const ending = join("node_modules", "wrangler", "bin", "wrangler.js");
  if (!configured || !isAbsolute(configured) || !normalize(configured).endsWith(`${sep}${ending}`)) {
    throw new Error("FABRIK_WRANGLER does not name a usable Wrangler runtime.");
  }
  try {
    const entry = lstatSync(configured);
    if (entry.isSymbolicLink() || !entry.isFile() || realpathSync(configured) !== normalize(configured)) throw new Error("unsafe");
  } catch { throw new Error("FABRIK_WRANGLER does not name a usable Wrangler runtime."); }
  return configured;
}

// ─────────────────────────────────────────────────────────────── zones and DNS

// The zone is the longest zone name on the account that is a suffix of the host. Longest wins
// so that a host under a delegated subdomain zone is not matched to its parent.
function pickZone(zones, hostname) {
  return zones
    .filter(z => hostname === z.name || hostname.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0] ?? null;
}

async function listZones(t) {
  const res = await callRaw(t.token, "/zones?per_page=50");
  return res.ok ? ok((res.result ?? []).map(z => ({ id: z.id, name: z.name, status: z.status }))) : res;
}

async function zoneFor(t, hostname) {
  const zs = await listZones(t);
  if (!zs.ok) return zs;
  const zone = pickZone(zs.result, hostname);
  return zone
    ? ok(zone)
    : no(`No zone on this account matches ${hostname}. Is the domain added to the account, and does the token carry Zone Read?`);
}

// ──────────────────────────────────────────────────────────────────────── the table

export const TOOLS = [
  // ── account and token ───────────────────────────────────────────────────────
  {
    name: "cf_whoami",
    description: "Verify the API token and report which Cloudflare account it can see. Run this first when anything is refused — it separates a bad token from a wrongly scoped one.",
    schema: S({}),
    handler: async t => {
      // Two verify endpoints, and which one answers says what KIND of token this is. An
      // account-owned token (dashboard: Manage account -> Account API tokens) verifies under
      // the account; a user-owned one (My Profile -> API Tokens) verifies under /user. Asking
      // only /user reports a working account token as "Invalid API Token", which reads as a
      // dead credential when it is merely a different kind.
      const acct = await callRaw(t.token, `/accounts/${t.accountId}/tokens/verify`);
      if (acct.ok) return ok({ accountId: t.accountId, tokenKind: "account-owned", tokenStatus: acct.result?.status ?? "active" });
      const user = await callRaw(t.token, "/user/tokens/verify");
      if (user.ok) return ok({ accountId: t.accountId, tokenKind: "user-owned", tokenStatus: user.result?.status ?? "active" });
      // Neither verified, yet the account resolved — so the token authenticates but carries no
      // token-read permission. That is normal for a narrowly scoped token, and not a fault.
      return ok({
        accountId: t.accountId, tokenKind: "unknown", tokenStatus: "unverified",
        note: "The token reached the account but cannot read its own token record, which a narrowly scoped token often cannot. This is not by itself a problem; judge it by whether the operation you actually need succeeds.",
      });
    },
  },
  {
    name: "cf_zones_list",
    description: "List the zones (domains) on this account, with id, name and status.",
    schema: S({}),
    handler: async t => listZones(t),
  },
  {
    name: "cf_zone_for_hostname",
    description: "Resolve which zone a hostname belongs to, by longest matching suffix. Use before any DNS write so the record lands in the right zone.",
    schema: S({ hostname: str("The full host, e.g. app.example.com.") }, ["hostname"]),
    handler: async (t, a) => zoneFor(t, a.hostname),
  },
  {
    name: "cf_dns_list",
    description: "List DNS records for a hostname's zone, optionally filtered by type or name.",
    schema: S({ hostname: str("Any host in the zone, used to find it."), type: str("Optional record type filter, e.g. CNAME."), name: str("Optional exact record name filter.") }, ["hostname"]),
    handler: async (t, a) => {
      const z = await zoneFor(t, a.hostname);
      if (!z.ok) return z;
      const q = new URLSearchParams({ per_page: "100" });
      if (a.type) q.set("type", a.type);
      if (a.name) q.set("name", a.name);
      const res = await callRaw(t.token, `/zones/${z.result.id}/dns_records?${q}`);
      return res.ok ? ok((res.result ?? []).map(r => ({ id: r.id, type: r.type, name: r.name, content: r.content, proxied: r.proxied, ttl: r.ttl }))) : res;
    },
  },
  {
    name: "cf_dns_upsert",
    description: "Create or update one DNS record in place. Idempotent: an existing record of the same type and name is updated rather than duplicated.",
    schema: S({
      name: str("Full record name, e.g. app.example.com."),
      type: str("Record type, e.g. CNAME, A, TXT."),
      content: str("Record value, e.g. a hostname or an IP address."),
      proxied: bool("Whether Cloudflare proxies it. Default true for CNAME and A, false otherwise."),
      ttl: num("TTL in seconds. 1 means automatic, which is the default."),
    }, ["name", "type", "content"]),
    handler: async (t, a) => {
      const z = await zoneFor(t, a.name);
      if (!z.ok) return z;
      const proxied = a.proxied ?? ["CNAME", "A", "AAAA"].includes(a.type.toUpperCase());
      const record = { type: a.type.toUpperCase(), name: a.name, content: a.content, proxied, ttl: a.ttl ?? 1 };
      const found = await callRaw(t.token, `/zones/${z.result.id}/dns_records?type=${encodeURIComponent(record.type)}&name=${encodeURIComponent(a.name)}`);
      if (!found.ok) return found;
      const existing = (found.result ?? [])[0];
      const res = existing
        ? await callRaw(t.token, `/zones/${z.result.id}/dns_records/${existing.id}`, { method: "PUT", body: record })
        : await callRaw(t.token, `/zones/${z.result.id}/dns_records`, { method: "POST", body: record });
      if (!res.ok) {
        // Listing zones already succeeded, so the token has zone read. A refusal here is the
        // edit permission, and that reads as a bad token unless it is named.
        if (/\b(403|9109|10000|authoriz|authentic|permission)/i.test(res.problem ?? "")) {
          return no(`${res.problem} — the token can read zone ${z.result.name} but not edit its DNS. Re-create it including DNS Edit for that zone.`);
        }
        return res;
      }
      return ok({ action: existing ? "updated" : "created", zone: z.result.name, ...record });
    },
  },
  {
    name: "cf_pages_projects_list",
    description: "List Cloudflare Pages projects on this account, with their subdomain and production branch.",
    schema: S({}),
    handler: async t => {
      const res = await callAccount(t.token, t.accountId, "/pages/projects");
      return res.ok ? ok((res.result ?? []).map(p => ({ name: p.name, subdomain: p.subdomain, production_branch: p.production_branch, domains: p.domains }))) : res;
    },
  },
  {
    name: "cf_pages_project_create",
    description: "Create a Pages project. Do this before the first deploy; deploying to a project that does not exist fails in a way that reads as an auth error.",
    schema: S({ name: str("Project name, lowercase and hyphenated. Becomes <name>.pages.dev."), production_branch: str("Branch treated as production. Defaults to main.") }, ["name"]),
    handler: async (t, a) =>
      callAccount(t.token, t.accountId, "/pages/projects", { method: "POST", body: { name: a.name, production_branch: a.production_branch ?? "main" } }),
  },
  {
    name: "cf_pages_domain_add",
    description: "Attach a custom domain to a Pages project, so the site answers on the operator's own hostname rather than only <project>.pages.dev.",
    schema: S({ project: str("Pages project name."), hostname: str("The custom domain, e.g. www.example.com.") }, ["project", "hostname"]),
    handler: async (t, a) =>
      callAccount(t.token, t.accountId, `/pages/projects/${encodeURIComponent(a.project)}/domains`, { method: "POST", body: { name: a.hostname } }),
  },
  {
    name: "cf_pages_deploy",
    description: "Deploy a built directory to a Pages project. Shells out to wrangler, which is the only supported upload path — Cloudflare offers no REST endpoint for it. The token is passed in the environment, never on the command line.",
    schema: S({ project: str("Pages project name."), directory: str("Absolute path to the built output directory. Everything in it is uploaded and publicly served."), root: str("Absolute path to the project root holding functions/ and wrangler.toml, for a site with form handlers. Wrangler runs here and finds them beside the built directory, which must be inside it. Defaults to the built directory, which has no handlers."), branch: str("Branch to deploy as. Defaults to preview. Name the production branch explicitly only after the operator requests production for this artifact.") }, ["project", "directory"]),
    handler: async (t, a) => {
      let directory, root;
      try {
        directory = confinedPath(a.directory);
        // Pages takes functions/ and wrangler.toml from where wrangler runs, not from the assets.
        root = a.root === undefined ? directory : confinedPath(a.root);
      }
      catch (err) { return no(err instanceof Error ? err.message : String(err)); }
      if (!statSync(directory).isDirectory()) return no(`There is no directory at ${directory} to publish.`);
      if (!statSync(root).isDirectory()) return no(`There is no project root at ${root}.`);
      if (!(directory === root || directory.startsWith(root + sep))) {
        return no(`The built directory ${directory} is not inside the project root ${root}, so the handlers beside it are not this site's.`);
      }
      let wrangler;
      try { wrangler = wranglerPath(); }
      catch (error) { return no(error instanceof Error ? error.message : "FABRIK_WRANGLER does not name a usable Wrangler runtime."); }
      // Run without blocking, so the server answers its other calls while the upload runs.
      const r = await new Promise(done => {
        const child = spawn(process.execPath, [wrangler, "pages", "deploy", directory, "--project-name", a.project, `--branch=${pagesBranch(a.branch)}`], {
          cwd: root,
          env: { ...process.env, CLOUDFLARE_API_TOKEN: t.token, CLOUDFLARE_ACCOUNT_ID: t.accountId },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let text = "";
        child.stdout.setEncoding("utf-8").on("data", d => { text += d; });
        child.stderr.setEncoding("utf-8").on("data", d => { text += d; });
        child.on("error", error => done({ status: null, output: String(error?.message ?? error) }));
        child.on("close", status => done({ status, output: text }));
      });
      const output = r.output.trim();
      if (r.status !== 0) {
        // What wrangler said, its last lines, with the token taken out wherever it appears.
        const said = output.split(t.token).join("[token]").slice(-2000);
        return no(`Wrangler could not deploy the Pages project (exit ${r.status ?? "unknown"})${said ? `:\n${said}` : "."}`);
      }
      return ok({ project: a.project, url: /https:\/\/[a-z0-9.-]+\.pages\.dev\b/i.exec(output)?.[0] ?? null });
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map(t => [t.name, t]));
