// fabrik chat-page's own-domain step: puts the chat pages at an address on the owner's own domain, such as
// chat.example.com. The pages.dev address of the Pages project fabrik-chat-<ref> keeps working.
//
// It lists the domains (zones) of the Cloudflare account fabrik is signed in to and asks which one, and which subdomain,
// chat unless the owner types another. On a domain whose DNS Cloudflare runs, fabrik puts the same pages up as the
// Worker fabrik-chat-<ref>. That Worker has the pages as static assets and no script, and the address is its custom
// domain. Cloudflare then makes the DNS record and certificate itself. It can't where the address already has a DNS
// record, and fabrik then asks the owner to delete that record. fabrik never deletes one. On a domain whose DNS is
// elsewhere, the address is a custom domain of the Pages project. fabrik prints the one CNAME record the owner adds at
// the domain's provider, pointing at the pages.dev address. A domain whose DNS another Cloudflare account runs is
// refused, since Cloudflare deactivates the address there within minutes. Either way fabrik waits until the address is
// ready, up to a limit. The choice is kept in ~/.config/fabrik/chat/<ref>.json, beside the pages' folder, once
// Cloudflare holds the address, so a later run reuses it without asking. An address Cloudflare refuses isn't kept.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { promises as dns } from "node:dns";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Cloudflare's API. */
export const API = "https://api.cloudflare.com/client/v4";
/** The answer to --domain, or to the question, that keeps the pages.dev address. */
export const KEEP = "pages.dev";
/** The file that keeps one project's choice of address: { "host": "chat.example.com" }, or { "host": null } for pages.dev. */
export const choiceFile = (ref, home = homedir()) => join(home, ".config", "fabrik", "chat", `${ref}.json`);
/** The folder that holds the Wrangler config of one project's chat Worker, beside the pages' folder. */
export const workerFolder = (ref, home = homedir()) => join(home, ".config", "fabrik", "chat", `${ref}-worker`);
/** The Workers runtime version the chat Worker is deployed on. */
export const COMPATIBILITY_DATE = "2026-11-01";

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const message = err => err instanceof Error ? err.message : String(err);
const bare = answer => String(answer ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
const enc = encodeURIComponent;

/** The kept choice: a host name, null for pages.dev, or undefined when nothing is kept. */
export function readChoice(ref, home = homedir()) {
  try {
    const host = JSON.parse(readFileSync(choiceFile(ref, home), "utf8")).host;
    return host === null || (typeof host === "string" && HOST.test(host)) ? host : undefined;
  } catch { return undefined; }
}
export function keepChoice(ref, host, home = homedir()) {
  const file = choiceFile(ref, home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ host })}\n`, { mode: 0o600 });
}
const forgetChoice = (ref, home) => rmSync(choiceFile(ref, home), { force: true });

/** Writes the Wrangler config of the Worker `name`, which serves the pages in `folder` and has no script, and gives its
 * path. The config has no route. Wrangler, run with no terminal, replaces a DNS record in a custom domain's way. So
 * fabrik adds the custom domain itself through Cloudflare's API, and never replaces a record. */
export function writeWorkerConfig({ ref, name, accountId, folder, home = homedir() }) {
  const dir = workerFolder(ref, home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "wrangler.json");
  const config = { name, ...(accountId ? { account_id: accountId } : {}), compatibility_date: COMPATIBILITY_DATE,
    workers_dev: false, preview_urls: false, assets: { directory: folder } };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/** A failure after the pages are up at pages.dev, where the own domain isn't ready: chat-page carries on at pages.dev. */
export class DomainNotReady extends Error {}

/** One call to Cloudflare's API: { ok, status, result, errors, info }. */
async function call(api, token, path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(`${api}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined });
  } catch (err) { return { ok: false, status: 0, errors: [{ message: `fabrik couldn't reach Cloudflare: ${message(err)}` }] }; }
  const got = await res.json().catch(() => ({}));
  return { ok: res.ok && got.success !== false, status: res.status, result: got.result, errors: Array.isArray(got.errors) ? got.errors : [], info: got.result_info };
}
const said = errors => errors.map(e => e.message).filter(Boolean).join(" ") || "nothing more";
/** Whether Cloudflare's answer says the Pages project has no such custom domain. */
const missing = got => got.status === 404 || got.errors.some(e => e.code === 8000021);

