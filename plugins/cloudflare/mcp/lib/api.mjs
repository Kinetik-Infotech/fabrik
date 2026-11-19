// One request path for every Cloudflare call, so failures read alike.
//
// When FABRIK_SECRETS is set, the server uses only the connection document in that folder.
// Otherwise it takes the token from the environment or the key=value file in the settings folder.
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const API = "https://api.cloudflare.com/client/v4";
const FOLDER = "fabrik-cloudflare";

/** Set when a folder of its own holds the connection document: nothing else is then read. */
const managed = () => Boolean(process.env.FABRIK_SECRETS);

/** Where a saved token lives when it is not in the environment. Override with CLOUDFLARE_CONFIG_DIR. */
export const configDir = () => {
  if (process.env.FABRIK_SECRETS) return process.env.FABRIK_SECRETS;
  if (process.env.CLOUDFLARE_CONFIG_DIR) return process.env.CLOUDFLARE_CONFIG_DIR;
  return join(homedir(), ".config", FOLDER);
};

// Parsed as key and value rather than sourced: a shell would let a crafted file run something.
function readVar(file, key) {
  if (!existsSync(file)) return null;
  let raw;
  try { raw = readFileSync(file, "utf-8"); } catch { return null; }
  for (const line of raw.split("\n")) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`).exec(line);
    if (m?.[1]) {
      const v = m[1].replace(/^["']|["']$/g, "").trim();
      if (v.length > 0) return v;
    }
  }
  return null;
}

export const tokenPath = () => join(configDir(), "cloudflare.env");
export const connectionPath = () => join(configDir(), "cloudflare.json");

function strictConnection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(",") !== "accountId,accountName,apiToken,connectedAt,version" || value.version !== 1) return null;
  return [value.apiToken, value.accountId, value.accountName, value.connectedAt].every(one => typeof one === "string" && one.length > 0)
    ? value : null;
}

/** A malformed connection document is a refusal, never permission to fall through elsewhere. */
export function readConnection() {
  const path = connectionPath();
  if (!existsSync(path)) return null;
  let value;
  try {
    if (lstatSync(path).isSymbolicLink() || (lstatSync(path).mode & 0o077) !== 0) throw new Error("unsafe mode or symlink");
    value = JSON.parse(readFileSync(path, "utf-8"));
  } catch { throw new Error(`Cloudflare connection document is unreadable: ${path}`); }
  const connection = strictConnection(value);
  if (!connection) throw new Error(`Cloudflare connection document is invalid: ${path}`);
  return connection;
}

/** The API token, or null when Cloudflare was never connected here. Never logged. */
export function readToken() {
  const connection = readConnection();
  if (connection) return connection.apiToken;
  if (managed()) return null;
  return process.env.CLOUDFLARE_API_TOKEN || readVar(tokenPath(), "CLOUDFLARE_API_TOKEN");
}

/** Said beside "no token" when the folder itself is absent, so a moved credential is found, not replaced. */
export const missingFolderHint = () => existsSync(configDir()) ? "" :
  ` The folder ${configDir()} does not exist. Make it, or set CLOUDFLARE_CONFIG_DIR to the folder that holds the token.`;

export const NO_TOKEN_MESSAGE =
  "No Cloudflare API token is available. Set CLOUDFLARE_API_TOKEN in the environment, or write " +
  `CLOUDFLARE_API_TOKEN=<token> into ${tokenPath()}. The token is read, never echoed.`;

export const NO_MANAGED_CONNECTION_MESSAGE =
  "Cloudflare is not connected: FABRIK_SECRETS names a folder with no valid cloudflare.json. Put the connection document there, as the cloudflare skill describes.";

/** Asks Cloudflare which account the token can see rather than storing it: a wrongly scoped
 *  token otherwise fails several steps later, somewhere unrelated. More than one account is
 *  refused unless CLOUDFLARE_ACCOUNT_ID names which to use. */
export async function resolveAccountId(token, fetchImpl = fetch) {
  if (process.env.CLOUDFLARE_ACCOUNT_ID) {
    return { ok: true, accountId: process.env.CLOUDFLARE_ACCOUNT_ID, problem: null };
  }
  let res;
  try {
    res = await fetchImpl(`${API}/accounts?per_page=50`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, accountId: null, problem: `Could not reach Cloudflare: ${oneLine(err)}` };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false, accountId: null,
      problem: "Cloudflare refused that token. Check it was copied whole, and that it has not been rolled.",
    };
  }
  if (!res.ok) return { ok: false, accountId: null, problem: `Cloudflare returned HTTP ${res.status}.` };

  let body;
  try { body = await res.json(); } catch { return { ok: false, accountId: null, problem: "Cloudflare's reply was not readable." }; }
  const accounts = (body.result ?? []).filter(a => typeof a.id === "string" && a.id.length > 0);

  if (accounts.length === 0) {
    return {
      ok: false, accountId: null,
      problem: "That token can see no Cloudflare account. It needs account-level permission, not only zone permission.",
    };
  }
  if (accounts.length > 1) {
    const names = accounts.map(a => `${a.name ?? a.id} (${a.id})`).join(", ");
    return {
      ok: false, accountId: null,
      problem: `That token can see more than one Cloudflare account: ${names}. Set CLOUDFLARE_ACCOUNT_ID to the one to use, so nothing is written to the wrong account.`,
    };
  }
  return { ok: true, accountId: accounts[0].id, problem: null };
}

/** The token and account, resolved once per call. Resolving each time stays right after a
 *  token is rolled. */
export async function credentials(fetchImpl = fetch) {
  let connection;
  try { connection = readConnection(); }
  catch (error) { return { ok: false, creds: null, problem: error instanceof Error ? error.message : "Cloudflare connection document is invalid." }; }
  if (connection) {
    return { ok: true, creds: { token: connection.apiToken, accountId: connection.accountId }, problem: null };
  }
  if (managed())
    return { ok: false, creds: null, problem: NO_MANAGED_CONNECTION_MESSAGE };
  const token = process.env.CLOUDFLARE_API_TOKEN || readVar(tokenPath(), "CLOUDFLARE_API_TOKEN");
  if (!token) return { ok: false, creds: null, problem: NO_TOKEN_MESSAGE + missingFolderHint() };
  const account = await resolveAccountId(token, fetchImpl);
  if (!account.ok) return { ok: false, creds: null, problem: account.problem };
  return { ok: true, creds: { token, accountId: account.accountId }, problem: null };
}

const oneLine = err => (err instanceof Error ? err.message.split("\n")[0] : String(err));

/** One authenticated call against a path relative to the API root, with the envelope unwrapped
 *  and its errors turned into a sentence. A refused call can answer with a success status, so
 *  the envelope decides and the status code is only the fallback. */
export async function callRaw(token, path, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res;
  try {
    res = await fetchImpl(`${API}${path}`, {
      method: opts.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (err) {
    return { ok: false, result: null, problem: `Could not reach Cloudflare: ${oneLine(err)}` };
  }

  let body;
  try { body = await res.json(); }
  catch { return { ok: false, result: null, problem: `Cloudflare returned HTTP ${res.status} and no readable body.` }; }

  if (body.success === true) return { ok: true, result: body.result ?? null, problem: null };

  // Cloudflare's own words: it knows why it refused, and two different refusals send an
  // operator to different places.
  const stated = (body.errors ?? []).map(e => (typeof e.message === "string" ? e.message : null)).filter(Boolean);
  if (stated.length > 0) return { ok: false, result: null, problem: stated.join("; ") };
  return { ok: false, result: null, problem: `Cloudflare refused the call (HTTP ${res.status}).` };
}

/** The same call, with the path taken as relative to this account. */
export const callAccount = (token, accountId, path, opts = {}) =>
  callRaw(token, `/accounts/${accountId}${path}`, opts);
