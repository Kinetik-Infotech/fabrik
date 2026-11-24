// page_check.py's wait for the browser's file, run in Python as the server runs it. On Windows, Edge can return
// before another of its processes writes the picture or PDF. Each case gives its own windows flag and times.
// Run with: node scripts/test.mjs plugins/fabrik/__tests__/page-check.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
page_check.run_browser = lambda *a, **k: 0
line = page_check.picture(page, 900)
print(json.dumps({"line": line, "old_there": os.path.exists(path)}))`);
  assert.equal(out.line, "no picture: the browser wrote none");
  assert.equal(out.old_there, false);
});

// A stand-in browser: it notes its start, its process group, its profile folder and a helper it starts in its group,
// then waits. FAKE_MODE "quits" quits on SIGTERM, "stubborn" notes SIGTERM and keeps waiting, "quick" ends at once.
const FAKE = String.raw`
import os, signal, subprocess, sys, time
if sys.argv[1:] == ["--warm"]:
    sys.exit()
mode, log = os.environ["FAKE_MODE"], os.environ["FAKE_LOG"]
def note(line):
    with open(log, "a") as f: f.write(line + "\n")
profile = next(a.split("=", 1)[1] for a in sys.argv if a.startswith("--user-data-dir="))
note(f"start {os.getpgid(0)} {os.path.isdir(profile)} {profile} {time.monotonic()}")
if mode == "quick":
    time.sleep(0.5); note(f"end {time.monotonic()}"); sys.exit(0)
subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
signal.signal(signal.SIGTERM, (lambda *a: (note("term"), sys.exit(0))) if mode == "quits" else (lambda *a: note("term")))
note("ready")
time.sleep(60)
`;
const UNIX = process.platform === "win32" ? "process groups are not on Windows" : !PYTHON && "needs Python 3";

/** Writes the stand-in browser as a script that runs with this Python, once, and returns its path. It is run once
 * as it is written: macOS checks a new program at its first start, which under load can take seconds. */
let fake;
function fakeBrowser() {
  if (fake) return fake;
  const python = spawnSync(PYTHON[0], [...PYTHON.slice(1), "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
  const path = join(scratch, "fake-browser");
  writeFileSync(path, `#!${python}\n${FAKE}`);
  chmodSync(path, 0o755);
  assert.equal(spawnSync(path, ["--warm"]).status, 0, "the stand-in browser does not run");
  fake = path;
  return path;
}

// Python lines the browser cases share: the log's lines, and whether a process group is gone once it has had 3 s to end.
const SHARED = `
import subprocess
def lines(log):
    return open(log).read().split("\\n") if os.path.exists(log) else []
def group_gone(pgid):
    end = time.monotonic() + 3
    while time.monotonic() < end:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            pass
        time.sleep(0.05)
    return False
`;

test("a browser past its time is asked to quit, and its group and profile folder are gone", { skip: UNIX }, () => {
  const out = run("quits", `${SHARED}
os.environ.update(FAKE_MODE="quits", FAKE_LOG=path + ".log")
t = time.monotonic()
try:
    page_check.run_browser(${JSON.stringify(fakeBrowser())}, [], timeout=4); timed_out = False
except subprocess.TimeoutExpired:
    timed_out = True
seconds = time.monotonic() - t
if not lines(path + ".log"):
    sys.exit("the stand-in browser never started")
start = lines(path + ".log")[0].split()
print(json.dumps({"timed_out": timed_out, "seconds": seconds, "log": lines(path + ".log")[1:], "own_group": start[1] != str(os.getpgid(0)),
                  "profile_was_there": start[2] == "True", "profile_gone": not os.path.exists(start[3]), "group_gone": group_gone(int(start[1]))}))`);
  assert.equal(out.timed_out, true);
  assert.deepEqual(out.log, ["ready", "term", ""]);
  assert.ok(out.seconds >= 4 && out.seconds < 6, `took ${out.seconds} s`);
  assert.equal(out.own_group, true);
  assert.equal(out.profile_was_there, true);
  assert.equal(out.profile_gone, true);
  assert.equal(out.group_gone, true, "the browser's helper is still running");
});

