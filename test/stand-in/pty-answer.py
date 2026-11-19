"""Runs a command at a terminal of its own, as a person types at it: each time the command's output ends with a
prompt, ": ", the next answer is typed, then Return. Prints everything the terminal showed, and exits with the
command's own exit code. Used by setup-flow.ts for the fabrik command's sign-in, which needs a terminal.

  python3 pty-answer.py '<JSON list of answers>' <command> [<argument> ...]

PTY_EARLY, when set, is typed once the command prints its first line, with no Return, as a paste made too soon.
"""
import json, os, pty, select, sys, time

answers = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
shown, typed = b"", 0
early = os.environ.get("PTY_EARLY", "").encode()
while True:
    if early and b"\n" in shown:
        os.write(fd, early)
        early = b""
    ready, _, _ = select.select([fd], [], [], 60)
    if not ready:
        break
    try:
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    shown += data
    if shown.endswith(b": ") and typed < len(answers) and shown.count(b": ") > typed:
        time.sleep(0.05)
        os.write(fd, (answers[typed] + "\r").encode())
        typed += 1
_, status = os.waitpid(pid, 0)
sys.stdout.write(shown.decode("utf-8", "replace").replace("\r\n", "\n"))
sys.exit(os.waitstatus_to_exitcode(status))
