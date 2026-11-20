// These five skills lived in three trees and referred to each other by absolute path. Bundled,
// every one of those links has to resolve inside the plugin, or a skill sends the agent to a
// file that is not there and the rule it was pointing at goes unread.
// Run with: node scripts/test.mjs plugins/humanizer/__tests__/humanizer.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS = join(PLUGIN, "skills");

const skillNames = () => readdirSync(SKILLS).sort();

function markdownUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownUnder(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

test("the plugin carries the five skills and each one declares itself", () => {
  assert.deepEqual(skillNames(), ["doctrine", "plainly", "summarise", "translate", "whatis"]);
  for (const name of skillNames()) {
    const skill = join(SKILLS, name, "SKILL.md");
    assert.ok(existsSync(skill), `${name} has no SKILL.md`);
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(skill, "utf-8"))?.[1];
    assert.ok(front !== undefined, `${name} has no frontmatter`);
    assert.equal(/^name:\s*(\S+)/m.exec(front)?.[1], name, `${name} declares a different name`);
  }
});

test("every relative link between the bundled skills resolves to a file that is here", () => {
  const broken = [];
  for (const file of markdownUnder(SKILLS)) {
    for (const [, target] of readFileSync(file, "utf-8").matchAll(/\]\((?!https?:|#)([^)]+)\)/g)) {
      const path = join(dirname(file), target.split("#")[0]);
      if (!existsSync(path)) broken.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

/** The absolute paths these skills used to carry named a home directory and a marketplace that
 *  is not this one. Either would follow the plugin into a public marketplace. */
test("no skill refers to a path outside the plugin", () => {
  const offenders = [];
  for (const file of markdownUnder(SKILLS)) {
    const text = readFileSync(file, "utf-8");
    for (const match of text.matchAll(/\/Users\/[A-Za-z0-9._-]+/g)) offenders.push(`${file} names ${match[0]}`);
    for (const match of text.matchAll(/marketplaces\/(?!fabrik\b)[A-Za-z0-9._-]+/g)) offenders.push(`${file} names ${match[0]}`);
  }
  assert.deepEqual(offenders, []);
});
