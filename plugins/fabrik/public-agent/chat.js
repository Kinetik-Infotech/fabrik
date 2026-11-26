// fabrik's chat box. Each agent's chat page, which fabrik chat-page builds, adds it with one script tag, which names the
// public-agent function's address and the agent's slug:
//
//   <script src="../chat.js" data-address="https://<project>.supabase.co/functions/v1/public-agent" data-agent="chat" data-business="Northfield Bakery"></script>
//
// It asks the address with a GET for the Turnstile widget's site key, unless data-sitekey gives one. The box is drawn in the element with id fabrik-chat, or after the script tag when the page has none. It loads
// Cloudflare's Turnstile script and draws its widget, which shows only when Cloudflare needs the visitor to do something. Each question is posted with a new Turnstile token and the latest
// turns that fit the function's limits: at most 10 turns and 8,000 characters. When the box is drawn it makes the
// conversation's id, a random UUID, and sends it with each question as conversation, so the business can read the
// conversation whole. The page keeps each agent's conversation, its id and its messages with their times, in the browser
// tab's session storage, so a visitor who goes to another page of the chat and comes back finds the conversation as they
// left it. Session storage belongs to that one tab and is cleared when it closes. Where the browser refuses it, the
// conversation lives in the page alone, and a reload starts afresh. A line under the box says the business keeps the conversation,
// naming the business data-business gives. Three bouncing dots stand in the answer's place while the assistant thinks. Each
// answer is shown as plain text, with each web address and email address as a link, and each message with the time it
// was sent.
(function () {
  "use strict";
  var script = document.currentScript;
  var address = script && script.getAttribute("data-address");
  var sitekey = script && script.getAttribute("data-sitekey");
  var agent = script && script.getAttribute("data-agent");
  var business = script && (script.getAttribute("data-business") || "").trim();
  var TURNS = 10, MAX_HISTORY = 8000, MAX_QUESTION = 2000, MAX_ANSWER = 4000;
  var turns = [];
  var conversation = null;
  var shown = [];
  var widget = null;
  // This agent's conversation in the tab's session storage: { conversation, turns, shown }, shown being each message
  // drawn, as { text, kind, at }. Storage the browser refuses leaves the conversation in the page alone.
  var KEY = "fabrik-chat:" + (agent || "chat");
  function stored() {
    try { var v = JSON.parse(window.sessionStorage.getItem(KEY) || "null"); return v && typeof v === "object" ? v : null; } catch (e) { return null; }
  }
  function store() {
    try { window.sessionStorage.setItem(KEY, JSON.stringify({ conversation: conversation, turns: turns, shown: shown })); } catch (e) { /* the page alone */ }
  }

  // A random UUID. randomUUID exists only on https and in newer browsers, so getRandomValues makes one elsewhere. With
  // neither, the post has no conversation and the function makes an id for each question.
  function newId() {
    var c = window.crypto;
    if (c && c.randomUUID) return c.randomUUID();
    if (!c || !c.getRandomValues) return null;
    var b = c.getRandomValues(new Uint8Array(16)), h = "";
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    for (var i = 0; i < 16; i++) h += (i === 4 || i === 6 || i === 8 || i === 10 ? "-" : "") + (b[i] + 256).toString(16).slice(1);
    return h;
  }

  var box = document.getElementById("fabrik-chat");
  if (!box) { box = document.createElement("div"); box.id = "fabrik-chat"; script.parentNode.insertBefore(box, script.nextSibling); }
  box.className = (box.className + " fabrik-chat").trim();

  // fabrik's mark, the gold "f", beside each answer.
  var MARK = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0OCA0OCI+PHJlY3Qgd2lkdGg9IjQ4IiBoZWlnaHQ9IjQ4IiByeD0iMTEiIGZpbGw9IiNFM0E4MkIiLz48cGF0aCBkPSJNMjYuODcgMzUuNDhRMjYuODcgMzYuMDkgMjcuMDcgMzYuNDJRMjcuMjcgMzYuNzUgMjcuNzYgMzYuODFMMjkuODggMzcuMDlRMzAuMzcgMzcuMTQgMzAuNTggMzcuNDFRMzAuNzkgMzcuNjcgMzAuNzkgMzguMDVRMzAuNzkgMzkgMjkuNjQgMzlIMTcuNTlRMTcuMDggMzkgMTYuNzcgMzguNzZRMTYuNDYgMzguNTIgMTYuNDYgMzguMVExNi40NiAzNy43MSAxNi42NyAzNy40NlExNi44OSAzNy4yMiAxNy4zNiAzNy4wOEwxOC4xNSAzNi44N1ExOC43MSAzNi43IDE4LjkzIDM2LjRRMTkuMTQgMzYuMDkgMTkuMTQgMzUuNTVWMjMuNjdRMTkuMTQgMjMuMzMgMTguOTcgMjMuMDhRMTguNzkgMjIuODMgMTguMjkgMjIuNjNMMTcuMiAyMi4yM1ExNi41OCAyMS45NSAxNi4zNSAyMS42OVExNi4xMSAyMS40NCAxNi4xMSAyMS4xUTE2LjExIDIwLjczIDE2LjM5IDIwLjQ4UTE2LjY3IDIwLjI0IDE3LjI1IDIwLjI0SDIwLjU0TDE5LjE3IDIwLjgyVjIwLjNRMTkuMTcgMTkuODMgMTguODMgMTkuMzVRMTguNDggMTguODggMTguMDMgMTguM1ExNy41NyAxNy43MiAxNy4yMiAxNi45NFExNi44OCAxNi4xNSAxNi44OCAxNS4wNlExNi44OCAxMi4zIDE4LjkzIDEwLjY1UTIwLjk3IDkgMjQuNjcgOVEyNy4wNCA5IDI4LjY0IDkuNzRRMzAuMjUgMTAuNDcgMzEuMDcgMTEuNjlRMzEuODkgMTIuOSAzMS44OSAxNC4zM1EzMS44OSAxNS45MiAzMS4wMSAxNi43NFEzMC4xMyAxNy41NiAyOC43NSAxNy41NlEyNy4yMSAxNy41NiAyNi4yOCAxNi42M1EyNS4zNCAxNS43MSAyNS4zNCAxNC4xNVYxMi4zNVEyNS4zNCAxMS41IDI0Ljg5IDExLjFRMjQuNDMgMTAuNjkgMjMuNjcgMTAuNjlRMjIuNzMgMTAuNjkgMjIuMjUgMTEuMjhRMjEuNzYgMTEuODYgMjEuNzYgMTIuOTVRMjEuNzYgMTQuMDIgMjIuMjIgMTQuODhRMjIuNjggMTUuNzQgMjMuMzcgMTYuNDVRMjQuMDYgMTcuMTcgMjQuNzQgMTcuOFEyNS40MyAxOC40NCAyNS44OSAxOS4wN1EyNi4zNSAxOS42OSAyNi4zNSAyMC4zOFYyMS4yN0wyNS42MSAyMC4yNEgzMC4xMVEzMC42MiAyMC4yNCAzMC45MiAyMC40NVEzMS4yMSAyMC42NiAzMS4yMSAyMS4wNlEzMS4yMSAyMS42NyAzMC42MSAyMi4wOFEzMC4wMSAyMi40OSAyOC42NyAyMi40OUgyNi44N1oiIGZpbGw9IiMxQjI0MzMiLz48L3N2Zz4K";
  var style = document.createElement("style");
  style.textContent = ".fabrik-chat { font: inherit; color: inherit; display: grid; gap: 8px; }" +
    ".fabrik-chat ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }" +
    ".fabrik-chat li { padding: 6px 10px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }" +
    ".fabrik-chat li.q { justify-self: end; background: color-mix(in srgb, currentColor 10%, transparent); }" +
    ".fabrik-chat li.a { justify-self: start; position: relative; padding-left: 36px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); }" +
    ".fabrik-chat li.a::before { content: \"\"; position: absolute; left: 8px; top: 7px; width: 20px; height: 20px; background: url(" + MARK + ") center / contain no-repeat; }" +
    ".fabrik-chat li.problem { color: #b42318; }" +
    ".fabrik-chat li a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }" +
    ".fabrik-chat li time { display: block; margin-top: 2px; font-size: 0.75em; opacity: 0.65; }" +
    ".fabrik-chat li.q time { text-align: right; }" +
    ".fabrik-chat li.thinking { display: flex; align-items: center; gap: 5px; min-height: 1.4em; padding: 8px 4px; background: none; border: 0; }" +
    ".fabrik-chat li.thinking span { width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: 0.6; animation: fabrik-chat-bounce 1.2s ease-in-out infinite; }" +
    ".fabrik-chat li.thinking span:nth-child(2) { animation-delay: 0.15s; }" +
    ".fabrik-chat li.thinking span:nth-child(3) { animation-delay: 0.3s; }" +
    "@keyframes fabrik-chat-bounce { 0%, 60%, 100% { transform: translateY(0); opacity: 0.6; } 30% { transform: translateY(-5px); opacity: 1; } }" +
    "@media (prefers-reduced-motion: reduce) { .fabrik-chat li.thinking span { animation-name: fabrik-chat-fade; } }" +
    "@keyframes fabrik-chat-fade { 0%, 60%, 100% { opacity: 0.35; } 30% { opacity: 1; } }" +
    ".fabrik-chat form { display: flex; gap: 6px; flex-wrap: wrap; }" +
    ".fabrik-chat input[type=text] { flex: 1 1 12em; min-width: 0; padding: 6px 8px; font: inherit; }" +
    ".fabrik-chat button { padding: 6px 12px; font: inherit; }" +
    ".fabrik-chat p.kept { margin: 0; font-size: 0.85em; opacity: 0.75; }";
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
  var kept = document.createElement("p");
  kept.className = "kept";
  kept.textContent = business ? business + " keeps this conversation to improve its answers." : "This conversation is kept to improve its answers.";
  form.appendChild(input); form.appendChild(send);
  box.appendChild(list); box.appendChild(form); box.appendChild(kept); box.appendChild(check);

  // A web address or an email address in a message. Punctuation that ends a sentence stays outside the link.
  var LINK = /(https?:\/\/[^\s<>"']+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
  function linked(li, text) {
    var at = 0, m;
    LINK.lastIndex = 0;
    while ((m = LINK.exec(text))) {
      var found = m[0].replace(/[.,;:!?)\]]+$/, "");
      if (m.index > at) li.appendChild(document.createTextNode(text.slice(at, m.index)));
      var a = document.createElement("a");
      a.textContent = found;
      if (found.indexOf("@") > 0 && !/^https?:/.test(found)) a.href = "mailto:" + found;
      else { a.href = found; a.target = "_blank"; a.rel = "noopener noreferrer"; }
      li.appendChild(a);
      at = m.index + found.length;
      LINK.lastIndex = at;
    }
    if (at < text.length) li.appendChild(document.createTextNode(text.slice(at)));
  }

  function line(text, kind, at) {
    var li = document.createElement("li");
    li.className = kind;
    linked(li, text);
    var now = at ? new Date(at) : new Date(), time = document.createElement("time");
    time.dateTime = now.toISOString();
    time.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    li.appendChild(time);
    list.appendChild(li);
    li.scrollIntoView({ block: "nearest" });
  }

  // The answer's place while the assistant thinks: three dots on their own, with no bubble and no mark, read out once as
  // "Thinking". The answer's bubble appears when its text does.
  function thinking() {
    var li = document.createElement("li");
    li.className = "thinking";
    li.setAttribute("role", "status");
    li.setAttribute("aria-label", "Thinking");
    for (var i = 0; i < 3; i++) li.appendChild(document.createElement("span"));
    list.appendChild(li);
    li.scrollIntoView({ block: "nearest" });
    return li;
  }

  if (!address) { line("This chat box needs data-address on its script tag.", "problem"); form.hidden = true; return; }

  // The conversation this tab had with this agent, drawn again, or a new one.
  var earlier = stored();
  if (earlier && typeof earlier.conversation === "string" && Array.isArray(earlier.turns) && Array.isArray(earlier.shown)) {
    conversation = earlier.conversation;
    turns = earlier.turns.filter(function (t) { return t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string"; });
    shown = earlier.shown.filter(function (m) { return m && typeof m.text === "string" && (m.kind === "q" || m.kind === "a"); });
    shown.forEach(function (m) { line(m.text, m.kind, m.at); });
  } else conversation = newId();

  window.fabrikChatTurnstile = function () {
    // The check shows only while Cloudflare needs the visitor, and goes once it passes.
    widget = window.turnstile.render(check, { sitekey: sitekey, size: "flexible", appearance: "interaction-only",
      "before-interactive-callback": function () { check.hidden = false; },
      callback: function () { setTimeout(function () { check.hidden = true; }, 1500); } });
  };
  function loadTurnstile() {
    var api = document.createElement("script");
    api.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=fabrikChatTurnstile";
    api.async = true; api.defer = true;
    document.head.appendChild(api);
  }
  if (sitekey) loadTurnstile();
  else fetch(address, { method: "GET" }).then(function (res) {
    return res.json().catch(function () { return {}; });
  }).then(function (body) {
    if (body.setup === "sitekey") {
      line("This chat isn't set up yet: fabrik has no Turnstile site key. Save it on the public agent card.", "a problem");
      form.hidden = true;
      return;
    }
    if (typeof body.sitekey !== "string" || !body.sitekey) throw new Error("no site key");
    sitekey = body.sitekey;
    loadTurnstile();
  }).catch(function () {
    line("The assistant can't answer right now. Try again later.", "a problem");
    form.hidden = true;
  });

  // The latest turns that fit the function's limits. Older turns are left out.
  function fitting() {
    var kept = [], total = 0;
    for (var i = turns.length - 2; i >= 0 && kept.length < TURNS * 2; i -= 2) {
      var q = turns[i].content, a = turns[i + 1].content;
      if (q.length > MAX_QUESTION || a.length > MAX_ANSWER || total + q.length + a.length > MAX_HISTORY) break;
      total += q.length + a.length;
      kept.unshift(turns[i], turns[i + 1]);
    }
    return kept;
  }

  function posted(question, history, token) {
    var body = { question: question, history: history, turnstile_token: token };
    if (agent) body.agent = agent;
    if (conversation) body.conversation = conversation;
    return body;
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var question = input.value.trim();
    if (!question) return;
    var token = widget !== null && window.turnstile ? window.turnstile.getResponse(widget) : "";
    if (!token) { line("Wait a moment for the security check, then send again.", "problem"); return; }
    var asked = new Date().toISOString();
    line(question, "q", asked);
    input.value = "";
    send.disabled = true;
    var dots = thinking();
    var history = fitting();
    fetch(address, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(posted(question, history, token)),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, body: body }; });
    }).then(function (r) {
      dots.remove();
      if (r.ok && typeof r.body.answer === "string") {
        var answered = new Date().toISOString();
        line(r.body.answer, "a", answered);
        turns.push({ role: "user", content: question }, { role: "assistant", content: r.body.answer });
        turns = turns.slice(-TURNS * 2);
        shown.push({ text: question, kind: "q", at: asked }, { text: r.body.answer, kind: "a", at: answered });
        store();
      } else line(r.body.problem || "The assistant can't answer right now. Try again later.", "a problem");
    }, function () {
      dots.remove();
      line("The assistant can't be reached. Check your connection and try again.", "a problem");
    }).then(function () {
      send.disabled = false;
      if (widget !== null && window.turnstile) window.turnstile.reset(widget);
    });
  });
})();
