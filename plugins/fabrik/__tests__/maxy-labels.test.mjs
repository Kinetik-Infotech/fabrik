import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const map = JSON.parse(fs.readFileSync(path.join(here, '../import/maxy-labels.json'), 'utf8'));
const schemaPath = process.env.MAXY_SCHEMA_CYPHER;

// Every label the schema names: node patterns such as (n:Label) or (n:A|B), including the
// full-text index label lists. Line comments are removed first.
function schemaLabels(src) {
  const code = src.replace(/\/\/[^\n]*/g, '');
  const found = new Set();
  for (const m of code.matchAll(/\(\s*\w*\s*((?::\s*`?[A-Za-z_]\w*`?(?:\s*\|\s*`?[A-Za-z_]\w*`?)*)+)/g)) {
    for (const l of m[1].matchAll(/[A-Za-z_]\w*/g)) found.add(l[0]);
  }
  return [...found].sort();
}

const source = JSON.parse(fs.readFileSync(path.join(here, '../import/maxy-labels-source.json'), 'utf8'));

test('labels plus skip equal the vendored label list', () => {
  assert.ok(source.labels.length >= 139, `expected at least 139 labels, found ${source.labels.length}`);
  const mapped = Object.keys(map.labels);
  const skipped = Object.keys(map.skip);
  assert.deepEqual(mapped.filter((l) => skipped.includes(l)), []);
  const expected = [...source.labels, ...source.legacyExtra].sort();
  assert.deepEqual([...mapped, ...skipped].sort(), expected);
});

test('the vendored list matches schema.cypher when that file is present', { skip: !schemaPath ? 'MAXY_SCHEMA_CYPHER is not set: set it to maxy-code\'s schema.cypher to run this test' : !fs.existsSync(schemaPath) && `no schema at ${schemaPath}` }, () => {
  assert.deepEqual(schemaLabels(fs.readFileSync(schemaPath, 'utf8')), [...source.labels].sort());
});

test('credential-bearing labels and properties are kept out', () => {
  assert.ok('AccessGrant' in map.skip && 'EmailAccount' in map.skip);
  for (const p of ['embedding', 'magicToken', 'sliceToken']) assert.ok(map.dropProperties.includes(p), p);
});

test('each mapped label has a type and one of the four kinds', () => {
  for (const [label, v] of Object.entries(map.labels)) {
    assert.equal(typeof v.type, 'string', label);
    assert.ok(v.type.length > 0, label);
    assert.ok(['activity', 'decision', 'model', 'evidence'].includes(v.kind), `${label}: ${v.kind}`);
  }
});

test('kinds follow the plan', () => {
  const kinds = (ls) => ls.map((l) => map.labels[l]?.kind);
  assert.deepEqual(kinds(['Task', 'Project', 'Event', 'Meeting', 'WorkflowRun', 'Job']), Array(6).fill('activity'));
  assert.deepEqual(kinds(['Decision']), ['decision']);
  assert.deepEqual(kinds(['Workflow', 'WorkflowStep', 'VoiceProfile', 'Preference', 'UserProfile']), Array(5).fill('model'));
  assert.equal(map.labels.Person.kind, 'evidence');
});

test('AdminUser and Trashed are skipped, each skip has a reason', () => {
  assert.ok('AdminUser' in map.skip && 'Trashed' in map.skip);
  for (const [l, reason] of Object.entries(map.skip)) assert.ok(typeof reason === 'string' && reason.length > 10, l);
});

test('relation codes follow fabrik\'s rule and are unique', () => {
  const codes = Object.values(map.relations).map((r) => r.code);
  assert.ok(codes.length > 0);
  for (const [t, r] of Object.entries(map.relations)) {
    assert.match(r.code, /^[a-z]+(_[a-z]+)*$/, t);
    assert.ok(r.code.length <= 100, t);
    assert.ok(r.description.trim().length > 0, t);
  }
  assert.equal(new Set(codes).size, codes.length);
});
