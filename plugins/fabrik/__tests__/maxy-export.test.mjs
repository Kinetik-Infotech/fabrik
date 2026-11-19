import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { encodeValue, encodeProps, neo4jSource, exportAccount, loadLabelMap, BATCH, resolveAccountsDir, USAGE } from '../../../scripts/maxy-export.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath as toPath } from 'node:url';
const here = path.dirname(toPath(import.meta.url));

// Hand-made values shaped like neo4j-driver's: same marker properties, same toString output.
const typed = (marker, str, extra = {}) => ({ [marker]: true, toString: () => str, ...extra });
const Int = (s) => typed('__isInteger__', s, { low: 0, high: 0 });
const toInt = (n) => Int(String(n));

test('encodes every value type as decided', () => {
  assert.deepEqual(encodeValue(Int('9007199254740993')), { $int: '9007199254740993' });
  assert.deepEqual(encodeValue(typed('__isDateTime__', '2026-01-02T03:04:05.000000006+01:00')), { $datetime: '2026-01-02T03:04:05.000000006+01:00' });
  assert.deepEqual(encodeValue(typed('__isLocalDateTime__', '2026-01-02T03:04:05')), { $datetime: '2026-01-02T03:04:05' });
  assert.deepEqual(encodeValue(typed('__isDate__', '2026-01-02')), { $date: '2026-01-02' });
  assert.deepEqual(encodeValue(typed('__isDuration__', 'P1M2DT3S')), { $duration: 'P1M2DT3S' });
  assert.deepEqual(encodeValue(typed('__isTime__', '10:00:00Z')), { $time: '10:00:00Z' });
  assert.deepEqual(encodeValue(typed('__isPoint__', '', { srid: Int('4326'), x: 1.5, y: 2.5 })), { $point: { srid: { $int: '4326' }, x: 1.5, y: 2.5 } });
  assert.deepEqual(encodeValue(typed('__isPoint__', '', { srid: Int('4979'), x: 1, y: 2, z: 3 })), { $point: { srid: { $int: '4979' }, x: 1, y: 2, z: 3 } });
  assert.equal(encodeValue(3.0), 3);
  assert.equal(encodeValue(0.1), 0.1);
  assert.deepEqual(encodeValue(NaN), { $float: 'NaN' });
  assert.equal(encodeValue('x'), 'x');
  assert.equal(encodeValue(true), true);
  assert.equal(encodeValue(null), null);
  assert.deepEqual(encodeValue([Int('1'), 2.5, 'a', [typed('__isDate__', '2026-01-02')]]), [{ $int: '1' }, 2.5, 'a', [{ $date: '2026-01-02' }]]);
  assert.throws(() => encodeValue({ foo: 1 }), /unhandled property type/);
});