/** Calls Cloudflare's API with the sign-in's token, read once, and read again once when Cloudflare refuses it. */
function cloudflare(api, token) {
  let key = token();
  return async (path, options) => {
    let got = await call(api, key, path, options);
    if (got.status === 401 || got.status === 403) { key = token(); got = await call(api, key, path, options); }
    return got;
  };
}

/** The account's zones, as [{ name, type }]. type "full" means Cloudflare runs the domain's DNS. */
export async function listZones({ cf, accountId }) {
  const zones = [];
  for (let page = 1; ; page++) {
    const got = await cf(`/zones?account.id=${enc(accountId)}&per_page=50&page=${page}`);
    if (!got.ok) throw new Error(`Cloudflare didn't list your domains: ${said(got.errors)}`);
    zones.push(...(got.result ?? []).map(z => ({ name: String(z.name).toLowerCase(), type: z.type })));
    if (page >= (got.info?.total_pages ?? 1)) return zones;
  }
}

/** The zone a host is in, the longest zone name it ends with, or null. */
export const zoneOf = (host, zones) =>
  zones.filter(z => host.endsWith(`.${z.name}`)).sort((a, b) => b.name.length - a.name.length)[0] ?? null;

/** Whether a host is a domain itself, the top of a DNS zone: its DNS gives an SOA record for it. A subdomain gives
 * none, even where its domain has an it.com or co.uk ending. */
const defaultIsDomain = host => dns.resolveSoa(host).then(() => true, () => false);

/** The domain a host is under: its Cloudflare zone, else the nearest name above it that DNS gives an SOA record for,
 * else the host without its first label. */
async function domainOf(host, zones, isDomain) {
  const zone = zoneOf(host, zones);
  if (zone) return zone.name;
  const labels = host.split(".");
  for (let i = 1; i < labels.length - 1; i++) {
    const above = labels.slice(i).join(".");
    if (await isDomain(above)) return above;
  }
  return labels.slice(1).join(".");
}

/** The host for an answer, or a reason it can't be the chat's address. A domain itself, such as example.com, is
 * refused: the chat would replace the website there. */
export async function checkHost(answer, zones, isDomain = defaultIsDomain) {
  const host = bare(answer);
  if (!HOST.test(host)) return { problem: `${answer} is not an address such as chat.example.com.` };
  if (zones.some(z => z.name === host) || await isDomain(host))
    return { problem: `fabrik puts the chat on a subdomain, such as chat.${host}, so your website at ${host} stays as it is.` };
  return { host };
}

/** Asks which domain, then which subdomain, and gives the host, or null to keep the pages.dev address. An answer that
 * is already a subdomain, such as chat.example.com, is the host, and no subdomain is asked for. */