test("a browser that will not quit is killed after the grace time, with its group", { skip: UNIX }, () => {
  const out = run("stubborn", `${SHARED}
os.environ.update(FAKE_MODE="stubborn", FAKE_LOG=path + ".log")
t = time.monotonic()
try:
    page_check.run_browser(${JSON.stringify(fakeBrowser())}, [], timeout=3, grace=1); timed_out = False
except subprocess.TimeoutExpired:
    timed_out = True
seconds = time.monotonic() - t
if not lines(path + ".log"):
    sys.exit("the stand-in browser never started")
start = lines(path + ".log")[0].split()
print(json.dumps({"timed_out": timed_out, "seconds": seconds, "log": lines(path + ".log")[1:],
                  "profile_gone": not os.path.exists(start[3]), "group_gone": group_gone(int(start[1]))}))`);
  assert.equal(out.timed_out, true);
  assert.deepEqual(out.log, ["ready", "term", ""]);
  assert.ok(out.seconds >= 4 && out.seconds < 6, `took ${out.seconds} s`);
  assert.equal(out.profile_gone, true);
  assert.equal(out.group_gone, true);
});

test("when the okb server stops the script, the script asks its browser to quit first", { skip: UNIX }, () => {
  const out = run("stopped", `${SHARED}
log = path + ".log"
script = "import sys, os; sys.path.insert(0, sys.argv[1]); import page_check; page_check.run_browser(sys.argv[2], [], timeout=60)"
child = subprocess.Popen([sys.executable, "-c", script, sys.argv[1], ${JSON.stringify(fakeBrowser())}],
                         env={**os.environ, "FAKE_MODE": "quits", "FAKE_LOG": log}, stderr=subprocess.DEVNULL)
end = time.monotonic() + 20
while "ready" not in lines(log) and time.monotonic() < end:
    time.sleep(0.05)
child.terminate()
code = child.wait(20)
start = lines(log)[0].split()
print(json.dumps({"code": code, "log": lines(log)[1:], "profile_gone": not os.path.exists(start[3]), "group_gone": group_gone(int(start[1]))}))`);
  assert.deepEqual(out.log, ["ready", "term", ""]);
  assert.notEqual(out.code, 0);
  assert.equal(out.profile_gone, true);
  assert.equal(out.group_gone, true);
});

test("with one browser slot, two scripts run their browsers one after the other", { skip: UNIX }, () => {
  const out = run("slots", `${SHARED}
log = path + ".log"
script = "import sys; sys.path.insert(0, sys.argv[1]); import page_check; page_check.BROWSER_SLOTS = 1; page_check.SLOTS_FOLDER = sys.argv[3]; page_check.run_browser(sys.argv[2], [], timeout=60)"
env = {**os.environ, "FAKE_MODE": "quick", "FAKE_LOG": log}
both = [subprocess.Popen([sys.executable, "-c", script, sys.argv[1], ${JSON.stringify(fakeBrowser())}, path + ".slots"], env=env) for _ in range(2)]
codes = [p.wait(30) for p in both]
runs = [float(line.split()[-1]) for line in lines(log) if line]
print(json.dumps({"codes": codes, "times": runs}))`);
  assert.deepEqual(out.codes, [0, 0]);
  const [start1, end1, start2, end2] = out.times;
  assert.equal(out.times.length, 4);
  assert.ok(start1 < end1 && end1 <= start2 && start2 < end2, `the browsers overlapped: ${out.times}`);
});

