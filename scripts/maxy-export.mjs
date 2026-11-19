#!/usr/bin/env node
// Exports one maxy-code account (graph + files) to a folder for `fabrik import maxy`. USAGE below says how to run it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BATCH = 1000;
const TOP_EXCLUDES = ['account.json', 'users.json'];
const SECRET_DIRS = new Set(['secrets', '.ssh', '.gnupg', '.aws']);
const SECRET_FILES = new Set(['credentials', 'credentials.json', '.netrc', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']);
const SECRET_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore', '.jks']);
// Files the operating system writes beside a person's files, which are not their data. The importer leaves out the same names.
export const isSystemFile = (name) => { const l = String(name).toLowerCase(); return l === '.ds_store' || l === 'thumbs.db' || l === 'desktop.ini' || l.startsWith('._'); };
export const SYSTEM_FILE_REASON = "a system file, not the person's data";
// A file or folder whose name starts with a dot is the install's own configuration, such as .claude/ or .mcp.json.
export const DOT_REASON = "the install's own configuration, not the person's data";

// A property name matches the drop list ignoring case, '-' and '_' (apiKey, API_KEY, api-key).
const normKey = (k) => String(k).toLowerCase().replace(/[-_]/g, '');
const ACCOUNT_ID = /^[A-Za-z0-9_-]+$/;
export function checkAccountId(id) {
  if (typeof id !== 'string' || !ACCOUNT_ID.test(id)) throw new Error('account id may hold only letters, digits, - and _');
  return id;
}

export const USAGE = `usage: node maxy-export.mjs <uri> <user> <password-file> <account-id> <out-folder> [--labels <maxy-labels.json>]

Exports one maxy-code account, its graph read-only and its files, to <out-folder> for fabrik import maxy.
The label map is --labels, else maxy-labels.json beside this script, else the fabrik plugin's import/maxy-labels.json
in a fabrik checkout. Run on its own, copy plugins/fabrik/import/maxy-labels.json beside maxy-export.mjs first.
The Neo4j driver is NEO4J_DRIVER, else ~/maxy-code/platform/node_modules/neo4j-driver.
The accounts folder is MAXY_ACCOUNTS_DIR, else $MAXY_PLATFORM_ROOT/../data/accounts, else ~/maxy-code/data/accounts.

fabrik keeps at most 200 links on a record. Before exporting, find the nodes with more than 200 relationships, whose
links past 200 the import leaves out, with this query in cypher-shell:
  MATCH (a {accountId: $id})-[r]->(b {accountId: $id}) WITH a, type(r) AS t, b WITH a, count(*) AS n WHERE n > 200 RETURN count(a), max(n)`;

/** The places the label map is looked for, in order. */
export const labelMapPlaces = (given) => [given, path.join(here, 'maxy-labels.json'), path.join(here, '../plugins/fabrik/import/maxy-labels.json')].filter(Boolean);

export function loadLabelMap(given) {
  const file = labelMapPlaces(given).find((f) => fs.existsSync(f));
  if (!file) throw new Error(`No label map: ${given ? `${given} does not exist` : 'none beside this script or in a fabrik checkout'}. Copy plugins/fabrik/import/maxy-labels.json beside maxy-export.mjs, or name it with --labels.`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Neo4j values carry marker properties on their prototypes (__isInteger__ and so on); testing
// those keeps encoding independent of which copy of the driver produced the value.
const mark = (v, name) => v !== null && typeof v === 'object' && v[name] === true;

export function encodeValue(v) {
  if (v === null || v === undefined) return null;
  if (mark(v, '__isInteger__')) return { $int: v.toString() };
  if (typeof v === 'bigint') return { $int: v.toString() };
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $float: String(v) };
  if (typeof v === 'boolean' || typeof v === 'string') return v;
  if (mark(v, '__isDateTime__') || mark(v, '__isLocalDateTime__')) return { $datetime: v.toString() };
  if (mark(v, '__isDate__')) return { $date: v.toString() };
  if (mark(v, '__isTime__') || mark(v, '__isLocalTime__')) return { $time: v.toString() };
  if (mark(v, '__isDuration__')) return { $duration: v.toString() };
  if (mark(v, '__isPoint__')) {
    const p = { srid: encodeValue(v.srid), x: v.x, y: v.y };
    if (v.z !== undefined) p.z = v.z;
    return { $point: p };
  }
  if (Array.isArray(v)) return v.map(encodeValue);
  throw new Error('unhandled property type: ' + Object.prototype.toString.call(v));
}

// A name that says its value is a secret, whatever the drop list holds: passwordHash, clientSecret, sessionToken,
// stripeApiKey, privateKey. A count of tokens, such as tokenCount or maxTokens, is not one. The importer drops the same names.
const SECRET_NAME = /password|passwd|secret|privatekey|apikey|token(hash|enc|encrypted)?$/;
export const looksSecret = (k) => SECRET_NAME.test(normKey(k));

export function encodeProps(props, drop, counter) {
  const out = {};
  const norm = drop.__norm ||= new Set([...drop].map(normKey));
  for (const [k, v] of Object.entries(props || {})) {
    if (norm.has(normKey(k)) || looksSecret(k)) { if (counter) counter[k] = (counter[k] || 0) + 1; continue; }
    out[k] = encodeValue(v);
  }
  return out;
}

// Read-only paging over a session. Both queries page by elementId in batches of BATCH.
// `int` builds a Neo4j Integer (neo4j.int): the driver sends a plain number as a Float, which LIMIT refuses.
export function neo4jSource(session, int) {
  if (typeof int !== 'function') throw new Error('neo4jSource needs neo4j.int');
  const limit = int(BATCH);
  const rows = async (cypher, params) => (await session.run(cypher, params)).records;
  return {
    async nodePage(accountId, after) {
      const recs = await rows(
        'MATCH (n {accountId: $id}) WHERE elementId(n) > $after ' +
        'RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS props ' +
        'ORDER BY elementId(n) LIMIT $limit',
        { id: accountId, after, limit });
      return recs.map((r) => ({ id: r.get('id'), labels: r.get('labels'), props: r.get('props') }));
    },
    async relPage(accountId, after) {
      const recs = await rows(
        'MATCH (a {accountId: $id})-[r]->(b {accountId: $id}) WHERE elementId(r) > $after ' +
        'RETURN elementId(r) AS id, type(r) AS type, elementId(a) AS start, elementId(b) AS end, properties(r) AS props ' +
        'ORDER BY elementId(r) LIMIT $limit',
        { id: accountId, after, limit });
      return recs.map((r) => ({ id: r.get('id'), type: r.get('type'), start: r.get('start'), end: r.get('end'), props: r.get('props') }));
    },
    async outsideCounts(accountId) {
      const recs = await rows(
        'MATCH (a {accountId: $id})-[r]-(b) WHERE b.accountId IS NULL OR b.accountId <> $id ' +
        'RETURN type(r) AS type, labels(b) AS labels, count(r) AS n',
        { id: accountId });
      return recs.map((r) => ({ type: r.get('type'), labels: r.get('labels'), n: Number(r.get('n').toString()) }));
    },
  };
}

async function* pages(fetch) {
  let after = '';
  for (;;) {
    const page = await fetch(after);
    if (!page.length) return;
    yield page;
    if (page.length < BATCH) return;
    after = page[page.length - 1].id;
  }
}

const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

export function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

export function resolveAccountsDir(env = process.env) {
  if (env.MAXY_ACCOUNTS_DIR) return env.MAXY_ACCOUNTS_DIR;
  const root = env.MAXY_PLATFORM_ROOT || path.join(os.homedir(), 'maxy-code/platform');
  return path.resolve(root, '..', 'data/accounts');
}

// Copies regular files only. Returns the paths left out, each with its reason.
export function copyAccountFiles(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) throw new Error(`account folder not found: ${srcDir}`);
  fs.mkdirSync(destDir, { recursive: true });
  const leftOut = [];
  const go = (rel) => {
    for (const e of fs.readdirSync(path.join(srcDir, rel), { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      let reason = null;
      const lower = e.name.toLowerCase();
      if (!rel && TOP_EXCLUDES.includes(lower)) reason = 'account file';
      else if (e.isDirectory() && SECRET_DIRS.has(lower)) reason = 'secrets folder';
      else if (!e.isDirectory() && isSystemFile(e.name)) reason = SYSTEM_FILE_REASON;
      else if (!e.isDirectory() && (lower === '.env' || lower.startsWith('.env.'))) reason = 'env file';
      else if (!e.isDirectory() && SECRET_FILES.has(lower)) reason = 'credentials file';
      else if (!e.isDirectory() && SECRET_EXT.has(path.extname(lower))) reason = 'key or certificate file';
      else if (e.isSymbolicLink()) reason = 'symlink';
      else if (e.name.startsWith('.')) reason = DOT_REASON;
      else if (!e.isDirectory() && !e.isFile()) reason = 'not a regular file';
      if (reason) { leftOut.push({ path: r, reason }); continue; }
      if (e.isDirectory()) { fs.mkdirSync(path.join(destDir, r), { recursive: true }); go(r); }
      else fs.copyFileSync(path.join(srcDir, r), path.join(destDir, r));
    }
  };
  go('');
  return leftOut;
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

export async function exportAccount({ source, accountId, outDir, accountsDir, labelMap = loadLabelMap(), now = new Date() }) {
  checkAccountId(accountId);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) throw new Error(`out folder is not empty: ${outDir}`);
  // Checked before the graph is read, so a wrong accounts folder writes nothing.
  const accountDir = path.join(accountsDir, accountId);
  if (!fs.existsSync(accountDir)) throw new Error(`account folder not found: ${accountDir}`);
  fs.mkdirSync(outDir, { recursive: true });
  const drop = new Set(labelMap.dropProperties);
  const skip = labelMap.skip;
  const dropped = {};
  const nodes = { byLabel: {}, byLabelSet: {}, exported: 0, trashed: 0 };
  const skipped = { nodes: {}, relationships: {} };
  const leftOut = { skippedEnd: {}, outsideAccount: {} };
  const rels = { byType: {}, exported: 0 };
  const skippedIds = new Set();

  const nodesFile = path.join(outDir, 'nodes.jsonl');
  const nfd = fs.openSync(nodesFile, 'w');
  try {
    for await (const page of pages((a) => source.nodePage(accountId, a))) {
      for (const n of page) {
        const real = n.labels.filter((l) => l !== 'Trashed');
        // Every node of the account counts in byLabel and byLabelSet, as a Cypher count by label does; a skipped one is
        // also counted, with its reason, under skipped.
        for (const l of n.labels) bump(nodes.byLabel, l);
        bump(nodes.byLabelSet, [...n.labels].sort().join(':'));
        if (real.length && real.every((l) => skip[l])) {
          skippedIds.add(n.id);
          for (const l of real) {
            const e = (skipped.nodes[l] ||= { count: 0, reason: skip[l] });
            e.count++;
          }
          continue;
        }
        const trashed = n.labels.includes('Trashed');
        const line = { elementId: n.id, labels: real, trashed, properties: encodeProps(n.props, drop, dropped) };
        fs.writeSync(nfd, JSON.stringify(line) + '\n');
        nodes.exported++;
        if (trashed) nodes.trashed++;
      }
    }
  } finally { fs.closeSync(nfd); }

  const relsFile = path.join(outDir, 'relationships.jsonl');
  const rfd = fs.openSync(relsFile, 'w');
  try {
    for await (const page of pages((a) => source.relPage(accountId, a))) {
      for (const r of page) {
        if (skippedIds.has(r.start) || skippedIds.has(r.end)) { bump(leftOut.skippedEnd, r.type); continue; }
        const line = { elementId: r.id, type: r.type, start: r.start, end: r.end, properties: encodeProps(r.props, drop, dropped) };
        fs.writeSync(rfd, JSON.stringify(line) + '\n');
        rels.exported++;
        bump(rels.byType, r.type);
      }
    }
  } finally { fs.closeSync(rfd); }

  for (const o of await source.outsideCounts(accountId)) {
    bump(leftOut.outsideAccount, o.type, o.n);
  }

  const filesLeftOut = copyAccountFiles(accountDir, path.join(outDir, 'files'));

  const sha256 = {};
  for (const f of ['nodes.jsonl', 'relationships.jsonl']) sha256[f] = sha256File(path.join(outDir, f));
  for (const f of walk(path.join(outDir, 'files'))) sha256['files/' + f] = sha256File(path.join(outDir, 'files', f));

  const manifest = {
    accountId,
    exportedAt: now.toISOString(),
    nodes,
    skipped: skipped.nodes,
    relationships: { ...rels, leftOut },
    droppedProperties: dropped,
    filesLeftOut,
    sha256,
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return; }
  let labels;
  const at = args.indexOf('--labels');
  if (at >= 0) { labels = args[at + 1]; args.splice(at, 2); if (!labels) { console.error(USAGE); process.exit(2); } }
  const [uri, user, passFile, accountId, outDir] = args;
  if (!outDir || args.length !== 5) {
    console.error(USAGE);
    process.exit(2);
  }
  const labelMap = loadLabelMap(labels && path.resolve(labels));
  const driverPath = process.env.NEO4J_DRIVER || path.join(os.homedir(), 'maxy-code/platform/node_modules/neo4j-driver');
  const neo4j = createRequire(import.meta.url)(driverPath);
  checkAccountId(accountId);
  const password = fs.readFileSync(passFile, 'utf8').replace(/\r?\n$/, '');
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  const session = driver.session({ defaultAccessMode: neo4j.session.READ });
  try {
    const m = await exportAccount({ source: neo4jSource(session, neo4j.int), accountId, outDir, accountsDir: resolveAccountsDir(), labelMap });
    for (const f of m.filesLeftOut) console.log(`left out: ${f.path} (${f.reason})`);
    console.log(`left out ${m.filesLeftOut.length} files or folders`);
    console.log(`exported ${m.nodes.exported} nodes, ${m.relationships.exported} relationships, ${Object.keys(m.sha256).length} files to ${outDir}`);
  } finally {
    await session.close();
    await driver.close();
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
