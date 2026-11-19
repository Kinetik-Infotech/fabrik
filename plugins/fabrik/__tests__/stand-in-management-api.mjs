// A stand-in for Supabase's Management API, https://api.supabase.com, with the bodies and statuses the API's own
// description, https://api.supabase.com/api/v1-json, gives them. Tests import it. It never serves on its own.
//
// Organisations and projects, for fabrik's Management API client:
//
//   GET    /v1/organizations                                 200 [{ id, slug, name }]
//   GET    /v1/organizations/{slug}                          200 { id, name, plan, opt_in_tags, allowed_release_channels }
//   GET    /v1/organizations/{slug}/projects                 200 { projects: [...], pagination: { count, limit, offset } }
//   POST   /v1/projects                                      201 the new project, COMING_UP
//   GET    /v1/projects/{ref}                                200 the project, with its status
//   GET    /v1/profile                                       200 { gotrue_id, primary_email, username }
//   GET    /v1/projects/{ref}/health?services=...            200 [{ name, healthy, status }], one per service asked
//   POST   /v1/projects/{ref}/database/query                 201 the query's rows
//   POST   /v1/projects/{ref}/functions/deploy?slug=...      201 the function, from a multipart body of file and metadata
//   GET    /v1/projects/{ref}/functions                      200 [the functions]
//   DELETE /v1/projects/{ref}/functions/{slug}               200, or 404 when there is no such function
//   GET    /v1/projects/{ref}/api-keys                       200 [the keys], a secret key's api_key masked unless ?reveal=true
//   GET    /v1/projects/{ref}/postgrest                      200 the Data API's config
//   PATCH  /v1/projects/{ref}/postgrest                      200 the Data API's config, with the body's fields changed
//
// One project's auth settings and JWT signing keys, for fabrik connector-settings:
//
//   GET    /v1/projects/{ref}/config/auth                    200 the auth config
//   PATCH  /v1/projects/{ref}/config/auth                    200 the auth config, with the body's fields changed
//   GET    /v1/projects/{ref}/config/auth/signing-keys       200 { keys: [...] }
//   POST   /v1/projects/{ref}/config/auth/signing-keys       201 a new key, on standby unless the body says in_use
//   PATCH  /v1/projects/{ref}/config/auth/signing-keys/{id}  200 the key, with its status changed
//   GET    /v1/projects/{ref}/config/auth/signing-keys/legacy  200 the legacy secret's key, or 404 before it is imported
//   POST   /v1/projects/{ref}/config/auth/signing-keys/legacy  201 the legacy secret imported as the key in use
//
// A key put in use moves the key in use before it to previously used, as Supabase's guide to JWT signing keys
// says a rotation does. A call without "Authorization: Bearer <token>" for the stand-in's token gets 401.
//
// A key's state change is turned down with 429 within 5 minutes of the last change to the keys, as the guide,
// https://supabase.com/docs/guides/auth/signing-keys, says: "most actions that change the state of a JWT
// signing key are throttled for approximately 5 minutes." The v1-json lists 429 for the signing-keys paths.
// Creating a key or importing the legacy secret starts the 5 minutes. The PATCH that changes a key's status
// is the call turned down.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

const now = () => new Date().toISOString();
/** How long Supabase throttles a key's state change after the last one. */
export const THROTTLE_MS = 5 * 60 * 1000;
/** The most projects one page of an organisation's projects holds, as the v1-json's limit allows. */
const PAGE = 100;

/** A signing key as SigningKeyResponse gives it. An HS256 key publishes no public key. */
export function signingKey(algorithm, status) {
  const at = now();
  return { id: randomUUID(), algorithm, status, public_jwk: algorithm === "HS256" ? null : { kty: algorithm === "ES256" ? "EC" : "RSA", alg: algorithm, use: "sig" }, created_at: at, updated_at: at };
}

/** A new project's auth config, with the five settings as Supabase leaves them, and a few of its other fields. */
export function authConfig(fields = {}) {
  return { site_url: "http://localhost:3000", uri_allow_list: "", jwt_exp: 3600, disable_signup: false,
    oauth_server_enabled: false, oauth_server_allow_dynamic_registration: false, oauth_server_authorization_path: null, ...fields };
}

