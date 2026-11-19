// page_check.py's wait for the browser's file, run in Python as the server runs it. On Windows, Edge can return
// before another of its processes writes the picture or PDF. Each case gives its own windows flag and times.
// Run with: node --test
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BOARD = fileURLToPath(new URL("../skills/board", import.meta.url));
const PYTHON = [["python3"], ["python"], ["py", "-3"]].find(([cmd, ...rest]) => spawnSync(cmd, [...rest, "--version"]).status === 0);
const scratch = mkdtempSync(join(tmpdir(), "page-check-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));

/** Runs the Python body with page_check imported and `path` a fresh file name, and returns its JSON line. */
function run(name, body) {
  const path = join(scratch, `${name}.png`);
  const script = `import sys, json, threading, time, os\nsys.path.insert(0, sys.argv[1])\nimport page_check\npath = sys.argv[2]\n${body}`;
  const ran = spawnSync(PYTHON[0], [...PYTHON.slice(1), "-c", script, BOARD, path], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  return JSON.parse(ran.stdout.trim().split("\n").pop());
}

test("on Windows, a picture written a second after the browser returns is waited for, whole", { skip: !PYTHON && "needs Python 3" }, () => {
  const out = run("deferred", `
def write():
    time.sleep(1.0)
    with open(path, "wb") as f:
        f.write(b"x" * 1000); f.flush(); time.sleep(0.3); f.write(b"y" * 1000)
threading.Thread(target=write).start()
t = time.monotonic(); ok = page_check.written(path, windows=True)
print(json.dumps({"ok": ok, "seconds": time.monotonic() - t, "size": os.path.getsize(path)}))`);
  assert.equal(out.ok, true);
  assert.equal(out.size, 2000);
  assert.ok(out.seconds >= 1 && out.seconds < 5, `waited ${out.seconds} s`);
});

test("on Windows, a picture that never comes is given up after the time to appear", { skip: !PYTHON && "needs Python 3" }, () => {
  const out = run("absent", `
t = time.monotonic(); ok = page_check.written(path, windows=True, appear=1)
print(json.dumps({"ok": ok, "seconds": time.monotonic() - t}))`);
  assert.equal(out.ok, false);
  assert.ok(out.seconds >= 1 && out.seconds < 2, `waited ${out.seconds} s`);
});

test("on Windows, a file still growing when the time is up is not taken", { skip: !PYTHON && "needs Python 3" }, () => {
  const out = run("growing", `
stop = False
def grow():
    with open(path, "wb") as f:
        while not stop:
            f.write(b"z"); f.flush(); time.sleep(0.1)
threading.Thread(target=grow, daemon=True).start()
ok = page_check.written(path, windows=True, finish=1.5); stop = True
print(json.dumps({"ok": ok}))`);
  assert.equal(out.ok, false);
});

test("elsewhere, the browser's file is looked at once, with no wait", { skip: !PYTHON && "needs Python 3" }, () => {
  const out = run("elsewhere", `
t = time.monotonic(); ok = page_check.written(path, windows=False)
print(json.dumps({"ok": ok, "seconds": time.monotonic() - t}))`);
  assert.equal(out.ok, false);
  assert.ok(out.seconds < 0.2, `waited ${out.seconds} s`);
});

test("a picture an earlier draw left does not pass for the browser's new one", { skip: !PYTHON && "needs Python 3" }, () => {
  const out = run("stale", `
page = path[:-4] + ".html"
open(page, "w").write("<html></html>")
open(path, "wb").write(b"old picture")
page_check.browser = lambda: sys.executable
page_check.subprocess.run = lambda *a, **k: None
line = page_check.picture(page, 900)
print(json.dumps({"line": line, "old_there": os.path.exists(path)}))`);
  assert.equal(out.line, "no picture: the browser wrote none");
  assert.equal(out.old_there, false);
});
