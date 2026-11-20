// scripts/test.mjs: a test run's temporary folders go when the run ends, and its exit code is kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const RUNNER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "test.mjs");

/** A folder with a space in its name, holding one test file. The test makes a folder in its temporary folder, writes
 * both paths as JSON to the file WHERE names, then passes, fails, or waits. */
function testFile(t, end) {
  const dir = mkdtempSync(join(tmpdir(), "test runner "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "made.test.mjs"), where = join(dir, "where.json");
  writeFileSync(file, `import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("makes a folder", async () => {
  writeFileSync(process.env.WHERE, JSON.stringify({ temp: tmpdir(), made: mkdtempSync(join(tmpdir(), "made-")) }));
  ${end}
});
`);
  return { dir, file, where };
}

test("a passing run exits 0, and its temporary folder and what the test made there are gone", t => {
  const { file, where } = testFile(t, "");
  assert.equal(spawnSync(process.execPath, [RUNNER, file], { env: { ...process.env, WHERE: where } }).status, 0);
  const { temp, made } = JSON.parse(readFileSync(where, "utf8"));
  assert.match(basename(temp), /^fabrik-test-/);
  assert.ok(made.startsWith(temp));
  assert.equal(existsSync(temp), false);
});

test("a failing run exits 1, and its temporary folder is gone", t => {
  const { file, where } = testFile(t, `throw new Error("fails on purpose");`);
  assert.equal(spawnSync(process.execPath, [RUNNER, file], { env: { ...process.env, WHERE: where } }).status, 1);
  assert.equal(existsSync(JSON.parse(readFileSync(where, "utf8")).temp), false);
});

// Ctrl+C, a kill, and a closed terminal. Windows has no such signals to send.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  test(`a run stopped by ${signal} exits 1, and its temporary folder is gone`, { skip: process.platform === "win32" }, async t => {
    const { dir, file, where } = testFile(t, "await new Promise(r => setTimeout(r, 60_000));");
    const outer = mkdtempSync(join(dir, "outer-"));
    const runner = spawn(process.execPath, [RUNNER, file], { env: { ...process.env, WHERE: where, TMPDIR: outer, TMP: outer, TEMP: outer }, stdio: "ignore" });
    while (!existsSync(where)) await new Promise(r => setTimeout(r, 50));
    runner.kill(signal);
    const [code] = await once(runner, "exit");
    assert.equal(code, 1);
    assert.deepEqual(readdirSync(outer), []);
  });
}
