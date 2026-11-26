// The chat pages' list of agents by topic, and each agent page's links to the agents of its own topic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChatPage, MOST_LINKED } from "../cli/chat-page.mjs";

const ADDRESS = "https://x.example/functions/v1/public-agent";

/** Builds the pages for agents, and gives the root page's main part and a function reading an agent page's links. */
function built(agents) {
  const folder = mkdtempSync(join(tmpdir(), "fabrik-chat-topics-"));
  try {
    buildChatPage({ brand: null, address: ADDRESS, folder, agents });
    const main = readFileSync(join(folder, "index.html"), "utf8").match(/<main>([^]*)<\/main>/)[1];
    const navs = Object.fromEntries(agents.map(a => [a.slug, readFileSync(join(folder, a.slug, "index.html"), "utf8").match(/<nav[^]*?<\/nav>/)?.[0] ?? null]));
    return { main, navs };
  } finally { rmSync(folder, { recursive: true, force: true }); }
}
const headings = main => [...main.matchAll(/<h2>([^<]*)<\/h2>/g)].map(m => m[1]);
const names = html => [...html.matchAll(/<strong>([^<]*)<\/strong>/g)].map(m => m[1]);
const linked = nav => [...nav.matchAll(/<a href="([^"]*)"/g)].map(m => m[1]);

const AGENTS = [
  { slug: "main", name: "Ask us", purpose: "Answers any question." },
  { slug: "n95", name: "N95 masks", purpose: "", topic: "Masks" },
  { slug: "hair", name: "Hair loss", purpose: "", topic: "  hair care " },
  { slug: "cloth", name: "cloth masks", purpose: "", topic: "masks" },
  { slug: "shampoo", name: "Shampoo", purpose: "Answers about shampoo.", topic: "Hair care" },
  { slug: "other", name: "Allergy", purpose: "", topic: "" },
];

test("the list of agents has a heading for each topic in alphabetical order, its agents by name, and the agents of no topic last", () => {
  const { main } = built(AGENTS);
  assert.deepEqual(headings(main), ["hair care", "Masks", "Other agents"]);
  assert.deepEqual(names(main), ["Hair loss", "Shampoo", "cloth masks", "N95 masks", "Allergy", "Ask us"]);
});

test("an agent's page links to the list and to the other agents of its own topic, labelled with the topic", () => {
  const { navs } = built(AGENTS);
  assert.equal(navs.n95, '<nav aria-label="Masks: other agents"><a href="../">All agents</a><span class="topic">Masks</span><a href="../cloth/">cloth masks</a></nav>');
  assert.deepEqual(linked(navs.shampoo), ["../", "../hair/"]);
  assert.equal(navs.main, '<nav aria-label="Other agents"><a href="../">All agents</a><a href="../other/">Allergy</a></nav>');
});

test("with no topics, the list has no headings and every page links to every other agent", () => {
  const plain = AGENTS.map(({ topic, ...a }) => a);
  const { main, navs } = built(plain);
  assert.deepEqual(headings(main), []);
  assert.match(main, /^<ul class="agents">/);
  assert.deepEqual(names(main), ["Allergy", "Ask us", "cloth masks", "Hair loss", "N95 masks", "Shampoo"]);
  assert.deepEqual(linked(navs.main), ["../", "../other/", "../cloth/", "../hair/", "../n95/", "../shampoo/"]);
});

test("past the most agents a page links to by name, it links to the list alone", () => {
  const many = Array.from({ length: MOST_LINKED + 2 }, (_, i) => ({ slug: `a${i}`, name: `Agent ${i}`, purpose: "", topic: "Masks" }));
  assert.equal(built(many).navs.a0, '<nav aria-label="Masks: other agents"><a href="../">All agents</a></nav>');
  assert.equal(linked(built(many.slice(0, MOST_LINKED + 1)).navs.a0).length, MOST_LINKED + 1);
});

test("one agent has no links", () => {
  assert.equal(built([{ slug: "chat", name: "Chat", purpose: "", topic: "Masks" }]).navs.chat, null);
});
