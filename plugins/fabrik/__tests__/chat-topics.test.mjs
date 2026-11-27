// The chat pages' list of agents by topic, and each agent page's links to the agents of its own topic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChatPage, mainAgent, MOST_LINKED } from "../cli/chat-page.mjs";

const ADDRESS = "https://x.example/functions/v1/public-agent";

/** Builds the pages for agents, and gives the root page's main part and a function reading an agent page's links. */
function built(agents) {
  const folder = mkdtempSync(join(tmpdir(), "fabrik-chat-topics-"));
  try {
    buildChatPage({ brand: null, address: ADDRESS, folder, agents });
    const root = readFileSync(join(folder, "index.html"), "utf8");
    const main = root.match(/<main>([^]*)<\/main>/)[1];
    const navs = Object.fromEntries(agents.map(a => [a.slug, readFileSync(join(folder, a.slug, "index.html"), "utf8").match(/<nav[^]*?<\/nav>/)?.[0] ?? null]));
    const close = root.match(/<a class="close"[^>]*>/)?.[0] ?? null, script = root.match(/<script>([^]*?)<\/script>/)?.[1] ?? null;
    const logoLink = html => html.match(/<header>(<a class="home"[^>]*>)?<img/)[1] ?? null;
    const logos = Object.fromEntries([["", root], ...agents.map(a => [a.slug, readFileSync(join(folder, a.slug, "index.html"), "utf8")])].map(([k, h]) => [k, logoLink(h)]));
    return { main, navs, close, script, logos };
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
  { slug: "ffp2", name: "FFP2 masks", purpose: "", topic: "masks" },
  { slug: "shampoo", name: "Shampoo", purpose: "Answers about shampoo.", topic: "Hair care" },
  { slug: "other", name: "Allergy", purpose: "", topic: "" },
];

test("the one agent with no topic, where the others have one, is the main agent, and with no topics or several with none there is none", () => {
  assert.equal(mainAgent(AGENTS.filter(a => a.slug !== "other")).slug, "main");
  assert.equal(mainAgent(AGENTS), null);
  assert.equal(mainAgent(AGENTS.map(({ topic, ...a }) => a)), null);
  assert.equal(mainAgent([{ slug: "chat", name: "Chat", purpose: "" }]), null);
});

test("the main agent comes first in the list, above the topic headings", () => {
  const { main } = built(AGENTS.filter(a => a.slug !== "other"));
  assert.match(main, /^<div class="topics"><ul class="agents main"><li><a href="main\/"><strong>Ask us<\/strong><span>Answers any question.<\/span><\/a><\/li><\/ul><section><h2>/);
  assert.deepEqual(headings(main), ["Hair care", "masks"]);
  assert.deepEqual(names(main), ["Ask us", "Hair loss", "Shampoo", "cloth masks", "FFP2 masks", "N95 masks"]);
});

test("the list of agents has a heading for each topic in alphabetical order, its agents by name, and the agents of no topic last", () => {
  const { main } = built(AGENTS);
  assert.deepEqual(headings(main), ["Hair care", "masks", "Other agents"]);
  assert.deepEqual(names(main), ["Hair loss", "Shampoo", "cloth masks", "FFP2 masks", "N95 masks", "Allergy", "Ask us"]);
});

test("a topic's heading takes the spelling most of its agents have, and capitals on a tie", () => {
  const { main } = built(AGENTS.filter(a => a.slug !== "ffp2"));
  assert.deepEqual(headings(main), ["Hair care", "Masks", "Other agents"]);
});

test("an agent's page links to the list and to the other agents of its own topic, labelled with the topic", () => {
  const { navs } = built(AGENTS);
  assert.equal(navs.n95, '<nav aria-label="masks: other agents"><a href="../?from=n95">All agents</a><span class="topic">masks</span><a href="../cloth/">cloth masks</a><a href="../ffp2/">FFP2 masks</a></nav>');
  assert.deepEqual(linked(navs.shampoo), ["../?from=shampoo", "../hair/"]);
  assert.equal(navs.main, '<nav aria-label="Other agents"><a href="../?from=main">All agents</a><a href="../other/">Allergy</a></nav>');
});

test("with no topics, the list has no headings and every page links to every other agent", () => {
  const plain = AGENTS.map(({ topic, ...a }) => a);
  const { main, navs } = built(plain);
  assert.deepEqual(headings(main), []);
  assert.match(main, /^<ul class="agents">/);
  assert.deepEqual(names(main), ["Allergy", "Ask us", "cloth masks", "FFP2 masks", "Hair loss", "N95 masks", "Shampoo"]);
  assert.deepEqual(linked(navs.main), ["../?from=main", "../other/", "../cloth/", "../ffp2/", "../hair/", "../n95/", "../shampoo/"]);
});

test("past the most agents a page links to by name, it links to the list alone", () => {
  const many = Array.from({ length: MOST_LINKED + 2 }, (_, i) => ({ slug: `a${i}`, name: `Agent ${i}`, purpose: "", topic: "Masks" }));
  assert.equal(built(many).navs.a0, '<nav aria-label="Masks: other agents"><a href="../?from=a0">All agents</a></nav>');
  assert.equal(linked(built(many.slice(0, MOST_LINKED + 1)).navs.a0).length, MOST_LINKED + 1);
});

test("one agent has no links", () => {
  assert.equal(built([{ slug: "chat", name: "Chat", purpose: "", topic: "Masks" }]).navs.chat, null);
});

/** Runs the list's script on a page reached at search, and gives where its close link goes and whether it shows. */
function closed({ close, script }, search) {
  const link = { href: close.match(/href="([^"]*)"/)[1], hidden: / hidden/.test(close) };
  new Function("location", "document", "URLSearchParams", script)({ search }, { querySelector: () => link }, URLSearchParams);
  return link;
}

test("the list's close link goes back to the agent page named in from, and otherwise to the main agent", () => {
  const page = built(AGENTS.filter(a => a.slug !== "other"));
  assert.deepEqual(closed(page, "?from=n95"), { href: "n95/", hidden: false });
  assert.deepEqual(closed(page, ""), { href: "main/", hidden: false });
  assert.deepEqual(closed(page, "?from=nobody"), { href: "main/", hidden: false });
  assert.deepEqual(closed(page, "?from=..%2Fx"), { href: "main/", hidden: false });
});

test("with no main agent, the close link shows only for a visitor who came from an agent's page, and one agent's list has none", () => {
  const page = built(AGENTS);
  assert.deepEqual(closed(page, ""), { href: "./", hidden: true });
  assert.deepEqual(closed(page, "?from=other"), { href: "other/", hidden: false });
  const one = built([{ slug: "chat", name: "Chat", purpose: "" }]);
  assert.equal(one.close, null);
  assert.equal(one.script, null);
});

test("with a main agent, every other agent's page links home to it from its logo and from a Home link beside All agents", () => {
  const { navs, logos } = built(AGENTS.filter(a => a.slug !== "other"));
  assert.equal(navs.n95, '<nav aria-label="masks: other agents"><a href="../main/">Home</a><a href="../?from=n95">All agents</a><span class="topic">masks</span><a href="../cloth/">cloth masks</a><a href="../ffp2/">FFP2 masks</a></nav>');
  assert.equal(logos.n95, '<a class="home" href="../main/" aria-label="Home: Ask us">');
  assert.equal(logos.shampoo, '<a class="home" href="../main/" aria-label="Home: Ask us">');
});

test("the main agent's own page has no Home link and its logo links nowhere, and the list's logo links to the main agent", () => {
  const { navs, logos } = built(AGENTS.filter(a => a.slug !== "other"));
  assert.ok(!navs.main.includes(">Home<"));
  assert.equal(logos.main, null);
  assert.equal(logos[""], '<a class="home" href="main/" aria-label="Home: Ask us">');
});

test("with no main agent, or one agent, no page has a Home link and no logo links anywhere", () => {
  const { navs, logos } = built(AGENTS);
  assert.ok(Object.values(navs).every(nav => !nav.includes(">Home<")));
  assert.ok(Object.values(logos).every(link => link === null));
  assert.deepEqual(built([{ slug: "chat", name: "Chat", purpose: "" }]).logos, { "": null, chat: null });
});
