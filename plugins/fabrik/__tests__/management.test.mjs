// fabrik's Management API client, driven against the stand-in for Supabase's Management API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { organization, project, projectRef, startManagementApi } from "./stand-in-management-api.mjs";
import {
  managementClient, Refused, organizations, organization as getOrganization, projects, createProject, waitHealthy, query, ProjectStuck,
  deployFunction, functionsList, deleteFunction, publishableKey, exposeFabrik, profileEmail,
} from "../cli/management.mjs";

const REF = "abcdefghijklmnopqrst";
const TOKEN = "sbp_madeup0000token1111for2222tests";
const ORG = "acme-homes-org";

/** Runs fn against a fresh stand-in, with a client for TOKEN, and stops the stand-in after. */
async function withApi(options, fn) {
  const api = await startManagementApi({ ref: REF, token: TOKEN, ...options });
  try { return await fn(api, managementClient(TOKEN, api.url)); }
  finally { await api.stop(); }
}

/** A clock that moves only when the client sleeps. */
function fakeClock() {
  let at = 0;
  const slept = [];
  return { now: () => at, sleep: async ms => { slept.push(ms); at += ms; }, slept };
}

test("organisations: the list, and one with its plan", () => withApi({
  organizations: [organization(ORG, "Acme Homes", "free"), organization("acme-group", "Acme Group", "pro")],
}, async (api, c) => {
  assert.deepEqual(await organizations(c), [{ slug: ORG, name: "Acme Homes" }, { slug: "acme-group", name: "Acme Group" }]);
  assert.deepEqual(await getOrganization(c, "acme-group"), { slug: "acme-group", name: "Acme Group", plan: "pro" });
  assert.deepEqual(api.calls.map(x => `${x.method} ${x.path}`), ["GET /v1/organizations", "GET /v1/organizations/acme-group"]);
}));

test("an organisation's projects, every page of them", () => {
  const made = [project(projectRef(), "Acme Homes", ORG), project(projectRef(), "Acme Lettings", ORG, "INACTIVE"), project(projectRef(), "Acme Sales", ORG)];
  return withApi({ projects: [...made, project(projectRef(), "Elsewhere", "other-org")], pageSize: 2 }, async (api, c) => {
    assert.deepEqual(await projects(c, ORG), made.map(p => ({ ref: p.ref, name: p.name, status: p.status })));
    assert.deepEqual(api.calls.map(x => x.path), [`/v1/organizations/${ORG}/projects?offset=0&limit=100`, `/v1/organizations/${ORG}/projects?offset=2&limit=100`]);
  });
});

test("a created project, in London, with the password given, turns healthy on the third poll", () => withApi({}, async (api, c) => {
  const { ref } = await createProject(c, { orgSlug: ORG, name: "Acme Homes", region: "eu-west-2", dbPass: "madeup-db-pass-0000" });
  assert.match(ref, /^[a-z]{20}$/);
  assert.deepEqual(api.calls[0].body, { name: "Acme Homes", organization_slug: ORG, db_pass: "madeup-db-pass-0000",
    region_selection: { type: "specific", code: "eu-west-2" } });
  const clock = fakeClock();
  assert.equal(await waitHealthy(c, ref, clock), true);
  const polls = api.calls.filter(x => x.path.startsWith(`/v1/projects/${ref}/health`));
  assert.equal(polls.length, 3);
  assert.equal(polls[0].path, `/v1/projects/${ref}/health?services=auth%2Cdb%2Crest%2Cstorage`);
  assert.deepEqual(clock.slept, [10000, 10000], "it waits 10 seconds between polls, and not after the healthy one");
}));

test("a project that never turns healthy: false after 10 minutes", () => withApi({ healthyAfter: Infinity }, async (api, c) => {
  const { ref } = await createProject(c, { orgSlug: ORG, name: "Acme Homes", region: "eu-west-2", dbPass: "madeup-db-pass-0000" });
  const clock = fakeClock();
  assert.equal(await waitHealthy(c, ref, clock), false);
  assert.equal(clock.now(), 600000);
  assert.equal(api.calls.filter(x => x.path.includes("/health")).length, 61, "a poll every 10 seconds, the last at 10 minutes");
}));