test("a script stopped while it waits for a browser slot leaves no profile folder", { skip: UNIX }, () => {
  const out = run("waiting", `${SHARED}
import fcntl, tempfile
own_tmp = tempfile.mkdtemp(); slots = os.path.join(own_tmp, "slots"); os.makedirs(slots, mode=0o700)
held = os.open(os.path.join(slots, "0.lock"), os.O_RDWR | os.O_CREAT, 0o600); fcntl.flock(held, fcntl.LOCK_EX)
script = "import sys; sys.path.insert(0, sys.argv[1]); import page_check; page_check.BROWSER_SLOTS = 1; page_check.SLOTS_FOLDER = sys.argv[3]; print('ready', flush=True); page_check.run_browser(sys.argv[2], [], timeout=60)"
child = subprocess.Popen([sys.executable, "-c", script, sys.argv[1], ${JSON.stringify(fakeBrowser())}, slots],
                         env={**os.environ, "TMPDIR": own_tmp, "FAKE_MODE": "quick", "FAKE_LOG": path + ".log"}, stdout=subprocess.PIPE, text=True)
child.stdout.readline()
time.sleep(1)
child.terminate()
code = child.wait(20)
print(json.dumps({"code": code, "browser_started": os.path.exists(path + ".log"),
                  "left": sorted(n for n in os.listdir(own_tmp) if n.startswith("okb-profile-"))}))`);
  assert.notEqual(out.code, 0);
  assert.equal(out.browser_started, false);
  assert.deepEqual(out.left, []);
});

test("a caller's own features to turn off are joined to the browser's copy switch, which Chrome reads once", { skip: !PYTHON && "needs Python 3" }, () => {
  const out = run("features", `
print(json.dumps([page_check.with_features_off(["--a", "--disable-features=Translate,MacAppCodeSignClone", "--b"]),
                  page_check.with_features_off(["--a"])]))`);
  assert.deepEqual(out, [["--a", "--b", "--disable-features=MacAppCodeSignClone,Translate"], ["--a", "--disable-features=MacAppCodeSignClone"]]);
});

test("Chrome on a page that never finishes is stopped at its time, and leaves no process, profile folder or copy of itself", { skip: UNIX }, t => {
  const page = join(scratch, "never.html");
  writeFileSync(page, "<html><body>never<script>while (true) {}</script></body></html>");
  // On macOS, Chrome's copies of itself are in one folder for every Chrome on the computer. A copy counts as this run's
  // only when no other headless Chrome started while it ran, so the run is tried up to three times for a quiet one.
  const out = run("never", `${SHARED}
found = page_check.browser()
if not found:
    print(json.dumps({"skip": True})); sys.exit()
clones = os.path.realpath(os.path.join(os.environ.get("TMPDIR", "/tmp"), "..", "X", "com.google.Chrome.code_sign_clone"))
def listed():
    return set(os.listdir(clones)) if os.path.isdir(clones) else set()
def browsers():
    out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    return {line.split()[0] for line in out.splitlines() if "--headless" in line and "--type=" not in line}
started = []
real_popen = subprocess.Popen
def popen(command, *a, **k):
    process = real_popen(command, *a, **k)
    if command[0] == found:
        started.append(process)
    return process
page_check.subprocess.Popen = popen
for attempt in range(3):
    started.clear(); before, others, others_started = listed(), browsers(), False
    stop = threading.Event()
    def watch():
        global others_started
        while not stop.is_set():
            others_started = others_started or bool(browsers() - others - {str(p.pid) for p in started})
            time.sleep(0.05)
    watcher = threading.Thread(target=watch); watcher.start()
    t = time.monotonic()
    try:
        page_check.run_browser(found, ["--disable-gpu", "--no-first-run", "--use-mock-keychain", "--password-store=basic",
                                       "--screenshot=" + path, "file://" + ${JSON.stringify(page)}], timeout=5); timed_out = False
    except subprocess.TimeoutExpired:
        timed_out = True
    seconds = time.monotonic() - t
    stop.set(); watcher.join()
    if not others_started:
        break
profile = next(a.split("=", 1)[1] for a in started[0].args if a.startswith("--user-data-dir="))
print(json.dumps({"timed_out": timed_out, "seconds": seconds, "profile_gone": not os.path.exists(profile),
                  "group_gone": group_gone(started[0].pid), "quiet": not others_started, "copies_left": sorted(listed() - before)}))`);
  if (out.skip) return;
  assert.equal(out.timed_out, true);
  assert.ok(out.seconds >= 5 && out.seconds < 11, `took ${out.seconds} s`);
  assert.equal(out.profile_gone, true);
  assert.equal(out.group_gone, true);
  if (out.quiet) assert.deepEqual(out.copies_left, [], "Chrome left a copy of itself");
  else t.diagnostic("other browsers started in each try, so Chrome's copies were not checked");
});
