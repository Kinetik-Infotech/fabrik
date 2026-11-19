// The sign-in pages for fabrik's connector, one set for each person's project, whose fabrik.js sets window.FABRIK
// to its project address, publishable key and name. Setup writes fabrik.js and _headers when it makes the folder.
//
// oauth/consent: Claude sends the person here through the project's OAuth 2.1 server, with an authorization_id
// in the address. The person signs in with their fabrik email and password, and gives their authenticator's
// code where their account has one. The page shows where the person is sent back to, and offers Allow only
// for Claude's own addresses: claude.ai, claude.com, and this computer for Claude Code. Any other address is
// refused, and the page offers Deny alone. Supabase Auth then sends the person back.
//
// The project's own page, index.html, is the project's Site URL. A password reset or an invitation email opens
// it, signed in from the link, and the person sets a new password there.
//
// Every value from the server or the person is escaped before it is shown.
import { createClient } from "/vendor/supabase-js-2.119.0/supabase.mjs";
import { passwordField, wirePassword } from "/password.js";

const { url, key, name } = window.FABRIK;
// Read before the client takes the link's tokens out of the address.
const linkType = new URLSearchParams(location.hash.slice(1)).get("type") ?? new URLSearchParams(location.search).get("type");
const supabase = createClient(url, key, { auth: { detectSessionInUrl: true, flowType: "implicit" } });
const id = new URLSearchParams(location.search).get("authorization_id");
// The client the request names, so access given to an address that is not Claude's can be taken back.
let clientId = null;
const card = document.querySelector(".card");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// The header names fabrik, so the card holds no tag of its own.
const show = (html) => { card.innerHTML = html + `<p id="note" role="status"></p>`; };
// Each line of the note is its own text, so nothing in it is read as markup.
const note = (text, refused = false, more = null) => {
  const n = document.querySelector("#note");
  n.textContent = text;
  if (more) n.append(document.createElement("br"), more);
  n.className = refused ? "refused" : "";
};
const busy = (on) => document.querySelectorAll("button").forEach((b) => { b.disabled = on; });

/** Claude's own return addresses: claude.ai and claude.com over https, and this computer for Claude Code. */
export function claudeHost(address) {
  try {
    const u = new URL(address);
    if (u.protocol === "https:" && ["claude.ai", "claude.com"].includes(u.hostname)) return u.hostname;
    if (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) return `this computer (${u.host})`;
  } catch { /* an address that does not parse is not Claude's */ }
  return null;
}

async function ask() {
  show(`<p>Opening your request…</p>`);
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(id);
  if (error) {
    return show(`<h1>This Link Has Expired</h1>
      <p>fabrik could not find this request: ${esc(error.message)}.</p>
      <p>Go back to Claude, and press Connect on the fabrik connector again.</p>`);
  }
  const { data: { user } } = await supabase.auth.getUser();
  // Fails closed: with no client, the address to follow must be Claude's; otherwise the address Supabase will send the
  // person back to must be given and be Claude's. Supabase Auth gives the client as id, name, uri and logo_uri.
  clientId = data.client?.id ?? null;
  const back = data.client ? (data.redirect_uri ?? "") : (data.redirect_url ?? "");
  // A client with no id is refused too, since access given to it could not be taken back.
  const host = back && claudeHost(back) && (!data.client || clientId) ? claudeHost(back) : null;
  if (host && !data.client) return location.assign(back);
  const who = `<p class="who">Signed in as ${esc(user?.email)}. <a href="#" id="out">Not you?</a></p>`;
  if (!host) {
    let shown = back || "an address it did not name";
    try { shown = new URL(back).host || back; } catch { /* shown as given */ }
    show(`<h1>This Is Not Claude</h1>
      <p class="lead">This request would give your access to ${esc(name)} to <strong>${esc(shown)}</strong>, which is not Claude.</p>
      <p>Press Deny. To connect fabrik, use Connect on the fabrik connector in Claude.</p>
      <div class="actions"><button id="deny">Deny</button></div>${who}`);
  } else {
    show(`<h1>Connect Claude to fabrik</h1>
      <p class="lead">Claude will work in ${esc(name)} as you.</p>
      <ul class="terms">
        <li>It reads and saves only what your own access allows.</li>
        <li>It sends you back to ${esc(host)}.</li>
        <li>You can disconnect it at any time, in Claude's Connectors.</li>
      </ul>
      <div class="actions"><button id="allow">Allow</button><button id="deny" class="quiet">Deny</button></div>${who}`);
    document.querySelector("#allow").onclick = () => decide("approve");
  }
  document.querySelector("#deny").onclick = () => decide("deny");
  document.querySelector("#out").onclick = async (e) => { e.preventDefault(); await supabase.auth.signOut(); signIn(ask); };
}

