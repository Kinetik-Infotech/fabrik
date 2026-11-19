// The password field of the sign-in page, with a Show button beside it. Pressing the button shows the password as text and
// the button reads Hide, and pressing it again hides the password. The button is a real button of type "button", so it never
// submits the form. Its name stays "Show password", and aria-pressed says whether the password shows, so a screen reader
// hears one toggle button. The page's script wires it, because the page's policy allows no inline script or handler.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The markup of one password field: its label, the field and the Show button. */
export function passwordField(label, name, autocomplete, extra = "") {
  return `<div class="field"><label for="${name}">${esc(label)}</label>
        <div class="pw"><input id="${name}" name="${name}" type="password" autocomplete="${esc(autocomplete)}" ${extra} required>
        <button type="button" class="quiet reveal" aria-pressed="false" aria-controls="${name}" aria-label="Show password">Show</button></div></div>`;
}

/** Makes each Show button under root work. */
export function wirePassword(root) {
  for (const button of root.querySelectorAll("button.reveal")) {
    const field = root.querySelector(`#${button.getAttribute("aria-controls")}`);
    button.onclick = () => {
      const show = field.type === "password";
      field.type = show ? "text" : "password";
      button.textContent = show ? "Hide" : "Show";
      button.setAttribute("aria-pressed", String(show));
    };
  }
}
