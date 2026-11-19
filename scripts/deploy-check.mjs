// A live check that Supabase's Management API deploys fabrik-apps' files, the largest of fabrik's hosted functions,
// and that Supabase runs them, before fabrik setup --owner relies on it. Run it once, against a project of your own:
//
//   node scripts/deploy-check.mjs --url https://<project reference>.supabase.co
//
// It asks for a Supabase access token at a hidden prompt, deploys fabrik-apps' files as a function named
// fabrik-deploy-check with verify_jwt off, lists the project's functions, posts {} to the function with the
// project's publishable key and prints the status and body, then deletes the function and lists again. It prints one
// line per step. The token goes in the Authorization header and nowhere else: it is not printed, saved or passed on.
// Any answer under 500 shows the function started. Supabase answers 500 or more when a function fails to start.
//
// FABRIK_TEST_MANAGEMENT_API names a stand-in for the Management API, for the plugin's tests, as for fabrik connector-settings.
// With it, --url may be a loopback http address and --ref names the project, and the run says so before any prompt.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API, apiBase, askHidden, deleteFunction, deployFunction, functionsList, managementClient, publishableKey, Refused } from "../plugins/fabrik/cli/management.mjs";
import { functions } from "../setup/build.mjs";

const NAME = "fabrik-deploy-check";
const CHECKED = "fabrik-apps";
const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(resolve(HERE, ".."), "setup");
const USAGE = "Usage: node scripts/deploy-check.mjs --url https://<project reference>.supabase.co";
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
const REAL = /^https:\/\/([a-z0-9]{20})\.supabase\.co$/;

const say = line => process.stdout.write(`${line}\n`);

/** { url, ref } from the arguments, or an error message. */
function parse(argv, stand) {
  const given = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--url", "--ref"].includes(argv[i]) || argv[i + 1] === undefined) return { error: USAGE };
    given[argv[i].slice(2)] = argv[i + 1];
  }
  const url = (given.url ?? "").replace(/\/+$/, "");
  const real = REAL.exec(url);
  // With a stand-in named, only a loopback project address with its --ref is taken, so a real project is never named.
  if (stand) return LOOPBACK.test(url) && /^[a-z0-9]{20}$/.test(given.ref ?? "") ? { url, ref: given.ref } : { error: USAGE };
  if (real && !given.ref) return { url, ref: real[1] };
  return { error: USAGE };
}

/** Runs the check, and returns the exit code: 0 all four steps and the function started, 1 a step failed or was refused, 2 bad options. */
export async function deployCheck(argv, env = process.env) {
  const base = apiBase(env);
  const stand = base !== API;
  const parsed = parse(argv, stand);
  if (parsed.error) { say(parsed.error); return 2; }
  const { url, ref } = parsed;
  if (stand) say(`This run talks to a test stand-in at ${base}, and the project's functions are at ${url}, not at Supabase. Paste no real token.`);
  say("Make a Supabase access token at https://supabase.com/dashboard/account/tokens, with a short expiry, and paste it here. Delete it on that page afterwards.");
  let token;
  try { token = await askHidden("Supabase access token: "); }
  catch (err) { say(err.message); return 1; }
  if (!token) { say("No token was typed."); return 1; }

  const c = managementClient(token, base);
  const clean = text => String(text).split(token).join("[token]");
  // The function is removed whenever a deploy may have reached Supabase, on a failure and on Ctrl-C or a kill.
  let sent = false;
  const remove = async () => {
    if (!sent) return;
    sent = false;
    try { await deleteFunction(c, ref, NAME); say(`Deleted ${NAME}.`); }
    catch { say(`${NAME} may still be deployed in the project. Delete it in the dashboard's Edge Functions.`); }
  };
  const stopped = async () => { say("Stopped."); await remove(); process.exit(1); };
  process.once("SIGINT", stopped);
  process.once("SIGTERM", stopped);
  // A test-only shorter wait, taken only with a stand-in.
  const wait = stand && Number(env.FABRIK_TEST_CALL_TIMEOUT_MS) > 0 ? Number(env.FABRIK_TEST_CALL_TIMEOUT_MS) : 30000;
  try {
    const setup = functions(SETUP).find(f => f.name === CHECKED);
    sent = true;
    await deployFunction(c, ref, {
      name: NAME, entrypoint: setup.entrypoint_path, verifyJwt: false,
      files: setup.files.map(f => ({ name: f.name, text: readFileSync(f.path, "utf-8") })),
    });
    say(`Deployed ${NAME} from ${CHECKED}'s ${setup.files.length} files, with verify_jwt off.`);

    const listed = (await functionsList(c, ref)).find(f => f.slug === NAME);
    if (!listed) throw new Error(`${NAME} is not in the project's list of functions.`);
    say(`Listed: ${NAME} is there, verify_jwt ${listed.verify_jwt}.`);

    const key = await publishableKey(c, ref);
    const res = await fetch(`${url}/functions/v1/${NAME}`, {
      method: "POST", headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(wait),
    });
    const text = (await res.text()).trim();
    say(`Called ${NAME} with {}: status ${res.status}.`);
    say(`Body: ${clean(text) || "(empty)"}`);

    const started = res.status < 500;
    await remove();

    const left = (await functionsList(c, ref)).some(f => f.slug === NAME);
    say(left ? `Listed again: ${NAME} is still there.` : `Listed again: ${NAME} is gone.`);
    if (!started) say(`${NAME} did not start: Supabase answered ${res.status}.`);
    return left || !started ? 1 : 0;
  } catch (err) {
    const why = err instanceof Refused ? `Supabase refused (${err.status}): ${err.message}`
      : err?.name === "TimeoutError" ? `${NAME} gave no answer in ${wait / 1000} seconds.` : (err?.cause?.code ?? err?.message ?? String(err));
    say(clean(`Failed: ${why}`));
    await remove();
    return 1;
  } finally {
    process.off("SIGINT", stopped);
    process.off("SIGTERM", stopped);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await deployCheck(process.argv.slice(2));
}