// Allow and Deny never let Supabase move the page: the page reads the address Supabase answers with, and goes there only
// when it is Claude's. Any other address is shown, and the page stays.
async function decide(action) {
  busy(true);
  note(action === "approve" ? "Connecting…" : "Cancelling…");
  const call = action === "approve" ? supabase.auth.oauth.approveAuthorization : supabase.auth.oauth.denyAuthorization;
  const { data, error } = await call(id, { skipBrowserRedirect: true });
  if (error) { busy(false); note(`fabrik refused: ${error.message}`, true); return; }
  const reply = data?.redirect_url ?? "";
  if (reply && claudeHost(reply)) {
    note(action === "approve" ? "Connected. Taking you back to Claude…" : "Cancelled. Taking you back to Claude…");
    return location.assign(reply);
  }
  if (action !== "approve") return show(`<h1>Request Denied</h1><p>Nothing was given access to ${esc(name)}. You can close this page.</p>`);
  let shown = reply || "an address it did not name";
  try { shown = new URL(reply).host || reply; } catch { /* shown as given */ }
  // Supabase gave the access as it answered, so the page takes it back before it says so.
  const takeBack = async () => {
    let revokeError = { message: "the request named no client" };
    if (clientId) {
      try { ({ error: revokeError } = await supabase.auth.oauth.revokeGrant({ clientId })); }
      catch (err) { revokeError = { message: String(err?.message ?? err) }; }
    }
    if (!revokeError) {
      return show(`<h1>This Is Not Claude</h1>
      <p class="lead">Supabase would have sent your access to ${esc(name)} to <strong>${esc(shown)}</strong>, which is not Claude. fabrik took the access back.</p>
      <p>Close this page. To connect fabrik, use Connect on the fabrik connector in Claude.</p>`);
    }
    show(`<h1>This Is Not Claude</h1>
      <p class="lead">Supabase gave your access to ${esc(name)} to <strong>${esc(shown)}</strong>, which is not Claude, and fabrik could not take it back: ${esc(revokeError.message)}.</p>
      <div class="actions"><button id="revoke">Take It Back</button></div>`);
    document.querySelector("#revoke").onclick = () => { busy(true); takeBack(); };
  };
  await takeBack();
}

/** The authenticator's code, where the person's account has one and this sign-in has not given it. */
async function secondFactor(then) {
  const blocked = (why) => show(`<h1>fabrik Could Not Check Your Sign-In</h1><p>fabrik could not check whether your account needs an authenticator code: ${esc(why)}.</p>
    <p>Reload this page to try again.</p>`);
  const { data: level, error: levelError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (levelError || !level) return blocked(levelError?.message ?? "no answer");
  if (level.nextLevel !== "aal2" || level.currentLevel === "aal2") return then();
  const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors();
  if (factorsError || !factors) return blocked(factorsError?.message ?? "no answer");
  const factor = (factors.totp ?? []).find((f) => f.status === "verified");
  // An account that needs a second factor but has no authenticator app stops here, rather than going on without it.
  if (!factor) return show(`<h1>fabrik Needs an Authenticator App</h1>
    <p>Your account asks for a second factor, and the one it has is not an authenticator app. fabrik takes only an authenticator app's six-digit code.</p>
    <p>Add an authenticator app to your account, then open this page again from Claude.</p>`);
  show(`<h1>Enter Your Code</h1>
    <p class="lead">Enter the six-digit code from your authenticator app.</p>
    <form novalidate>
      <label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label>
      <div class="actions"><button>Continue</button></div>
    </form>`);
  const form = document.querySelector("form");
  form.querySelector("input").focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const code = String(new FormData(form).get("code") ?? "").trim();
    if (!/^[0-9]{6}$/.test(code)) return note("Enter the six digits.", true);
    busy(true);
    note("Checking…");
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    if (error) { busy(false); return note(error.message, true); }
    then();
  };
}

function signIn(then) {
  show(`<h1>Sign In to fabrik</h1>
    <p class="lead">Use the email and password you chose when you set ${esc(name)} up. This is not your Claude or Supabase login.</p>
    <form novalidate>
      <label>Email <input name="email" type="email" autocomplete="off" required></label>
      ${passwordField("Password", "password", "current-password")}
      <div class="actions"><button>Sign in</button></div>
    </form>`);
  const form = document.querySelector("form");
  wirePassword(form);
  form.querySelector("input").focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fields = new FormData(form);
    if (!fields.get("email") || !fields.get("password")) return note("Enter your email and password.", true);
    busy(true);
    note("Signing in…");
    const { error } = await supabase.auth.signInWithPassword({ email: fields.get("email"), password: fields.get("password") });
    if (error) {
      busy(false);
      return note(error.message, true, error.code === "invalid_credentials"
        ? `Check that this is the email and password you chose for ${name}, not your Claude or Supabase login. Forgotten it? In your Supabase dashboard, open Authentication, then Users, and send yourself a password recovery.` : null);
    }
    secondFactor(then);
  };
}

function newPassword() {
  show(`<h1>Set Your Password</h1>
    <p class="lead">Choose the password you will sign in to ${esc(name)} with.</p>
    <form novalidate>
      ${passwordField("New password", "password", "new-password", 'minlength="8"')}
      <div class="actions"><button>Save password</button></div>
    </form>`);
  const form = document.querySelector("form");
  wirePassword(form);
  form.querySelector("input").focus();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const password = String(new FormData(form).get("password") ?? "");
    if (password.length < 8) return note("Use at least eight characters.", true);
    busy(true);
    note("Saving…");
    const { error } = await supabase.auth.updateUser({ password });
    if (error) { busy(false); return note(error.message, true); }
    show(`<h1>Password Saved</h1><p>Sign in to ${esc(name)} with your new password.</p>`);
  };
}

function landing() {
  show(`<h1>Connect fabrik from Claude</h1>
    <p>This page opens from Claude when you connect the fabrik connector.</p>
    <p>In Claude, open Settings, then Connectors, and press Connect on fabrik.</p>`);
}

if (location.pathname.endsWith("/oauth/consent") || location.pathname.endsWith("/oauth/consent.html")) {
  if (!id) landing();
  else if ((await supabase.auth.getSession()).data.session) secondFactor(ask);
  else signIn(ask);
} else {
  // A password reset or an invitation link arrives here with its type in the address, and signs the person in.
  const { data: { session } } = await supabase.auth.getSession();
  if (session && ["recovery", "invite", "signup"].includes(linkType)) newPassword();
  else landing();
}