/** An organisation as the stand-in keeps it. plan is one of the v1-json's: free, pro, team, enterprise, platform. */
export function organization(slug, name, plan = "free") {
  return { id: randomUUID(), slug, name, plan };
}

/** A made-up project reference: 20 lower-case letters, as the v1-json's pattern ^[a-z]+$ with length 20. */
export function projectRef() {
  return Array.from({ length: 20 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join("");
}

/** A project as the stand-in keeps it, ready unless status says otherwise. */
export function project(ref, name, organizationSlug, status = "ACTIVE_HEALTHY") {
  return { id: ref, ref, name, organization_slug: organizationSlug, region: "eu-west-2", status, created_at: now() };
}

/** A project's API keys, as ApiKeyResponse gives them: a legacy anon key, a publishable key and a secret key. */
export function apiKeys() {
  return [
    { id: randomUUID(), name: "anon", type: "legacy", api_key: "eyJmadeup.anon.key" },
    { id: randomUUID(), name: "default", type: "publishable", api_key: "sb_publishable_madeup0000key" },
    { id: randomUUID(), name: "default", type: "secret", api_key: "sb_secret_madeup0000secret1111key" },
  ];
}

/**
 * Starts the stand-in, which accepts token. Project paths answer for ref and for any project in projects or made by
 * POST /v1/projects. The auth settings and signing keys are ref's.
 *
 * state: { keys, legacyImported, config, refuse, keyChangedAt, organizations, projects, healthyAfter, polls,
 *   queries, rows, functions, apiKeys, postgrest, pageSize }.
 * keyChangedAt is when the keys last changed, in milliseconds, or null. A test moves it back to stand for time passing.
 * refuse: { method, path, status, message, echo } answers that one call with that status and message. path is the
 * path after /v1/projects/{ref}, or the whole path. echo "json" answers with a JSON message holding the whole request,
 * its headers included, and echo "text" with the same as plain text.
 * healthyAfter: the health poll on which a project made by POST /v1/projects first answers healthy, or Infinity.
 * rows: a function from a query's SQL to the rows it answers.
 * madeAnswer: a function from POST /v1/projects's answer to the answer sent, for a test of an answer Supabase might give.
 * Returns { url, calls, state, stop() }. calls lists each request: { method, path, authorization, contentType, body }.
 * A multipart body is kept as { fields, files: [{ name, text }] }.
 */
export async function startManagementApi({ ref, token, keys = [], legacyImported = false, config = authConfig(), refuse = null, keyChangedAt = null,
  organizations = [organization("acme-homes-org", "Acme Homes")], projects = [], healthyAfter = 3, rows = () => [], pageSize = PAGE, madeAnswer = answer => answer }) {
  const state = { keys, legacyImported, config, refuse, keyChangedAt, organizations, projects, healthyAfter, polls: {}, queries: [], rows,
    functions: [], apiKeys: apiKeys(), postgrest: { db_schema: "public, graphql_public", max_rows: 1000, db_extra_search_path: "public, extensions", db_pool: null,
      db_pool_acquisition_timeout: null, db_pool_max_lifetime: null, db_pool_max_idletime: null }, pageSize };
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] ?? "";
    const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    let body;
    if (contentType.startsWith("multipart/form-data")) {
      // Parsed as a fetch Request parses it, so the stand-in reads the body Supabase would.
      const form = await new Request("http://stand-in/", { method: "POST", headers: { "content-type": contentType }, body: raw }).formData();
      const fields = {};
      const files = [];
      for (const [name, value] of form) {
        if (typeof value === "string") fields[name] = value;
        else files.push({ field: name, name: value.name, text: await value.text() });
      }
      body = { fields, files };
    } else if (raw.length) {
      try { body = JSON.parse(raw.toString("utf-8")); } catch { return send(400, { message: "The body is not JSON." }); }
    }
    calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization, contentType, body });
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { message: "Unauthorized" });
    const url = new URL(req.url, "http://stand-in");
    const projectPath = /^\/v1\/projects\/([a-z]{20})(\/.*)?$/.exec(url.pathname);
    const known = r => r === ref || state.projects.some(p => p.ref === r);
    const r = state.refuse;
    if (r && r.method === req.method && (r.path === url.pathname || (projectPath && r.path === req.url.slice(`/v1/projects/${projectPath[1]}`.length)))) {
      if (r.echo) {
        const whole = JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: raw.toString("utf-8") });
        if (r.echo === "text") { res.writeHead(r.status, { "content-type": "text/plain" }); return res.end(`Bad request: ${whole}`); }
        return send(r.status, { message: `Bad request: ${whole}` });
      }
      return send(r.status, { message: r.message });
    }

    if (url.pathname === "/v1/profile" && req.method === "GET") return send(200, { gotrue_id: "gotrue-1", primary_email: state.profileEmail ?? "owner@acme.example", username: "owner" });
    if (url.pathname === "/v1/organizations" && req.method === "GET")
      return send(200, state.organizations.map(o => ({ id: o.id, slug: o.slug, name: o.name })));
    const org = /^\/v1\/organizations\/([\w-]+)(\/projects)?$/.exec(url.pathname);
    if (org && req.method === "GET") {
      const found = state.organizations.find(o => o.slug === org[1]);
      if (!found) return send(404, { message: "Organization not found" });
      if (!org[2]) return send(200, { id: found.id, name: found.name, plan: found.plan, opt_in_tags: [], allowed_release_channels: ["ga"] });
      const all = state.projects.filter(p => p.organization_slug === found.slug);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Math.min(Number(url.searchParams.get("limit") ?? PAGE), state.pageSize);
      const page = all.slice(offset, offset + limit).map(p => ({ ref: p.ref, name: p.name, cloud_provider: "AWS", region: p.region, is_branch: false,
        status: p.status, inserted_at: p.created_at, databases: [] }));
      return send(200, { projects: page, pagination: { count: all.length, limit, offset } });
    }
    if (url.pathname === "/v1/projects" && req.method === "POST") {
      const missing = ["db_pass", "name", "organization_slug"].filter(k => typeof body?.[k] !== "string" || !body[k]);
      if (missing.length) return send(400, { message: `${missing.join(", ")} is required.` });
      const found = state.organizations.find(o => o.slug === body.organization_slug);
      if (!found) return send(404, { message: "Organization not found" });
      const made = project(projectRef(), body.name, found.slug, "COMING_UP");
      made.region = body.region_selection?.code ?? body.region ?? "us-east-1";
      state.projects.push(made);
      return send(201, madeAnswer({ id: made.id, ref: made.ref, organization_id: found.id, organization_slug: found.slug, name: made.name,
        region: made.region, created_at: made.created_at, status: made.status }));
    }

    if (!projectPath || !known(projectPath[1])) return send(404, { message: "Project not found" });
    const thisRef = projectPath[1];
    const path = projectPath[2] ?? "";
    const tail = req.url.slice(`/v1/projects/${thisRef}`.length);

    if (path === "" && req.method === "GET") {
      const p = state.projects.find(x => x.ref === thisRef) ?? project(thisRef, "fabrik", state.organizations[0]?.slug);
      return send(200, { id: p.id, ref: p.ref, organization_slug: p.organization_slug, name: p.name, region: p.region, status: p.status, created_at: p.created_at });
    }
    if (path === "/health" && req.method === "GET") {
      const services = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      if (!services.length) return send(400, { message: "services is required." });
      const p = state.projects.find(x => x.ref === thisRef);
      state.polls[thisRef] = (state.polls[thisRef] ?? 0) + 1;
      if (p && p.status === "COMING_UP" && state.polls[thisRef] >= state.healthyAfter) p.status = "ACTIVE_HEALTHY";
      const healthy = !p || p.status === "ACTIVE_HEALTHY";
      return send(200, services.map(name => ({ name, healthy, status: healthy ? "ACTIVE_HEALTHY" : "COMING_UP" })));
    }
    if (path === "/database/query" && req.method === "POST") {
      if (typeof body?.query !== "string") return send(400, { message: "query is required." });
      state.queries.push({ ref: thisRef, query: body.query });
      return send(201, state.rows(body.query));
    }
    if (path === "/functions/deploy" && req.method === "POST") {
      if (!body?.fields || !body.fields.metadata) return send(400, { message: "metadata is required." });
      const metadata = JSON.parse(body.fields.metadata);
      if (!metadata.entrypoint_path) return send(400, { message: "metadata.entrypoint_path is required." });
      const slug = url.searchParams.get("slug") ?? metadata.name;
      const at = Date.now();
      const old = state.functions.find(f => f.ref === thisRef && f.slug === slug);
      const fn = { ref: thisRef, id: old?.id ?? randomUUID(), slug, name: metadata.name ?? slug, status: "ACTIVE", version: (old?.version ?? 0) + 1,
        created_at: old?.created_at ?? at, updated_at: at, verify_jwt: metadata.verify_jwt ?? true, import_map: false,
        entrypoint_path: metadata.entrypoint_path, files: body.files };
      state.functions = state.functions.filter(f => f !== old).concat(fn);
      // A test sets state.failDeployAfterCreate to have the function made and then a 500 sent, as a lost deploy does.
      if (state.failDeployAfterCreate) return send(500, { message: "Internal error after the function was made." });
      const { ref: _r, files: _f, ...shown } = fn;
      return send(201, shown);
    }
    if (path === "/functions" && req.method === "GET")
      return send(200, state.functions.filter(f => f.ref === thisRef).map(({ ref: _r, files: _f, ...shown }) => shown));
    const gone = /^\/functions\/([a-z0-9-]+)$/.exec(path);
    if (gone && req.method === "DELETE") {
      const old = state.functions.find(f => f.ref === thisRef && f.slug === gone[1]);
      if (!old) return send(404, { message: "Function not found" });
      state.functions = state.functions.filter(f => f !== old);
      return send(200, {});
    }
    if (path === "/api-keys" && req.method === "GET") {
      const reveal = url.searchParams.get("reveal") === "true";
      return send(200, state.apiKeys.map(k => k.type === "secret" && !reveal ? { ...k, api_key: `${k.api_key.slice(0, 13)}····` } : k));
    }
    if (path === "/postgrest" && req.method === "GET") return send(200, state.postgrest);
    if (path === "/postgrest" && req.method === "PATCH") { Object.assign(state.postgrest, body); return send(200, state.postgrest); }

    // The auth settings and signing keys are the first project's.
    if (thisRef !== ref) return send(404, { message: "Not found" });
    const changed = () => { state.keyChangedAt = Date.now(); };
    const use = key => {
      for (const k of state.keys) if (k.status === "in_use" && k !== key) { k.status = "previously_used"; k.updated_at = now(); }
      key.status = "in_use"; key.updated_at = now();
    };
    if (tail === "/config/auth" && req.method === "GET") return send(200, state.config);
    if (tail === "/config/auth" && req.method === "PATCH") { Object.assign(state.config, body); return send(200, state.config); }
    if (tail === "/config/auth/signing-keys" && req.method === "GET") return send(200, { keys: state.keys });
    if (tail === "/config/auth/signing-keys" && req.method === "POST") {
      const key = signingKey(body.algorithm, "standby");
      state.keys.push(key);
      if (body.status === "in_use") use(key);
      changed();
      return send(201, key);
    }
    if (tail === "/config/auth/signing-keys/legacy" && req.method === "GET") {
      const legacy = state.keys.find(k => k.algorithm === "HS256");
      return state.legacyImported && legacy ? send(200, legacy) : send(404, { message: "Legacy signing key not found" });
    }
    if (tail === "/config/auth/signing-keys/legacy" && req.method === "POST") {
      const key = signingKey("HS256", "standby");
      state.keys.push(key);
      use(key);
      state.legacyImported = true;
      changed();
      return send(201, key);
    }
    const one = /^\/config\/auth\/signing-keys\/([0-9a-f-]{36})$/.exec(tail);
    if (one && req.method === "PATCH") {
      const key = state.keys.find(k => k.id === one[1]);
      if (!key) return send(404, { message: "Signing key not found" });
      if (state.keyChangedAt !== null && Date.now() - state.keyChangedAt < THROTTLE_MS)
        return send(429, { message: "Signing key state changes are throttled. Try again in a few minutes." });
      changed();
      if (body.status === "in_use") use(key); else { key.status = body.status; key.updated_at = now(); }
      return send(200, key);
    }
    send(404, { message: "Not found" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, state, stop: () => new Promise(resolve => server.close(resolve)) };
}