test('real neo4j-driver values encode the same way (runs when NEO4J_DRIVER names a driver)', (t) => {
  const p = process.env.NEO4J_DRIVER;
  if (!p) return t.skip('NEO4J_DRIVER is not set: set it to a neo4j-driver folder to run this test');
  let neo4j;
  try { neo4j = createRequire(import.meta.url)(p); } catch { return t.skip(`no neo4j-driver at ${p}`); }
  assert.deepEqual(encodeValue(neo4j.int('9007199254740993')), { $int: '9007199254740993' });
  assert.deepEqual(encodeValue(neo4j.types.Date.fromStandardDate(new Date(Date.UTC(2026, 0, 2)))), { $date: '2026-01-02' });
  assert.deepEqual(encodeValue(new neo4j.types.Duration(1, 2, 3, 0)), { $duration: 'P1M2DT3S' });
  assert.deepEqual(encodeValue(new neo4j.types.Point(neo4j.int(4326), 1.5, 2.5)), { $point: { srid: { $int: '4326' }, x: 1.5, y: 2.5 } });
  const dt = neo4j.types.DateTime.fromStandardDate(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
  assert.equal(Object.keys(encodeValue(dt))[0], '$datetime');
});

test('dropProperties are removed and counted', () => {
  const drop = new Set(loadLabelMap().dropProperties);
  const counter = {};
  const out = encodeProps({ name: 'a', embedding: [0.1], magicToken: 't', password: 'p' }, drop, counter);
  assert.deepEqual(out, { name: 'a' });
  assert.deepEqual(counter, { embedding: 1, magicToken: 1, password: 1 });
  const r = encodeProps({ APIKEY: 'x', api_key: 'y', 'Bot-Token': 'z', Magic_Token: 'm', Name: 'n' }, drop, {});
  assert.deepEqual(r, { Name: 'n' });
  // A name that says it holds a secret goes though the drop list does not name it; a count of tokens stays.
  const seen = {};
  const s = encodeProps({ passwordHash: 'h', client_secret: 'c', sessionToken: 's', stripeApiKey: 'k', tokenCount: 3, maxTokens: 9 }, drop, seen);
  assert.deepEqual(s, { tokenCount: 3, maxTokens: 9 });
  assert.deepEqual(Object.keys(seen).sort(), ['client_secret', 'passwordHash', 'sessionToken', 'stripeApiKey']);
});

// Fake session: holds a graph, answers the three queries by reading the cypher and params.
function fakeSession(nodes, rels, outside = []) {
  const calls = [];
  const rec = (o) => ({ get: (k) => o[k] });
  return {
    calls,
    async run(cypher, params) {
      if ('limit' in params) {
        if (params.limit?.__isInteger__ !== true) throw new Error('LIMIT needs an Integer parameter, got ' + typeof params.limit);
        params = { ...params, limit: Number(params.limit.toString()) };
      }
      calls.push({ cypher, params });
      if (/^MATCH \(n \{accountId/.test(cypher)) {
        const r = nodes.filter((n) => n.props.accountId === params.id && n.id > params.after).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, params.limit);
        return { records: r.map(rec) };
      }
      if (/-\[r\]->/.test(cypher)) {
        const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
        const r = rels.filter((x) => byId[x.start]?.props.accountId === params.id && byId[x.end]?.props.accountId === params.id && x.id > params.after)
          .sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, params.limit);
        return { records: r.map(rec) };
      }
      return { records: outside.map((o) => rec({ ...o, n: Int(String(o.n)) })) };
    },
  };
}

const pad = (i) => String(i).padStart(6, '0');
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'maxy-export-')); }
function accountsDir(id) {
  const d = tmp();
  const a = path.join(d, id);
  fs.mkdirSync(path.join(a, 'secrets'), { recursive: true });
  fs.mkdirSync(path.join(a, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(a, 'account.json'), '{}');
  fs.writeFileSync(path.join(a, 'users.json'), '[]');
  fs.writeFileSync(path.join(a, 'secrets/key'), 'k');
  fs.writeFileSync(path.join(a, 'docs/a.txt'), 'hello');
  fs.writeFileSync(path.join(a, 'top.txt'), 'top');
  const put = (rel, body = 'x') => { fs.mkdirSync(path.dirname(path.join(a, rel)), { recursive: true }); fs.writeFileSync(path.join(a, rel), body); };
  for (const f of ['docs/keynote.pdf', 'docs/turkey-recipe.docx', 'docs/Monkey.jpg', 'docs/Keynotes/notes.md', 'docs/GitHub-Token.txt', 'docs/my_Password.md', 'docs/id_rsa.pub']) put(f);
  for (const f of ['docs/Secrets/x', 'docs/.env', 'docs/.ENV.local', 'docs/.ssh/config', 'docs/.gnupg/k', 'docs/.aws/c', 'docs/Credentials', 'docs/credentials.json', 'docs/.netrc',
    'docs/id_rsa', 'docs/id_ed25519', 'docs/id_ecdsa', 'docs/ID_DSA', 'docs/a.PEM', 'docs/a.key', 'docs/a.p12', 'docs/a.pfx', 'docs/a.keystore', 'docs/a.jks', 'docs/deep/users.json',
    '.DS_Store', 'docs/Thumbs.db', 'docs/._a.txt', 'docs/Desktop.ini', '.claude/settings.json', '.gitkeep', 'docs/.mcp.json']) put(f);
  fs.symlinkSync('/etc/hosts', path.join(a, 'docs/link'));
  return d;
}

test('pages nodes and relationships in batches of 1,000 and filters by account', async () => {
  const nodes = [];
  for (let i = 0; i < 2500; i++) nodes.push({ id: '4:x:' + pad(i), labels: ['Person'], props: { accountId: 'A', name: 'p' + i, embedding: [1] } });
  nodes.push({ id: '4:x:900000', labels: ['Person'], props: { accountId: 'B', name: 'other' } });
  nodes.push({ id: '4:x:900001', labels: ['AdminUser'], props: { accountId: 'A', name: 'admin' } });
  nodes.push({ id: '4:x:900002', labels: ['AccessGrant', 'Trashed'], props: { accountId: 'A', magicToken: 't' } });
  nodes.push({ id: '4:x:900003', labels: ['Project', 'Trashed'], props: { accountId: 'A', name: 'gone' } });
  const rels = [];
  for (let i = 0; i < 1500; i++) rels.push({ id: '5:x:' + pad(i), type: 'KNOWS', start: '4:x:' + pad(i), end: '4:x:' + pad(i + 1), props: { since: Int('3') } });
  rels.push({ id: '5:x:800000', type: 'ADMIN_OF', start: '4:x:900001', end: '4:x:000001', props: {} });
  rels.push({ id: '5:x:800001', type: 'KNOWS', start: '4:x:900000', end: '4:x:000001', props: {} });
  const session = fakeSession(nodes, rels, [{ type: 'OWNS', labels: ['Device'], n: 4 }, { type: 'OWNS', labels: ['Other'], n: 1 }]);
  const out = path.join(tmp(), 'out');
  const m = await exportAccount({ source: neo4jSource(session, toInt), accountId: 'A', outDir: out, accountsDir: accountsDir('A'), now: new Date('2026-11-15T00:00:00Z') });

  const nodeCalls = session.calls.filter((c) => /^MATCH \(n/.test(c.cypher));
  assert.equal(nodeCalls.length, 3);
  assert.ok(nodeCalls.every((c) => c.params.limit === BATCH && c.params.id === 'A'));
  assert.equal(nodeCalls[1].params.after, '4:x:' + pad(999));
  assert.equal(session.calls.filter((c) => /-\[r\]->/.test(c.cypher)).length, 2);
  assert.ok(session.calls.every((c) => !/\b(CREATE|MERGE|DELETE|SET)\b/.test(c.cypher)));

  assert.equal(m.nodes.exported, 2501);
  assert.equal(m.nodes.byLabel.Person, 2500);
  assert.equal(m.nodes.byLabel.Project, 1);
  // Every node of the account is counted by label, the skipped AdminUser and AccessGrant too, as a Cypher count by label.
  assert.equal(m.nodes.byLabel.Trashed, 2);
  assert.equal(m.nodes.byLabel.AdminUser, 1);
  assert.equal(m.nodes.byLabel.AccessGrant, 1);
  assert.equal(m.nodes.byLabelSet['Project:Trashed'], 1);
  assert.equal(m.nodes.byLabelSet['AccessGrant:Trashed'], 1);
  assert.equal(m.nodes.trashed, 1);
  assert.deepEqual(Object.keys(m.skipped).sort(), ['AccessGrant', 'AdminUser']);
  assert.equal(m.skipped.AdminUser.count, 1);
  assert.match(m.skipped.AccessGrant.reason, /magicToken/);
  assert.equal(m.relationships.exported, 1500);
  assert.deepEqual(m.relationships.byType, { KNOWS: 1500 });
  assert.deepEqual(m.relationships.leftOut.skippedEnd, { ADMIN_OF: 1 });
  assert.deepEqual(m.relationships.leftOut.outsideAccount, { OWNS: 5 });
  assert.equal(m.droppedProperties.embedding, 2500);

  const lines = fs.readFileSync(path.join(out, 'nodes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2501);
  assert.deepEqual(lines[0], { elementId: '4:x:000000', labels: ['Person'], trashed: false, properties: { accountId: 'A', name: 'p0' } });
  assert.deepEqual(lines.at(-1), { elementId: '4:x:900003', labels: ['Project'], trashed: true, properties: { accountId: 'A', name: 'gone' } });
  const rl = fs.readFileSync(path.join(out, 'relationships.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rl[0].properties, { since: { $int: '3' } });
});

test('files are copied less account.json, secrets and users.json; manifest carries sha256 and is written last', async () => {
  const out = path.join(tmp(), 'out');
  const m = await exportAccount({ source: neo4jSource(fakeSession([], []), toInt), accountId: 'A', outDir: out, accountsDir: accountsDir('A') });
  assert.deepEqual(fs.readdirSync(path.join(out, 'files')).sort(), ['docs', 'top.txt']);
  const copied = Object.keys(m.sha256).filter((k) => k.startsWith('files/')).sort();
  assert.deepEqual(copied, ['files/docs/GitHub-Token.txt', 'files/docs/Keynotes/notes.md', 'files/docs/Monkey.jpg', 'files/docs/a.txt', 'files/docs/id_rsa.pub',
    'files/docs/keynote.pdf', 'files/docs/deep/users.json', 'files/docs/my_Password.md', 'files/docs/turkey-recipe.docx', 'files/top.txt'].sort());
  assert.equal(m.sha256['files/docs/a.txt'], '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')), JSON.parse(JSON.stringify(m)));
  assert.equal(m.accountId, 'A');
  assert.deepEqual(m.filesLeftOut.map((x) => x.path).sort(), ['account.json', 'docs/.ENV.local', 'docs/.aws', 'docs/.env', 'docs/.gnupg', 'docs/.netrc', 'docs/.ssh',
    'docs/Credentials', 'docs/ID_DSA', 'docs/Secrets', 'docs/a.PEM', 'docs/a.jks', 'docs/a.key', 'docs/a.keystore', 'docs/a.p12', 'docs/a.pfx',
    'docs/credentials.json', 'docs/id_ecdsa', 'docs/id_ed25519', 'docs/id_rsa', 'docs/link', 'secrets', 'users.json',
    '.DS_Store', 'docs/Thumbs.db', 'docs/._a.txt', 'docs/Desktop.ini', '.claude', '.gitkeep', 'docs/.mcp.json'].sort());
  for (const p of ['.claude', '.gitkeep', 'docs/.mcp.json']) assert.equal(m.filesLeftOut.find((x) => x.path === p).reason, "the install's own configuration, not the person's data");
  for (const p of ['.DS_Store', 'docs/Thumbs.db', 'docs/._a.txt', 'docs/Desktop.ini']) assert.equal(m.filesLeftOut.find((x) => x.path === p).reason, "a system file, not the person's data");
  assert.equal(m.filesLeftOut.find((x) => x.path === 'docs/link').reason, 'symlink');
  assert.ok(!fs.existsSync(path.join(out, 'files/docs/link')));
});

test('refuses a non-empty out folder and a missing account folder', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'x'), '');
  await assert.rejects(exportAccount({ source: neo4jSource(fakeSession([], []), toInt), accountId: 'A', outDir: d, accountsDir: accountsDir('A') }), /not empty/);
  await assert.rejects(exportAccount({ source: neo4jSource(fakeSession([], []), toInt), accountId: 'Z', outDir: path.join(tmp(), 'o'), accountsDir: accountsDir('A') }), /account folder not found/);
  // A wrong accounts folder is found before the graph is read, so nothing is written and the next run is not refused.
  const out = path.join(tmp(), 'o');
  const session = fakeSession([{ id: 'n1', labels: ['Person'], props: { accountId: 'Z' } }], []);
  await assert.rejects(exportAccount({ source: neo4jSource(session, toInt), accountId: 'Z', outDir: out, accountsDir: accountsDir('A') }), /account folder not found/);
  assert.equal(session.calls.length, 0);
  assert.equal(fs.existsSync(out), false);
});

test('account id with path or query characters is refused before anything runs', async () => {
  const s = fakeSession([], []);
  for (const bad of ['../x', 'a/b', "a'b", '', 'a b'])
    await assert.rejects(exportAccount({ source: neo4jSource(s, toInt), accountId: bad, outDir: path.join(tmp(), 'o'), accountsDir: tmp() }), /account id/);
  assert.equal(s.calls.length, 0);
});

test('a plain-number limit is refused by the fake as a real server would', async () => {
  await assert.rejects(fakeSession([], []).run('MATCH (n {accountId: $id})', { id: 'A', limit: 1000 }), /Integer/);
});

test('accounts folder: MAXY_ACCOUNTS_DIR wins, else platform root sibling', () => {
  assert.equal(resolveAccountsDir({ MAXY_ACCOUNTS_DIR: '/a/b' }), '/a/b');
  assert.equal(resolveAccountsDir({ MAXY_PLATFORM_ROOT: '/m/platform' }), '/m/data/accounts');
});

test('run on its own, the exporter names where its label map goes rather than stopping on a missing file', () => {
  const alone = tmp();
  const script = path.join(alone, 'maxy-export.mjs');
  fs.copyFileSync(path.join(here, '../../../scripts/maxy-export.mjs'), script);
  assert.throws(() => execFileSync(process.execPath, [script, 'bolt://x', 'u', 'p', 'A', path.join(alone, 'out')], { stdio: 'pipe' }),
    (e) => /Copy plugins\/fabrik\/import\/maxy-labels.json beside maxy-export.mjs, or name it with --labels/.test(e.stderr.toString()));
  assert.throws(() => execFileSync(process.execPath, [script, 'bolt://x', 'u', 'p', 'A', path.join(alone, 'out'), '--labels', path.join(alone, 'none.json')], { stdio: 'pipe' }),
    (e) => /none.json does not exist/.test(e.stderr.toString()));
  fs.copyFileSync(path.join(here, '../import/maxy-labels.json'), path.join(alone, 'maxy-labels.json'));
  // With the map beside it, it gets past the map and stops only on the Neo4j driver this machine lacks.
  assert.throws(() => execFileSync(process.execPath, [script, 'bolt://x', 'u', 'p', 'A', path.join(alone, 'out')], { stdio: 'pipe', env: { ...process.env, NEO4J_DRIVER: path.join(alone, 'no-driver') } }),
    (e) => !/label map/.test(e.stderr.toString()) && /no-driver/.test(e.stderr.toString()));
  assert.match(execFileSync(process.execPath, [script, '--help']).toString(), /copy plugins\/fabrik\/import\/maxy-labels.json beside maxy-export.mjs/);
  assert.match(USAGE, /WHERE n > 200 RETURN count\(a\), max\(n\)/);
});
