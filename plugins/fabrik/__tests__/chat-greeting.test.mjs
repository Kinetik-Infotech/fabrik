// Each agent page gives chat.js the agent's greeting as data-greeting, escaped, and an agent with no greeting has none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChatPage } from "../cli/chat-page.mjs";

const ADDRESS = "https://x.example/functions/v1/public-agent";

/** The script tag that loads chat.js on each agent's page. */
function scriptTags(agents) {
  const folder = mkdtempSync(join(tmpdir(), "fabrik-chat-greeting-"));
  try {
    buildChatPage({ brand: null, address: ADDRESS, folder, agents });
    return Object.fromEntries(agents.map(a => [a.slug, readFileSync(join(folder, a.slug, "index.html"), "utf8").match(/<script src="\.\.\/chat\.js"(?:[^>"]|"[^"]*")*>/)[0]]));
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test("an agent's greeting is written into its page as data-greeting, escaped, with its line breaks and its ends trimmed", () => {
  const tags = scriptTags([{ slug: "main", name: "Ask us", greeting: "  Hi & welcome to \"Ask us\".\r\nI'm <here> to help.\n" }]);
  assert.equal(tags.main, `<script src="../chat.js" data-address="${ADDRESS}" data-agent="main" ` +
    `data-greeting="Hi &amp; welcome to &quot;Ask us&quot;.\nI'm <here> to help.">`);
});

test("an agent with no greeting, or only spaces, has no data-greeting, as before greetings", () => {
  const tags = scriptTags([{ slug: "a", name: "A" }, { slug: "b", name: "B", greeting: "" }, { slug: "c", name: "C", greeting: "  \n " }]);
  for (const slug of ["a", "b", "c"]) assert.equal(tags[slug], `<script src="../chat.js" data-address="${ADDRESS}" data-agent="${slug}">`);
});