test("a health poll Supabase turns down while the project comes up counts as not healthy yet, but a refused token stops it", async () => {
  await withApi({ refuse: { method: "GET", path: `/v1/projects/${REF}/health`, status: 503, message: "Service unavailable" } }, async (api, c) => {
    const clock = fakeClock();
    assert.equal(await waitHealthy(c, REF, { ...clock, timeoutMs: 30000 }), false);
    assert.equal(api.calls.length, 4);
  });
  await withApi({}, async (api) => {
    const clock = fakeClock();
    await assert.rejects(waitHealthy(managementClient("sbp_not_the_token", api.url), REF, clock), e => e instanceof Refused && e.status === 401);
    assert.equal(api.calls.length, 1);
  });
});

test("a query: the SQL goes in the body, and the rows come back", () => withApi({ rows: sql => sql === "select 1 as one" ? [{ one: 1 }] : [] }, async (api, c) => {
  assert.deepEqual(await query(c, REF, "select 1 as one"), [{ one: 1 }]);
  assert.deepEqual(api.calls[0], { method: "POST", path: `/v1/projects/${REF}/database/query`, authorization: `Bearer ${TOKEN}`,
    contentType: "application/json", body: { query: "select 1 as one" } });
}));

test("a deploy: a multipart body with each file under its name, and the entrypoint and verify_jwt in the metadata", () => withApi({}, async (api, c) => {
  const files = [{ name: "index.ts", text: "import { apps } from './apps.ts';\nDeno.serve(() => new Response('ok'));\n" },
    { name: "apps.ts", text: "export const apps = 'fabrik';\n" }];
  assert.equal(await deployFunction(c, REF, { name: "fabrik-apps", entrypoint: "index.ts", verifyJwt: false, files }), undefined);
  const call = api.calls[0];
  assert.equal(`${call.method} ${call.path}`, `POST /v1/projects/${REF}/functions/deploy?slug=fabrik-apps`);
  assert.match(call.contentType, /^multipart\/form-data; boundary=/);
  assert.deepEqual(JSON.parse(call.body.fields.metadata), { entrypoint_path: "index.ts", name: "fabrik-apps", verify_jwt: false });
  assert.deepEqual(call.body.files, files.map(f => ({ field: "file", ...f })));
  assert.deepEqual(await functionsList(c, REF), [{ slug: "fabrik-apps", verify_jwt: false }]);
  await deployFunction(c, REF, { name: "fabrik-setup", entrypoint: "index.ts", verifyJwt: true, files: files.slice(0, 1) });
  assert.deepEqual(await functionsList(c, REF), [{ slug: "fabrik-apps", verify_jwt: false }, { slug: "fabrik-setup", verify_jwt: true }]);
}));

test("the publishable key, read without asking Supabase to reveal any secret key", () => withApi({}, async (api, c) => {
  assert.equal(await publishableKey(c, REF), "sb_publishable_madeup0000key");
  assert.equal(api.calls[0].path, `/v1/projects/${REF}/api-keys`);
}));

test("a project with no publishable key: a plain refusal", () => withApi({}, async (api, c) => {
  api.state.apiKeys = api.state.apiKeys.filter(k => k.type !== "publishable");
  await assert.rejects(publishableKey(c, REF), e => e instanceof Refused && e.message === "Supabase shows no publishable key for this project.");
}));

test("profileEmail: the token's Supabase account's email, and null for an answer that is not one", () => withApi({}, async (api, c) => {
  assert.equal(await profileEmail(c), "owner@acme.example");
  assert.equal(api.calls.at(-1).path, "/v1/profile");
  api.state.profileEmail = "not an email";
  assert.equal(await profileEmail(c), null);
}));

test("exposeFabrik: the Data API serves fabrik beside public and graphql_public, then reloads its schema", () => withApi({}, async (api, c) => {
  assert.equal(await exposeFabrik(c, REF), undefined);
  assert.deepEqual(api.calls.map(x => [`${x.method} ${x.path}`, x.body ?? null]), [
    [`GET /v1/projects/${REF}/postgrest`, null],
    [`PATCH /v1/projects/${REF}/postgrest`, { db_schema: "public, graphql_public, fabrik" }],
    [`POST /v1/projects/${REF}/database/query`, { query: "notify pgrst, 'reload schema'" }],
  ]);
  assert.equal(api.state.postgrest.db_schema, "public, graphql_public, fabrik");
}));