async function askHost({ zones, pagesHost, ask, say, isDomain }) {
  zones.forEach((z, i) => say(`${i + 1}. ${z.name}`));
  for (;;) {
    const answer = (await ask(zones.length
      ? `Which domain is the chat for? Type its number, or another domain. Press Return to keep ${pagesHost}: `
      : `Which domain is the chat for, such as example.com? Press Return to keep ${pagesHost}: `)).trim().toLowerCase();
    if (!answer || answer === KEEP) return null;
    const n = Number(answer);
    const domain = Number.isInteger(n) ? zones[n - 1]?.name : bare(answer);
    if (!domain || !HOST.test(domain)) { say(`${answer} is not one of the numbers or a domain such as example.com.`); continue; }
    const parent = domain.slice(domain.indexOf(".") + 1);
    const isHost = !zones.some(z => z.name === domain) && (zoneOf(domain, zones) !== null
      || (parent.includes(".") && !await isDomain(domain) && await isDomain(parent)));
    if (isHost) {
      const checked = await checkHost(domain, zones, isDomain);
      if (checked.host) return checked.host;
      say(checked.problem);
      continue;
    }
    for (;;) {
      const sub = (await ask(`Which subdomain of ${domain}? Press Return for chat: `)).trim().toLowerCase() || "chat";
      if (!LABEL.test(sub)) { say(`${sub} is not a subdomain such as chat or help.`); continue; }
      const checked = await checkHost(`${sub}.${domain}`, zones, isDomain);
      if (checked.host) return checked.host;
      say(checked.problem);
    }
  }
}

/** Whether the host's DNS answers for the chat: with a CNAME record to target, or, where Cloudflare runs the domain's
 * DNS, with an address, as a proxied record gives. lookups is node:dns's promises, or a stand-in. */
export async function dnsAnswers(host, target, onCloudflare, lookups = dns) {
  const cname = await lookups.resolveCname(host).catch(() => []);
  if (cname.some(c => c.toLowerCase().replace(/\.$/, "") === target)) return true;
  return onCloudflare && (await lookups.resolve4(host).catch(() => [])).length > 0;
}
/** Whether Cloudflare runs a domain's DNS: each of its name servers is one of Cloudflare's. */
const defaultOnCloudflare = domain => dns.resolveNs(domain)
  .then(ns => ns.length > 0 && ns.every(n => n.toLowerCase().endsWith(".ns.cloudflare.com")), () => false);

/** Whether https://<host>/ answers with a page, which takes its DNS record and a valid certificate. */
const defaultReach = host => fetch(`https://${host}/`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(10_000) })
  .then(res => res.ok, () => false);
const defaultPause = ms => new Promise(done => setTimeout(done, ms));
const turnstile = (host, pagesHost) =>
  `Add ${host} under Hostname management in the Turnstile widget, beside ${pagesHost}, or the chat can't check visitors there.`;
const notFinished = (host, tries, every, it) => {
  const minutes = Math.max(1, Math.round(tries * every / 60_000));
  return new DomainNotReady(`Cloudflare hasn't finished setting up ${host} after ${minutes === 1 ? "a minute" : `${minutes} minutes`}. ` +
    `${it}Run chat-page again later, and it carries on from here.`);
};

/**
 * Puts the chat pages, up on Pages as `project` at pagesHost, at an address on the owner's domain. given is --domain's
 * value, if any. folder holds the built pages, and deploy(config, what) runs `wrangler deploy` on fabrik's sign-in.
 * Returns the https address the chat is at: the own domain's once it is ready, or the pages.dev one when the owner keeps
 * it. Throws with a plain message where the address can't be chosen. Throws a DomainNotReady where Cloudflare refuses
 * the address, or at the limit of tries × every milliseconds. pause(ms), resolve(host, target, onCloudflare), reach(host),
 * isDomain(host) and onCloudflare(domain) are seams for a test.
 */
