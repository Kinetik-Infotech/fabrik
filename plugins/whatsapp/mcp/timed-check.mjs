// One timed check, as the timer's launcher runs it with no Claude session: the same check whatsapp_check makes, with
// the fabrik folder's sign-in, the keys folder's lock and the 20-chat batch, then one line in the log.
//
// It never links. When WhatsApp isn't linked, or fabrik refuses the sign-in, it writes the reason in the log and stops,
// and whatsapp_status shows that line at the person's next session. When a check in a session holds the lock, it skips.
//
// runTimedCheck answers the exit code: 0 when it saved, had nothing to save or skipped, and 1 when it stopped on a
// reason.
import { whichSignIn } from "./fabrik.mjs";
import { chatsIn, createWhatsAppPull, readPending } from "./pull.mjs";
import { pullWhatsApp } from "./baileys.mjs";
import { archiveFor, countHistory, keysPath, lockDown, saveSettings, settingsOf, stateOf } from "./keys.mjs";
import { timerPaths, writeLog } from "./timer.mjs";

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** Why a check stopped, in a sentence for the log, or null when it didn't. */
function reasonOf(r) {
  if (r.reason === "not-linked" || r.reason === "logged-out") return "WhatsApp isn't linked on this computer. Link it again in a Claude session.";
  if (r.reason === "connect-timeout") return "WhatsApp didn't answer within 20 seconds. The computer may have been offline.";
  if (r.reason === "drain-timeout") return "WhatsApp kept sending for longer than 30 seconds. The next run takes the rest.";
  if (r.reason === "closed") return "WhatsApp closed the connection. The next run tries again.";
  if (r.report?.problem) return `The messages weren't saved in fabrik: ${r.report.problem}`;
  return null;
}

/** What a check did, as the log line after the time. */
export function logLine(r) {
  const waiting = r.waiting ? `; ${plural(r.waiting, "message")} from ${plural(r.chatsWaiting ?? 1, "chat")} wait for the next check` : "";
  if (r.reason === "busy") return `skipped: another check was connected to WhatsApp${waiting}`;
  const reason = reasonOf(r);
  if (reason) return `stopped: ${reason}${waiting}`;
  const changed = (r.report?.chats ?? []).filter(c => c.added);
  const added = changed.reduce((n, c) => n + c.added, 0);
  const failed = (r.report?.failed ?? []).map(f => `; ${f.file} wasn't saved: ${f.problem}`).join("");
  const saved = added ? `saved ${plural(added, "message")} from ${plural(changed.length, "chat")} in ${r.report.scope.code}` : "no new messages";
  return `${saved}${failed}${waiting}`;
}

/**
 * Runs one check for the fabrik `folder` and adds its line to `log`. `home` and `hooks`, the tests' stand-ins for
 * WhatsApp and fabrik, are for tests; a launcher run in a test passes the hooks through WHATSAPP_TEST_HOOKS, as the
 * server's tests do. Answers the exit code.
 */
export async function runTimedCheck({ folder, log = timerPaths().log, home, hooks, now = () => new Date() }) {
  hooks ??= process.env.WHATSAPP_TEST_HOOKS ? await import(process.env.WHATSAPP_TEST_HOOKS) : {};
  const write = line => writeLog(log, `${now().toISOString()} ${line}`);
  const signIn = whichSignIn(folder, home);
  if (signIn.problem) { write(`stopped: ${signIn.problem}`); return 1; }
  const person = { ...signIn, dir: keysPath(signIn.email, home) };
  if (!stateOf(person.dir).linked) {
    const waiting = readPending(person.dir);
    write(`stopped: ${reasonOf({ reason: "not-linked" })}${waiting.length ? `; ${plural(waiting.length, "message")} from ${plural(chatsIn(waiting), "chat")} wait to be saved` : ""}`);
    return 1;
  }
  const pull = createWhatsAppPull({ authDir: person.dir, archive: archiveFor(person, hooks), pullImpl: hooks.pullWhatsApp ?? pullWhatsApp });
  let r;
  try { r = await pull.run({ trigger: "timer", history: settingsOf(person.dir).history === true }); }
  catch (err) { write(`stopped: ${err instanceof Error ? err.message : String(err)}`); return 1; }
  countHistory(person.dir, r);
  lockDown(person.dir);
  if (!r.reason) saveSettings(person.dir, { ...settingsOf(person.dir), lastCheck: now().toISOString() });
  write(logLine(r));
  return r.reason === "busy" || !reasonOf(r) ? 0 : 1;
}