test("exposeFabrik keeps the schemas the project already serves, and leaves the setting alone when fabrik is among them", () => withApi({}, async (api, c) => {
  api.state.postgrest.db_schema = "public, graphql_public, crm";
  await exposeFabrik(c, REF);
  assert.equal(api.state.postgrest.db_schema, "public, graphql_public, crm, fabrik");
  api.calls.length = 0;
  await exposeFabrik(c, REF);
  assert.ok(!api.calls.some(x => x.method === "PATCH"), JSON.stringify(api.calls));
}));

test("Supabase's own message for a refusal, with its status", () => withApi({
  refuse: { method: "POST", path: "/v1/projects", status: 402, message: "The organization has reached its project limit on the Free plan." },
}, async (api, c) => {
  await assert.rejects(createProject(c, { orgSlug: ORG, name: "Acme Homes", region: "eu-west-2", dbPass: "madeup-db-pass-0000" }),
    e => e instanceof Refused && e.status === 402 && e.message === "The organization has reached its project limit on the Free plan.");
}));

test("a 400 whose body echoes the whole request, Authorization header included: the token is in no message and in nothing printed", async () => {
  for (const echo of ["json", "text"]) {
    await withApi({ refuse: { method: "POST", path: "/database/query", status: 400, echo } }, async (api, c) => {
      const printed = [];
      const { write: out } = process.stdout;
      const { write: err } = process.stderr;
      const { log, error, warn } = console;
      process.stdout.write = process.stderr.write = chunk => { printed.push(String(chunk)); return true; };
      console.log = console.error = console.warn = (...a) => { printed.push(a.join(" ")); };
      let thrown;
      try { await query(c, REF, "select 1"); } catch (e) { thrown = e; }
      finally { Object.assign(process.stdout, { write: out }); Object.assign(process.stderr, { write: err }); Object.assign(console, { log, error, warn }); }
      assert.ok(api.calls[0].authorization.includes(TOKEN), "the stand-in had the token to echo");
      assert.ok(thrown instanceof Refused && thrown.status === 400, echo);
      assert.match(thrown.message, /^Bad request: /, echo);
      assert.ok(thrown.message.includes("select 1"), "the rest of Supabase's message stays");
      for (const text of [thrown.message, String(thrown.stack), JSON.stringify(thrown), ...printed])
        assert.ok(!text.includes(TOKEN) && !text.includes(TOKEN.slice(4)), `${echo}: ${text}`);
    });
  }
});

test("a long refusal is cut to 500 characters, after the token is taken out, so no part of the token is left", async () => {
  const long = `${"x".repeat(495)}${TOKEN} and more`;
  await withApi({ refuse: { method: "POST", path: "/database/query", status: 400, message: long } }, async (api, c) => {
    let thrown;
    try { await query(c, REF, "select 1"); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof Refused && thrown.status === 400);
    assert.equal(thrown.message.length, 500);
    assert.ok(thrown.message.startsWith("x".repeat(495)) && thrown.message.endsWith("…"), thrown.message);
    assert.ok(!thrown.message.includes(TOKEN.slice(0, 5)) && !thrown.message.includes(TOKEN.slice(4)), thrown.message);
  });
});

test("a health poll that cannot reach Supabase, such as a network blip, counts as not healthy yet, within the timeout", async () => {
  // A client for an address nobody serves: every fetch throws a TypeError.
  const c = managementClient(TOKEN, "http://127.0.0.1:9");
  const clock = fakeClock();
  assert.equal(await waitHealthy(c, REF, { ...clock, timeoutMs: 30000 }), false);
  assert.deepEqual(clock.slept, [10000, 10000, 10000]);
  // The network back after one blip: healthy on the next poll.
  await withApi({}, async (api) => {
    let calls = 0;
    const blip = { call: (...a) => (++calls === 1 ? Promise.reject(new TypeError("fetch failed")) : managementClient(TOKEN, api.url).call(...a)) };
    assert.equal(await waitHealthy(blip, REF, fakeClock()), true);
    assert.equal(calls, 2);
  });
});

test("a refused project whose answer echoes the request: the database password is in no message", async () => {
  const dbPass = "madeup-db-pass-0000-1111-2222";
  for (const echo of ["json", "text"]) {
    await withApi({ refuse: { method: "POST", path: "/v1/projects", status: 400, echo } }, async (api, c) => {
      let thrown;
      try { await createProject(c, { orgSlug: ORG, name: "Acme Homes", region: "eu-west-2", dbPass }); } catch (e) { thrown = e; }
      assert.ok(api.calls[0].body.db_pass === dbPass, "the stand-in had the password to echo");
      assert.ok(thrown instanceof Refused && thrown.status === 400, echo);
      for (const text of [thrown.message, String(thrown.stack), JSON.stringify(thrown)])
        assert.ok(!text.includes(dbPass) && !text.includes(TOKEN), `${echo}: ${text}`);
    });
  }
});

