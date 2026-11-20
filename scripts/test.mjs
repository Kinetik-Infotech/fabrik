#!/usr/bin/env node
// Runs `node --test` on the files given, inside a temporary folder of the run's own:
//
//   node scripts/test.mjs <test files>
//
// The run's tests, and every program they start, make their temporary folders and files there: TMPDIR, TMP and TEMP
// all name it. The folder is removed when the run ends, whether the tests pass, fail or are stopped by Ctrl+C,
// SIGTERM or the terminal closing. The exit code is the test run's.
import process from "node:process";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const folder = mkdtempSync(join(tmpdir(), "fabrik-test-"));
const remove = () => {
  try { rmSync(folder, { recursive: true, force: true, maxRetries: 5 }); }
  catch (err) { console.error(`The run's temporary folder ${folder} could not be removed: ${err.message}`); }
};

// NODE_TEST_CONTEXT, set when the runner is itself started by a test, would make the run report to that test's runner.
const { NODE_TEST_CONTEXT, ...env } = process.env;
const run = spawn(process.execPath, ["--test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...env, TMPDIR: folder, TMP: folder, TEMP: folder },
});
// The runner passes a stop on to the test run, waits for it to end, then removes the folder. SIGHUP comes when the
// terminal closes. On Windows, Ctrl+C reaches the test run from the console itself.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { if (process.platform !== "win32") run.kill(signal); });
run.on("error", err => { remove(); console.error(err.message); process.exit(1); });
run.on("exit", code => { remove(); process.exit(code ?? 1); });
