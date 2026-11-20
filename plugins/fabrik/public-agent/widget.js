// fabrik's chat button for any website. One line puts it on a page:
//
//   <script src="https://<chat page>/widget.js" data-agent="chat" async></script>
//
// It draws a round button in the bottom right corner, in the brand's accent colour. The button opens the chat page of
// the agent data-agent names in a panel of 380 by 600 pixels, and closes it again. The page is at the same address as
// this file. With no data-agent it opens the list of agents.
//
// Under 480 pixels wide the panel fills the screen. The chat page runs in an iframe, so the website's styles can't
// change it, and Turnstile checks the chat page's own hostname. The panel is made at the first open and kept, so closing it keeps the conversation.
//
// fabrik chat-page writes the brand's accent and the colour on it into data-accent and data-on-accent below. A data-accent
// on the script tag takes their place.
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || !script.src || window.fabrikChatWidget) return;
  window.fabrikChatWidget = true;
  var built = { "data-accent": "{{ACCENT}}", "data-on-accent": "{{ON_ACCENT}}" };
  var COLOUR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  // The text colour that reads best on a colour, near black or white, as fabrik chat-page's onColour works it out.
  function onColour(hex) {
    var h = hex.slice(1);
    if (h.length === 3) h = h.replace(/./g, "$&$&");
    var lin = function (i) { var c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    var l = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
    // 0.0056 is #111111's luminance.
    return (l + 0.05) / (0.0056 + 0.05) > 1.05 / (l + 0.05) ? "#111111" : "#ffffff";
  }
  var given = script.getAttribute("data-accent");
  var accent = given && COLOUR.test(given) ? given : built["data-accent"];
  var onAccent = given && COLOUR.test(given) ? onColour(given) : built["data-on-accent"];
  var agent = script.getAttribute("data-agent");
  var page = new URL(agent && /^[a-z0-9-]{1,40}$/.test(agent) ? agent + "/" : ".", script.src).href;

  var CHAT = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>';
  var CLOSE = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>';

  var style = document.createElement("style");
  style.textContent =
    ".fabrik-chat-button { position: fixed; right: 20px; bottom: 20px; z-index: 2147483001; width: 60px; height: 60px; padding: 0; margin: 0;" +
    " border: 0; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center;" +
    " box-shadow: 0 4px 14px rgba(0,0,0,.25); transition: transform .15s ease; }" +
    ".fabrik-chat-button:hover { transform: scale(1.06); }" +
    ".fabrik-chat-button:focus-visible { outline: 3px solid currentColor; outline-offset: 3px; }" +
    ".fabrik-chat-panel { position: fixed; right: 20px; bottom: 92px; z-index: 2147483000; width: 380px; height: 600px;" +
    " max-height: calc(100vh - 112px); border: 0; border-radius: 16px; background: #fff; box-shadow: 0 12px 40px rgba(0,0,0,.25); }" +
    ".fabrik-chat-panel[hidden] { display: none; }" +
    "@media (max-width: 480px) {" +
    " .fabrik-chat-panel { inset: 0; width: 100%; height: 100%; max-height: none; border-radius: 0; }" +
    " .fabrik-chat-button[aria-expanded=true] { top: 10px; bottom: auto; right: 10px; width: 44px; height: 44px; } }";
  document.head.appendChild(style);

  var button = document.createElement("button");
  button.type = "button";
  button.className = "fabrik-chat-button";
  button.style.background = accent;
  button.style.color = onAccent;
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", "Open the chat");
  button.innerHTML = CHAT;
  var panel = null;

  function toggle() {
    var open = button.getAttribute("aria-expanded") !== "true";
    if (open && !panel) {
      panel = document.createElement("iframe");
      panel.className = "fabrik-chat-panel";
      panel.title = "Chat";
      panel.src = page;
      document.body.appendChild(panel);
    }
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Close the chat" : "Open the chat");
    button.innerHTML = open ? CLOSE : CHAT;
  }
  button.addEventListener("click", toggle);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && button.getAttribute("aria-expanded") === "true") { toggle(); button.focus(); }
  });
  function place() { document.body.appendChild(button); }
  if (document.body) place(); else document.addEventListener("DOMContentLoaded", place);
})();
