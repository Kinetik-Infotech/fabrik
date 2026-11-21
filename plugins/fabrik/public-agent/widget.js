// fabrik's chat button for any website. One line puts it on a page:
//
//   <script src="https://<chat page>/widget.js" data-agent="chat" async></script>
//
// It draws a round button in the bottom right corner, in the brand's accent colour. The button opens the chat page of
// the agent data-agent names in a panel of 380 by 600 pixels, and closes it again. A bar along the panel's top edge
// resizes it: drag the bar up and to the left to make the panel bigger, or the other way to make it smaller. The bar's
// first button makes the panel fill the window, and the same button puts it back. Escape puts a full panel back before
// it closes anything. The page is at the same address as this file. With no data-agent, as on a line from before there were many agents, it opens the agent chat, or the list
// of agents where there is no agent chat.
//
// Under 480 pixels wide the panel fills the screen, with no bar. The chat page runs in an iframe, so the website's styles can't
// change it, and Turnstile checks the chat page's own hostname. The panel is made at the first open and kept, so closing it keeps the conversation.
//
// fabrik chat-page writes the brand's accent and the colour on it into data-accent and data-on-accent below, and the
// agent a line with no data-agent opens into data-agent. A data-accent on the script tag takes the colours' place.
(function () {
  "use strict";
  var script = document.currentScript;
  if (!script || !script.src || window.fabrikChatWidget) return;
  window.fabrikChatWidget = true;
  var built = { "data-accent": "{{ACCENT}}", "data-on-accent": "{{ON_ACCENT}}", "data-agent": "{{AGENT}}" };
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
  var SLUG = /^[a-z0-9-]{1,40}$/;
  var named = script.getAttribute("data-agent");
  var agent = named && SLUG.test(named) ? named : built["data-agent"];
  var page = new URL(agent && SLUG.test(agent) ? agent + "/" : ".", script.src).href;

  var CHAT = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path fill="currentColor" d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>';
  var CLOSE = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>';

  var GRIP = '<svg viewBox="0 0 24 12" width="24" height="12" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 3h16M4 9h16"/></svg>';
  var EXPAND = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>';
  var SHRINK = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M20 10h-6V4M4 14h6v6M14 10l7-7M3 21l7-7"/></svg>';
  var SMALL_CLOSE = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" d="M6 6l12 12M18 6L6 18"/></svg>';

  var style = document.createElement("style");
  style.textContent =
    ".fabrik-chat-button { position: fixed; right: 20px; bottom: 20px; z-index: 2147483001; width: 60px; height: 60px; padding: 0; margin: 0;" +
    " border: 0; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center;" +
    " box-shadow: 0 4px 14px rgba(0,0,0,.25); transition: transform .15s ease; }" +
    ".fabrik-chat-button:hover { transform: scale(1.06); }" +
    ".fabrik-chat-button:focus-visible { outline: 3px solid currentColor; outline-offset: 3px; }" +
    ".fabrik-chat-box { position: fixed; right: 20px; bottom: 92px; z-index: 2147483000; width: 380px; height: 600px; min-width: 300px; min-height: 320px;" +
    " max-width: calc(100vw - 40px); max-height: calc(100vh - 112px); display: flex; flex-direction: column; overflow: hidden;" +
    " border-radius: 16px; background: #fff; box-shadow: 0 12px 40px rgba(0,0,0,.25); }" +
    ".fabrik-chat-box[hidden] { display: none; }" +
    // A dragged size is an inline style, so the full size has to override it.
    ".fabrik-chat-box.fabrik-full { inset: 0; width: 100% !important; height: 100% !important; max-width: none; max-height: none; border-radius: 0; }" +
    ".fabrik-chat-bar { flex: none; display: flex; align-items: center; justify-content: space-between; height: 30px; padding: 0 6px;" +
    " cursor: nwse-resize; touch-action: none; user-select: none; -webkit-user-select: none; }" +
    ".fabrik-full .fabrik-chat-bar { cursor: default; }" +
    ".fabrik-chat-grip { flex: 1; align-self: stretch; display: flex; align-items: center; padding-left: 6px; opacity: .7; }" +
    ".fabrik-chat-bar button { width: 26px; height: 26px; padding: 0; margin: 0 0 0 2px; border: 0; border-radius: 6px; background: transparent;" +
    " color: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center; }" +
    ".fabrik-chat-bar button:hover { background: rgba(127,127,127,.28); }" +
    ".fabrik-chat-bar button:focus-visible { outline: 2px solid currentColor; outline-offset: 1px; }" +
    ".fabrik-chat-panel { flex: 1; min-height: 0; width: 100%; border: 0; background: #fff; }" +
    ".fabrik-chat-box.fabrik-dragging .fabrik-chat-panel { pointer-events: none; }" +
    ".fabrik-chat-button.fabrik-hidden { display: none; }" +
    "@media (max-width: 480px) {" +
    " .fabrik-chat-box { inset: 0; width: 100%; height: 100%; min-width: 0; max-width: none; max-height: none; border-radius: 0; }" +
    " .fabrik-chat-bar { display: none; }" +
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
  var box = null, frame = null, expand = null;
  var MIN_W = 300, MIN_H = 320;

  function full(on) {
    box.classList.toggle("fabrik-full", on);
    button.classList.toggle("fabrik-hidden", on);
    expand.innerHTML = on ? SHRINK : EXPAND;
    expand.setAttribute("aria-label", on ? "Make the chat smaller" : "Make the chat fill the window");
    expand.setAttribute("aria-pressed", String(on));
  }
  function isFull() { return !!box && box.classList.contains("fabrik-full"); }

  // Dragging the bar resizes the panel from its top left corner, since the panel stays fixed at the bottom right.
  function dragFrom(e) {
    if (e.target.closest("button") || isFull() || e.button > 0) return;
    var startX = e.clientX, startY = e.clientY, w = box.offsetWidth, h = box.offsetHeight;
    var bar = e.currentTarget;
    bar.setPointerCapture(e.pointerId);
    box.classList.add("fabrik-dragging");
    function move(m) {
      var maxW = window.innerWidth - 40, maxH = window.innerHeight - 112;
      box.style.width = Math.max(MIN_W, Math.min(maxW, w + startX - m.clientX)) + "px";
      box.style.height = Math.max(MIN_H, Math.min(maxH, h + startY - m.clientY)) + "px";
    }
    function stop() {
      box.classList.remove("fabrik-dragging");
      bar.removeEventListener("pointermove", move);
      bar.removeEventListener("pointerup", stop);
      bar.removeEventListener("pointercancel", stop);
    }
    bar.addEventListener("pointermove", move);
    bar.addEventListener("pointerup", stop);
    bar.addEventListener("pointercancel", stop);
  }

  function build() {
    box = document.createElement("div");
    box.className = "fabrik-chat-box";
    var bar = document.createElement("div");
    bar.className = "fabrik-chat-bar";
    bar.style.background = accent;
    bar.style.color = onAccent;
    var grip = document.createElement("span");
    grip.className = "fabrik-chat-grip";
    grip.title = "Drag to resize";
    grip.innerHTML = GRIP;
    expand = document.createElement("button");
    expand.type = "button";
    expand.className = "fabrik-chat-expand";
    var close = document.createElement("button");
    close.type = "button";
    close.className = "fabrik-chat-close";
    close.setAttribute("aria-label", "Close the chat");
    close.innerHTML = SMALL_CLOSE;
    bar.appendChild(grip);
    bar.appendChild(expand);
    bar.appendChild(close);
    frame = document.createElement("iframe");
    frame.className = "fabrik-chat-panel";
    frame.title = "Chat";
    frame.src = page;
    box.appendChild(bar);
    box.appendChild(frame);
    document.body.appendChild(box);
    bar.addEventListener("pointerdown", dragFrom);
    bar.addEventListener("dblclick", function (e) { if (!e.target.closest("button")) full(!isFull()); });
    expand.addEventListener("click", function () { full(!isFull()); });
    close.addEventListener("click", function () { toggle(); button.focus(); });
    full(false);
  }

  function toggle() {
    var open = button.getAttribute("aria-expanded") !== "true";
    if (open && !box) build();
    box.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Close the chat" : "Open the chat");
    button.innerHTML = open ? CLOSE : CHAT;
    // A full panel hides the button, so closing from the bar has to bring it back, and opening restores the last size.
    if (!open) button.classList.remove("fabrik-hidden");
    else button.classList.toggle("fabrik-hidden", isFull());
  }
  button.addEventListener("click", toggle);
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || button.getAttribute("aria-expanded") !== "true") return;
    if (isFull()) { full(false); expand.focus(); } else { toggle(); button.focus(); }
  });
  function place() { document.body.appendChild(button); }
  if (document.body) place(); else document.addEventListener("DOMContentLoaded", place);
})();
