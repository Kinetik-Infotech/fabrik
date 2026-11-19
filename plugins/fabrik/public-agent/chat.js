// fabrik's chat box for the owner's website. A page adds it with one script tag, which names the public-agent function's
// address and the Turnstile widget's site key:
//
//   <script src="chat.js" data-address="https://<project>.supabase.co/functions/v1/public-agent" data-sitekey="0x4AAA..."></script>
//
// The box is drawn in the element with id fabrik-chat, or after the script tag when the page has none. It loads
// Cloudflare's Turnstile script and draws its widget. Each question is posted with a new Turnstile token and the last 10
// turns. The page keeps those turns in memory alone, so a reload starts afresh. Each answer is shown as plain text.
(function () {
  "use strict";
  var script = document.currentScript;
  var address = script && script.getAttribute("data-address");
  var sitekey = script && script.getAttribute("data-sitekey");
  var TURNS = 10;
  var turns = [];
  var widget = null;

  var box = document.getElementById("fabrik-chat");
  if (!box) { box = document.createElement("div"); box.id = "fabrik-chat"; script.parentNode.insertBefore(box, script.nextSibling); }
  box.className = (box.className + " fabrik-chat").trim();

  var style = document.createElement("style");
  style.textContent = ".fabrik-chat { font: inherit; color: inherit; display: grid; gap: 8px; }" +
    ".fabrik-chat ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }" +
    ".fabrik-chat li { padding: 6px 10px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }" +
    ".fabrik-chat li.q { justify-self: end; background: color-mix(in srgb, currentColor 10%, transparent); }" +
    ".fabrik-chat li.a { justify-self: start; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); }" +
    ".fabrik-chat li.problem { color: #b42318; }" +
    ".fabrik-chat form { display: flex; gap: 6px; flex-wrap: wrap; }" +
    ".fabrik-chat input[type=text] { flex: 1 1 12em; min-width: 0; padding: 6px 8px; font: inherit; }" +
    ".fabrik-chat button { padding: 6px 12px; font: inherit; }";
  document.head.appendChild(style);

  var list = document.createElement("ol");
  list.setAttribute("aria-live", "polite");
  var form = document.createElement("form");
  var input = document.createElement("input");
  input.type = "text"; input.maxLength = 2000; input.required = true; input.autocomplete = "off";
  input.setAttribute("aria-label", "Your question");
  input.placeholder = "Ask a question";
  var send = document.createElement("button");
  send.type = "submit"; send.textContent = "Send";
  var check = document.createElement("div");
  form.appendChild(input); form.appendChild(send);
  box.appendChild(list); box.appendChild(form); box.appendChild(check);

  function line(text, kind) {
    var li = document.createElement("li");
    li.className = kind;
    li.textContent = text;
    list.appendChild(li);
    li.scrollIntoView({ block: "nearest" });
  }

  if (!address || !sitekey) { line("This chat box needs data-address and data-sitekey on its script tag.", "problem"); form.hidden = true; return; }

  window.fabrikChatTurnstile = function () {
    widget = window.turnstile.render(check, { sitekey: sitekey, size: "flexible" });
  };
  var api = document.createElement("script");
  api.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=fabrikChatTurnstile";
  api.async = true; api.defer = true;
  document.head.appendChild(api);

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var question = input.value.trim();
    if (!question) return;
    var token = widget !== null && window.turnstile ? window.turnstile.getResponse(widget) : "";
    if (!token) { line("Wait for the check below to finish, then send again.", "problem"); return; }
    line(question, "q");
    input.value = "";
    send.disabled = true;
    var history = turns.slice(-TURNS * 2);
    fetch(address, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question, history: history, turnstile_token: token }),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, body: body }; });
    }).then(function (r) {
      if (r.ok && typeof r.body.answer === "string") {
        line(r.body.answer, "a");
        turns.push({ role: "user", content: question }, { role: "assistant", content: r.body.answer });
        turns = turns.slice(-TURNS * 2);
      } else line(r.body.problem || "The assistant can't answer right now. Try again later.", "a problem");
    }, function () {
      line("The assistant can't be reached. Check your connection and try again.", "a problem");
    }).then(function () {
      send.disabled = false;
      if (widget !== null && window.turnstile) window.turnstile.reset(widget);
    });
  });
})();
