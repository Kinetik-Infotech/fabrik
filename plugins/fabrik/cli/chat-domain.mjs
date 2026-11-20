// fabrik chat-page's own-domain step: puts the chat pages at an address on the owner's own domain, such as
// chat.example.com, as a custom domain of the Pages project fabrik-chat-<ref>. The pages.dev address keeps working.
//
// It lists the domains (zones) of the Cloudflare account fabrik is signed in to and asks which one, and which subdomain,
// chat unless the owner types another. A domain whose DNS Cloudflare runs gets its DNS record and certificate from
// Cloudflare. A domain whose DNS is elsewhere needs one CNAME record, pointing at the pages.dev address, which fabrik
// prints for the owner to add at the domain's provider. Either way fabrik asks Cloudflare for the domain's status until
// it is active, up to a limit. The choice is kept in ~/.config/fabrik/chat/<ref>.json, beside the pages' folder, once
// Cloudflare holds the domain, so a later run reuses it without asking. A domain Cloudflare refuses isn't kept.
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

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const message = err => err instanceof Error ? err.message : String(err);
const bare = answer => String(answer ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");

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
    const got = await cf(`/zones?account.id=${encodeURIComponent(accountId)}&per_page=50&page=${page}`);
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
const defaultPause = ms => new Promise(done => setTimeout(done, ms));

/**
 * Puts the Pages project `project`, whose pages.dev address is pagesHost, at an address on the owner's domain. given
 * is --domain's value, if any. Returns the https address the chat is at: the own domain's once Cloudflare reports it
 * active, or the pages.dev one when the owner keeps it. Throws with a plain message where the address can't be chosen,
 * and a DomainNotReady where Cloudflare refuses the domain, or at the limit of tries × every milliseconds.
 * pause(ms), resolve(host, target, onCloudflare) and isDomain(host) are seams for a test.
 */
export async function ownDomain({ ref, project, pagesHost, accountId, token, given }, {
  ask, say, home = homedir(), api = API, every = 10_000, tries = 90, pause = defaultPause, resolve = dnsAnswers,
  isDomain = defaultIsDomain,
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
  const domain = await domainOf(host, zones, isDomain);
  const path = `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(project)}/domains`;
  const one = `${path}/${encodeURIComponent(host)}`;
  let got = await cf(one);
  const wasActive = got.ok && got.result?.status === "active";
  if (!got.ok) {
    const missing = got.status === 404 || got.errors.some(e => e.code === 8000021);
    if (!missing) throw new DomainNotReady(`Cloudflare didn't say whether ${host} is on your chat pages: ${said(got.errors)}`);
    got = await cf(path, { method: "POST", body: { name: host } });
    if (!got.ok) throw refused(`Cloudflare didn't add ${host} to your chat pages: ${said(got.errors)}`);
    say(`Added ${host} to your chat pages on Cloudflare.`);
  }
  keepChoice(ref, host, home);
  const record = `Name ${host.slice(0, -(domain.length + 1))}, type CNAME, target ${pagesHost}`;
  const outside = zone?.type !== "full";
  if (outside) say(zones.length
    ? `Your domain's DNS isn't on this Cloudflare account. Add this record where you manage the DNS of ${domain}: ${record}. fabrik waits for it.`
    : `fabrik can't see the domains on this Cloudflare account. If ${domain}'s DNS isn't on Cloudflare, add this record where you manage it: ${record}. fabrik waits for it.`);
  let seen = false, last = null, retried = false;
  for (let i = 0; i < tries; i++) {
    if (i > 0) got = await cf(one);
    const d = got.result ?? {};
    if (got.ok && d.status === "active") {
      say(`${host} is ready.`);
      if (!wasActive) say(`Add ${host} under Hostname management in the Turnstile widget, beside ${pagesHost}, or the chat can't check visitors there.`);
      return `https://${host}`;
    }
    if (got.ok && ["error", "blocked", "deactivated"].includes(d.status)) {
      const why = d.validation_data?.error_message || d.verification_data?.error_message || `Cloudflare says ${d.status}.`;
      // A domain in error, such as one whose CNAME record came late, is checked again once on Cloudflare's side.
      if (d.status === "error" && !retried) {
        retried = true;
        say(`Cloudflare says ${host} has an error: ${why} fabrik asks it to check again.`);
        got = await cf(one, { method: "PATCH" });
        last = null;
        await pause(every);
        continue;
      }
      throw refused(`Cloudflare couldn't set up ${host}: ${why}`);
    }
    if (got.ok && d.status !== last) { last = d.status; say(`Cloudflare is setting up ${host}: ${d.status}.`); }
    if (!seen && await resolve(host, pagesHost, !outside)) { seen = true; if (outside) say(`fabrik sees the CNAME record for ${host}.`); }
    // Cloudflare adds the record itself on its own DNS. If it hasn't after a minute or so, the owner adds it there.
    if (!seen && !outside && i === Math.ceil(60_000 / every))
      say(`${host} has no DNS record yet. If it's still missing, add it on Cloudflare's DNS page for ${zone.name}: ${record}.`);
    await pause(every);
  }
  const minutes = Math.max(1, Math.round(tries * every / 60_000));
  throw new DomainNotReady(`Cloudflare hasn't finished setting up ${host} after ${minutes === 1 ? "a minute" : `${minutes} minutes`}. ` +
    `It says ${last ?? "nothing"}. Run chat-page again later, and it carries on from here.`);
}