export async function ownDomain({ ref, project, pagesHost, accountId, token, given, folder, deploy }, {
  ask, say, home = homedir(), api = API, every = 10_000, tries = 90, pause = defaultPause, resolve = dnsAnswers,
  reach = defaultReach, isDomain = defaultIsDomain, onCloudflare = defaultOnCloudflare,
} = {}) {
  const cf = cloudflare(api, token);
  const zones = await listZones({ cf, accountId });
  let host;
  if (given !== undefined) {
    if (given.trim().toLowerCase() === KEEP) host = null;
    else {
      const checked = await checkHost(given, zones, isDomain);
      if (checked.problem) throw new Error(checked.problem);
      host = checked.host;
    }
  } else {
    host = readChoice(ref, home);
    if (host === undefined) {
      try { host = await askHost({ zones, pagesHost, ask, say, isDomain }); }
      catch (err) {
        throw new Error(`${message(err)} Name the chat's address with --domain, such as --domain chat.${zones[0]?.name ?? "example.com"}, or --domain ${KEEP} to keep ${pagesHost}.`);
      }
    }
  }
  if (host === null) { keepChoice(ref, null, home); return `https://${pagesHost}`; }

  const refused = why => { forgetChoice(ref, home); return new DomainNotReady(why); };
  const zone = zoneOf(host, zones);
  const pages = `/accounts/${enc(accountId)}/pages/projects/${enc(project)}/domains`;
  const onPages = `${pages}/${enc(host)}`;
  let got = await cf(onPages);
  if (!got.ok && !missing(got)) throw new DomainNotReady(`Cloudflare didn't say whether ${host} is on your chat pages: ${said(got.errors)}`);

  if (zone?.type === "full") {
    // An earlier fabrik put the address on the Pages project. Pages lets it go, so the Worker can have it. Where the
    // Worker can't take it, fabrik puts it back on Pages before it stops, so the chat stays up at the address.
    const released = got.ok;
    const putBack = async why => {
      if (released) {
        const back = await cf(pages, { method: "POST", body: { name: host } });
        if (back.ok) {
          keepChoice(ref, host, home);
          const err = new DomainNotReady(`${why} fabrik put ${host} back on your chat pages on Pages, so the chat stays up there.`);
          err.site = `https://${host}`;
          return err;
        }
      }
      return refused(why);
    };
    const name = host.slice(0, -(zone.name.length + 1));
    const record = `${host} already has a DNS record, so Cloudflare can't make the one the chat needs. Delete the record named ${name} on Cloudflare's DNS page for ${zone.name}, https://dash.cloudflare.com/${accountId}/${zone.name}/dns/records.`;
    if (released) {
      got = await cf(onPages, { method: "DELETE" });
      if (!got.ok) throw new DomainNotReady(`Cloudflare didn't take ${host} off your chat pages on Pages: ${said(got.errors)}`);
      say(`Took ${host} off your chat pages on Pages, so the chat pages' Worker can have it.`);
    }
    try { deploy(writeWorkerConfig({ ref, name: project, accountId, folder, home }), "your chat pages' Worker"); }
    catch (err) { throw await putBack(message(err)); }
    const domains = `/accounts/${enc(accountId)}/workers/scripts/${enc(project)}/domains`;
    const origins = [{ hostname: host, zone_name: zone.name }];
    let held;
    for (;;) {
      // Cloudflare's changeset says what adding the address would change: an address another Worker has, or a DNS
      // record in its way, which Cloudflare would replace.
      got = await cf(`${domains}/changeset?replace_state=true`, { method: "POST", body: origins });
      if (!got.ok) throw await putBack(`Cloudflare didn't say whether ${host} can be your chat pages' address: ${said(got.errors)}`);
      const change = got.result ?? {};
      const taken = (change.updated ?? []).find(d => d.modified);
      if (taken) {
        const other = taken.id ? await cf(`/accounts/${enc(accountId)}/workers/domains/${enc(taken.id)}`) : { ok: false };
        throw await putBack(`${host} is already the address of ${other.ok && other.result?.service ? `the Worker ${other.result.service}` : "another Worker"} on Cloudflare. Choose another address with --domain.`);
      }
      held = (change.updated ?? []).some(d => d.hostname === host);
      if (!(change.conflicting ?? []).length) break;
      // With the address back on Pages, the chat stays up until the owner deletes the record and runs chat-page again.
      if (released) throw await putBack(`${record} Then run chat-page again: the chat is off line from when the record goes until then.`);
      keepChoice(ref, host, home);
      say(record);
      try { await ask(`Press Return once the record named ${name} is deleted: `); }
      catch { throw new DomainNotReady(`${host} still has its DNS record. Once it's deleted, run chat-page again.`); }
    }
    if (!held) {
      got = await cf(`${domains}/records`, { method: "PUT", body: { override_scope: true, override_existing_origin: false, override_existing_dns_record: false, origins } });
      // Cloudflare's changeset can miss a record that its PUT then refuses, as it did on 20 November 2026.
      if (!got.ok) throw await putBack(got.errors.some(e => e.code === 100117 || /externally managed DNS/i.test(e.message ?? ""))
        ? `${record} Then run chat-page again: the chat is off line from when the record goes until then.`
        : `Cloudflare didn't make ${host} your chat pages' address: ${said(got.errors)}`);
      say(`Cloudflare is making the DNS record and certificate for ${host}.`);
    }
    keepChoice(ref, host, home);
    for (let i = 0; i < tries; i++) {
      if (await reach(host)) {
        say(`${host} is ready.`);
        if (!held) say(turnstile(host, pagesHost));
        return `https://${host}`;
      }
      await pause(every);
    }
    throw notFinished(host, tries, every, "");
  }

  const domain = await domainOf(host, zones, isDomain);
  // Cloudflare keeps a Pages address only on the account that holds its domain. On a domain another Cloudflare account
  // holds, the address goes active, then Cloudflare deactivates it within minutes and it answers 403.
  if (zones.length && await onCloudflare(domain))
    throw refused(`${domain}'s DNS is on another Cloudflare account. Cloudflare keeps the chat's address only on the account that holds its domain, so a chat at ${host} would stop answering within minutes. Choose a domain on this account, or move ${domain} to this account first.`);
  const wasActive = got.ok && got.result?.status === "active";
  if (!got.ok) {
    got = await cf(pages, { method: "POST", body: { name: host } });
    if (!got.ok) throw refused(`Cloudflare didn't add ${host} to your chat pages: ${said(got.errors)}`);
    say(`Added ${host} to your chat pages on Cloudflare.`);
  }
  keepChoice(ref, host, home);
  const record = `Name ${host.slice(0, -(domain.length + 1))}, type CNAME, target ${pagesHost}`;
  say(zones.length
    ? `Your domain's DNS isn't on this Cloudflare account. Add this record where you manage the DNS of ${domain}: ${record}. fabrik waits for it.`
    : `fabrik can't see the domains on this Cloudflare account. If ${domain}'s DNS isn't on Cloudflare, add this record where you manage it: ${record}. fabrik waits for it.`);
  let seen = false, last = null, retried = false;
  for (let i = 0; i < tries; i++) {
    if (i > 0) got = await cf(onPages);
    const d = got.result ?? {};
    if (got.ok && d.status === "active") {
      say(`${host} is ready.`);
      if (!wasActive) say(turnstile(host, pagesHost));
      return `https://${host}`;
    }
    if (got.ok && ["error", "blocked", "deactivated"].includes(d.status)) {
      const why = d.validation_data?.error_message || d.verification_data?.error_message || `Cloudflare says ${d.status}.`;
      // A domain in error, such as one whose CNAME record came late, is checked again once on Cloudflare's side.
      if (d.status === "error" && !retried) {
        retried = true;
        say(`Cloudflare says ${host} has an error: ${why} fabrik asks it to check again.`);
        got = await cf(onPages, { method: "PATCH" });
        last = null;
        await pause(every);
        continue;
      }
      throw refused(`Cloudflare couldn't set up ${host}: ${why}`);
    }
    if (got.ok && d.status !== last) { last = d.status; say(`Cloudflare is setting up ${host}: ${d.status}.`); }
    if (!seen && await resolve(host, pagesHost, false)) { seen = true; say(`fabrik sees the CNAME record for ${host}.`); }
    await pause(every);
  }
  throw notFinished(host, tries, every, `It says ${last ?? "nothing"}. `);
}