test("a long refusal is cut after the database password is taken out, so no part of the password is left", async () => {
  const dbPass = "madeup-db-pass-0000-1111-2222";
  await withApi({ refuse: { method: "POST", path: "/v1/projects", status: 400, message: `${"x".repeat(495)}${dbPass} and more` } }, async (api, c) => {
    let thrown;
    try { await createProject(c, { orgSlug: ORG, name: "Acme Homes", region: "eu-west-2", dbPass }); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof Refused && thrown.status === 400);
    assert.equal(thrown.message.length, 500);
    assert.ok(!thrown.message.includes(dbPass.slice(0, 4)), thrown.message);
  });
});

test("a paused project: the wait stops at once with the project's state, and polls no more", async () => {
  const projects = [{ ref: REF, name: "fabrik", organization_slug: ORG, region: "eu-west-2", status: "INACTIVE" }];
  await withApi({ projects }, async (api, c) => {
    const clock = fakeClock();
    await assert.rejects(waitHealthy(c, REF, clock), e => e instanceof ProjectStuck && e.state === "INACTIVE");
    assert.equal(api.calls.filter(x => x.path.includes("/health")).length, 1);
    assert.deepEqual(clock.slept, []);
  });
});

test("a project the token cannot see: the health poll stops at once on 404, with no wait", async () => {
  await withApi({ refuse: { method: "GET", path: `/v1/projects/${REF}/health`, status: 404, message: "Project not found" } }, async (api, c) => {
    const clock = fakeClock();
    await assert.rejects(waitHealthy(c, REF, clock), e => e instanceof Refused && e.status === 404);
    assert.equal(api.calls.length, 1);
    assert.deepEqual(clock.slept, []);
  });
});

test("every project path carries the reference encoded, so a reference can never reach another path", async () => {
  await withApi({}, async (api, c) => {
    await query(c, "x/../../v1/organizations", "select 1").catch(() => {});
    assert.equal(api.calls[0].path, "/v1/projects/x%2F..%2F..%2Fv1%2Forganizations/database/query");
  });
});

test("a function deleted: gone from the list, and deleting it again is not an error", () => withApi({}, async (api, c) => {
  await deployFunction(c, REF, { name: "fabrik-apps", entrypoint: "index.ts", verifyJwt: false, files: [{ name: "index.ts", text: "x" }] });
  assert.equal(await deleteFunction(c, REF, "fabrik-apps"), undefined);
  const call = api.calls.at(-1);
  assert.equal(`${call.method} ${call.path}`, `DELETE /v1/projects/${REF}/functions/fabrik-apps`);
  assert.deepEqual(await functionsList(c, REF), []);
  assert.equal(await deleteFunction(c, REF, "fabrik-apps"), undefined);
}));

test("a health poll answered 400 or 422: it stops at once with Supabase's message, with no wait", async () => {
  for (const [status, message] of [[400, "Invalid services requested"], [422, "Unprocessable project reference"]]) {
    await withApi({ refuse: { method: "GET", path: `/v1/projects/${REF}/health`, status, message } }, async (api, c) => {
      const clock = fakeClock();
      await assert.rejects(waitHealthy(c, REF, clock), e => e instanceof Refused && e.status === status && e.message === message);
      assert.equal(api.calls.length, 1);
      assert.deepEqual(clock.slept, []);
    });
  }
});

test("a created project's reference: from ref, or from id when the answer has no ref, and null when neither is a reference", async () => {
  await withApi({ madeAnswer: ({ ref, ...rest }) => rest }, async (api, c) => {
    const { ref } = await createProject(c, { orgSlug: ORG, name: "Acme Homes", region: "eu-west-2", dbPass: "madeup-db-pass-0000" });
    assert.equal(ref, api.state.projects.at(-1).ref);
  });
  for (const answer of [{}, { ref: "x/../../v1/organizations" }, { id: 42 }]) {
    await withApi({ madeAnswer: () => answer }, async (api, c) => {
      assert.deepEqual(await createProject(c, { orgSlug: ORG, name: "Acme Homes", region: "eu-west-2", dbPass: "madeup-db-pass-0000" }), { ref: null }, JSON.stringify(answer));
    });
  }
});
