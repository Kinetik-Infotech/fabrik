// The fabrik plugin's skills and its agent, read as files: each connector tool a skill names is one fabrik-apps
// serves, each skill the agent names is a folder of skills, the routine skills pass the humanizer's checks, and no
// skill names another product's commands. Run with: node --test
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../cli/lib/humanizer-checks.mjs";
import { GUIDES_FILE, guidesSource, readGuides } from "../../../setup/build.mjs";

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)));
const ROOT = resolve(PLUGIN, "..", "..");
const SKILLS = join(PLUGIN, "skills");
const read = (...parts) => readFileSync(join(...parts), "utf-8");

// The connector's tools, each made with tool({ name: ... }) in the hosted function's source.
const CONNECTOR = join(ROOT, "setup", "functions", "fabrik-apps");
const TOOLS = new Set(readdirSync(CONNECTOR).filter((f) => f.endsWith(".ts"))
  .flatMap((f) => [...read(CONNECTOR, f).matchAll(/tool\(\{\s*name:\s*"([a-z_]+)"/g)].map((m) => m[1])));
// The fabrik command's own tools and their arguments, which skills name beside the connector's.
const CLI = ["tools.mjs", "pages.mjs"].map((f) => read(PLUGIN, "cli", "lib", f)).join("\n");
const COMMAND = new Set([...CLI.matchAll(/name:\s*"([a-z_]+)"/g)].map((m) => m[1]));
const ARGUMENTS = new Set([...CLI.matchAll(/\b([a-z_]+):\s*\{\s*type:/g)].map((m) => m[1]));
// Claude's own tools that search its catalogue of connectors and plugins, which the design skill's stock-take names.
const CLIENT = new Set(["search_mcp_registry", "suggest_connectors", "SearchPlugins"]);
// The tools of Claude in Chrome and of the desktop app's built-in browser, which only the browse skills name.
const BROWSE_SKILLS = ["browse", "catch-up", "save-page", "fill-form", "compare", "research"];
const CHROME = ["browser_batch", "computer", "file_upload", "find", "form_input", "get_page_text", "gif_creator", "javascript_tool",
  "list_connected_browsers", "navigate", "read_console_messages", "read_network_requests", "read_page", "resize_window", "select_browser",
  "switch_browser", "tabs_close_mcp", "tabs_context_mcp", "tabs_create_mcp", "upload_image"];
const BUILT_IN = ["browser_batch", "computer", "find", "form_input", "get_page_text", "javascript_tool", "navigate", "preview_list",
  "preview_logs", "preview_start", "preview_stop", "read_console_messages", "read_network_requests", "read_page", "resize_window",
  "tabs_close", "tabs_context", "tabs_create", "tabs_select"];
const BROWSER = new Set([...CHROME, ...BUILT_IN]);
// A name in backticks shaped like a browser tool: one of theirs, or one starting or ending as only theirs do.
const BROWSER_NAME = (word) => BROWSER.has(word) || /^(tabs|preview|browser)_|_mcp$/.test(word);
// A tool's name starts with what it does. A name in backticks that starts this way, with more words after it, is
// taken to name a tool.
const TOOL_NAME = /^(search|get|list|save|link|unlink|show|read|upload|remember|update|lookup|delete|restore|ingest)(_[a-z]+)+$/;

/** Every Markdown file of a skill, its references included. */
function skillFiles(name) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith(".md")) out.push(join(dir, e.name));
    }
  };
  walk(join(SKILLS, name));
  return out;
}
const SKILL_NAMES = readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
const ROUTINE_SKILLS = ["business", "purpose", "interview", "design"];
const GUIDE_SKILLS = ["getting-started", "support"];

test("the connector's tools are read from its source", () => {
  for (const name of ["search", "get_record", "list_records", "save_record", "link_records", "show_graph"]) assert.ok(TOOLS.has(name), name);
});

test("every connector tool a skill names is one fabrik-apps serves", () => {
  const unknown = [];
  for (const name of SKILL_NAMES) {
    for (const file of skillFiles(name)) {
      for (const [, word] of read(file).matchAll(/`([a-z][a-z_]*)`/g)) {
        const browser = BROWSE_SKILLS.includes(name) && BROWSER.has(word);
        if (TOOL_NAME.test(word) && !TOOLS.has(word) && !COMMAND.has(word) && !ARGUMENTS.has(word) && !CLIENT.has(word) && !browser) unknown.push(`${name}: ${word}`);
      }
    }
  }
  assert.deepEqual([...new Set(unknown)], []);
});

test("every browser tool a skill names is one of Claude in Chrome's or the built-in browser's, in a browse skill", () => {
  const wrong = [];
  for (const name of SKILL_NAMES) {
    for (const file of skillFiles(name)) {
      for (const [, word] of read(file).matchAll(/`([a-z][a-z_]*)`/g)) {
        if (!BROWSER_NAME(word) || TOOLS.has(word) || COMMAND.has(word)) continue;
        if (!BROWSE_SKILLS.includes(name) || !BROWSER.has(word)) wrong.push(`${name}: ${word}`);
      }
    }
  }
  for (const name of BROWSE_SKILLS) assert.ok(SKILL_NAMES.includes(name), `no skill ${name}`);
  assert.deepEqual([...new Set(wrong)], []);
});

test("every skill the agent names is a folder of the plugin's skills", () => {
  const agent = read(PLUGIN, "agents", "assistant.md");
  const named = [...new Set([...agent.matchAll(/fabrik:([a-z][a-z-]*)/g)].map((m) => m[1]))];
  for (const name of [...ROUTINE_SKILLS, ...GUIDE_SKILLS]) assert.ok(named.includes(name), `the agent never names fabrik:${name}`);
  assert.deepEqual(named.filter((name) => !existsSync(join(SKILLS, name, "SKILL.md"))), []);
});

test("the routine skills and their references pass the humanizer's checks", () => {
  for (const name of ROUTINE_SKILLS) {
    const files = skillFiles(name);
    assert.ok(files.length > 0, `${name} has no skill`);
    for (const file of files) assert.deepEqual(check(read(file)), [], file);
  }
  for (const file of ["tools.md", "execution-and-authority.md"]) assert.ok(existsSync(join(SKILLS, "design", "references", file)), file);
});

test("each guide a skill names is one of fabrik's guides", () => {
  const guides = readGuides();
  const topics = new Set(guides.map((g) => g.topic));
  assert.equal(topics.size, guides.length, "two guides share a topic");
  const unknown = [];
  for (const name of SKILL_NAMES) {
    for (const file of skillFiles(name)) {
      for (const m of read(file).matchAll(/The guide is `([a-z0-9-]+)`|`([a-z0-9-]+)` guide\b/g)) {
        const topic = m[1] ?? m[2];
        if (!topics.has(topic)) unknown.push(`${name}: ${topic}`);
      }
    }
  }
  assert.deepEqual(unknown, []);
});

/** The getting-started skill's stages: each numbered section after the mode, by its heading and its text. */
function stages() {
  const text = read(SKILLS, "getting-started", "SKILL.md");
  return [...text.matchAll(/\n## (\d+)\. ([^\n]+)\n([\s\S]*?)(?=\n## |$)/g)].map((m) => ({ heading: m[2], text: m[3] }));
}

test("getting started is one conversation, with no lessons, its stages running from the business to the design in force", () => {
  const text = read(SKILLS, "getting-started", "SKILL.md");
  assert.doesNotMatch(text, /\blessons?\b/i);
  const skills = ["fabrik:business", "fabrik:purpose", "fabrik:interview", "fabrik:design"];
  // Each routine skill is named first in its own stage, and the stages come in Decided's order.
  const all = stages();
  const first = skills.map((skill) => all.findIndex((s) => s.text.includes(`\`${skill}\``)));
  first.forEach((at, i) => assert.ok(at >= 0, `no stage names ${skills[i]}`));
  assert.deepEqual([...first].sort((a, b) => a - b), first, `the stages name ${skills.join(", ")} out of order`);
  const order = ["who", "business", "objective", "today", "design", "in force"];
  const at = order.map((word) => all.findIndex((s) => s.heading.toLowerCase().includes(word)));
  order.forEach((word, i) => assert.ok(at[i] >= 0, `no stage's heading names ${word}`));
  assert.deepEqual([...at].sort((a, b) => a - b), at, `the stages' headings run out of order: ${all.map((s) => s.heading).join(" / ")}`);
  // The stage that saves objectives names their records, and the end shows what is left on a list card.
  assert.match(text, /`Objective: <name>`/);
  assert.match(all[0].text, /When no objective's routine has a purpose statement yet, it starts at section 4/, "section 1 has no stage for objectives without a routine");
  assert.match(all.at(-1)?.text ?? "", /list card/, "the last stage shows no list card");
});

test("the agent offers getting started when it finds no business profile, with Start and Not now", () => {
  const agent = read(PLUGIN, "agents", "assistant.md");
  const start = agent.slice(agent.indexOf("## At the start of a session"), agent.indexOf("\n## ", agent.indexOf("## At the start of a session") + 1));
  assert.match(start, /`list_records` with `kind` `model` and `title` `Business profile`/);
  assert.match(start, /"Start" and "Not now"/);
  assert.match(start, /`Getting started: not now`/, "the offer no longer heeds an owner's saved no");
  assert.doesNotMatch(start, /lesson/i);
  // An actor who is not an administrator gets no getting-started offer, so the business skill is offered instead.
  assert.match(agent, /With none, and no getting-started offer made in this session, offer the business skill once/);
  assert.doesNotMatch(read(PLUGIN, "card-rules.md"), /Start lesson/);
});

test("objectives are their own records, and a routine's purpose statement supports its objective", () => {
  const business = read(SKILLS, "business", "SKILL.md");
  assert.doesNotMatch(business, /`objective`/, "the profile's graph still holds objective nodes");
  assert.match(business, /`Objective: <name>`/);
  assert.match(business, /`properties`[^\n]*`outcome`[^\n]*`measure`/);
  const purpose = read(SKILLS, "purpose", "SKILL.md");
  assert.match(purpose, /`properties` `objective`/, "the purpose statement doesn't name its objective");
  assert.match(purpose, /in General[^\n]*`supports` link to the objective/, "the link to the objective isn't limited to General");
  // list_records matches the word anywhere in a title, so each skill that finds objectives keeps only their titles.
  assert.match(business, /keeps only the records whose title starts `Objective: `/);
  assert.match(read(SKILLS, "getting-started", "SKILL.md"), /keeping only titles that start `Objective: `/);
  assert.match(business, /replaces `properties` whole/);
});

test("getting started asks who fabrik is for before any other question, and saves the answer", () => {
  const all = stages();
  // Section 1 only finds where getting started stands; the first stage that asks the person anything is who it's for.
  assert.match(all[1]?.heading ?? "", /^Who fabrik is for$/, `the stage after where it stands is ${all[1]?.heading}`);
  assert.match(all[1].text, /a business, for their own life, or both/);
  assert.match(all[1].text, /`Getting started: who fabrik is for`/);
  assert.match(all[0].text, /With no record titled `Getting started: who fabrik is for`, it starts at section 2/);
  // A life alone has no business stage, and the agent offers getting started only with neither record.
  assert.match(all[1].text, /the person's own life alone[^\n]*skips section 3/);
  const agent = read(PLUGIN, "agents", "assistant.md");
  assert.match(agent, /When it finds none, call `list_records` with `kind` `evidence` and `title` `Getting started`/);
  assert.match(agent, /`Getting started: who fabrik is for`/, "the offer is made though the person said fabrik is for their life");
});

test("the business skill asks for the website and social media profiles before any other question", () => {
  const business = read(SKILLS, "business", "SKILL.md");
  const at = business.indexOf("\n## 2. ");
  assert.ok(at > 0, "the business skill has no section 2");
  const section = business.slice(at, business.indexOf("\n## ", at + 1));
  const asks = section.split(/(?<=\.)\s+/).filter((s) => /\basks?\b/.test(s));
  assert.match(asks[0] ?? "", /website and social media profiles/, `the first question is: ${asks[0]}`);
  assert.match(section, /`fabrik:brand`/, "the brand is not read from the website");
  assert.match(section, /only for the fields still missing/);
  assert.match(section, /can't be read/, "a page that can't be read is not named");
});

test("an objective is the outcome of one routine, with a personal or business scope", () => {
  for (const name of ["business", "getting-started"]) {
    const text = read(SKILLS, name, "SKILL.md");
    assert.match(text, /An objective is the outcome (the person wants from|of) one routine/, name);
    for (const example of ["triage my email", "plan the family's meals each week", "automate creating invoices", "create content for my social channels"])
      assert.ok(text.includes(example), `${name} lacks the example ${example}`);
  }
  const business = read(SKILLS, "business", "SKILL.md");
  assert.match(business, /`properties`[^\n]*`scope`, `personal` or `business`/);
  assert.doesNotMatch(business, /be paid for every job within a month/, "an objective is still a business result");
});

test("no stage asks which activities serve an objective", () => {
  for (const name of ["business", "getting-started", "purpose"]) {
    const text = read(SKILLS, name, "SKILL.md");
    assert.doesNotMatch(text, /activities (that )?serve|activities behind|which activities/i, name);
    assert.doesNotMatch(text, /`activities`/, `${name} still saves activities on an objective`);
  }
});

test("the interview asks whether each application must stay, and the design keeps the ones that must", () => {
  for (const name of ["interview", "design"]) assert.match(read(SKILLS, name, "SKILL.md"), /must stay/, name);
  // The answer is in the record's summary, not its title, so a changed answer is a new version of the same record.
  assert.match(read(SKILLS, "interview", "SKILL.md"), /titled `<routine>: application <application>`[^\n]*A changed answer is a new version/);
});

test("a guide saved with Windows line endings reads the same as one saved with Unix line endings", () => {
  const folder = mkdtempSync(join(tmpdir(), "guides-"));
  try {
    writeFileSync(join(folder, "01-files.md"), "# Files and search\r\n\r\nUpload a file.\r\n");
    assert.deepEqual(readGuides(folder), [{ topic: "files", title: "Files and search", text: "# Files and search\n\nUpload a file.\n" }]);
  } finally { rmSync(folder, { recursive: true }); }
});

test("guides.ts is what build.mjs guides makes from docs/guides", () => {
  assert.equal(readFileSync(GUIDES_FILE, "utf-8"), guidesSource(), "run node setup/build.mjs guides");
});

test("the guides, the getting-started and support skills and the README pass the humanizer's checks", () => {
  for (const g of readGuides()) assert.deepEqual(check(g.text), [], g.topic);
  for (const name of GUIDE_SKILLS) for (const file of skillFiles(name)) assert.deepEqual(check(read(file)), [], file);
  assert.deepEqual(check(read(ROOT, "README.md")), [], "README.md");
});

test("the records skill's routine in force passes the humanizer's checks", () => {
  const records = read(SKILLS, "records", "SKILL.md");
  const at = records.indexOf("## The routine in force");
  assert.ok(at > 0, "the records skill has no section The routine in force");
  const section = records.slice(at, records.indexOf("\n## ", at + 1));
  assert.deepEqual(check(section), []);
  for (const name of ["list_records", "get_record", "search"]) assert.match(section, new RegExp("`" + name + "`"));
});

test("an SOP is printed from the version in force, not an approved version", () => {
  for (const file of [join(SKILLS, "print", "SKILL.md"), join(SKILLS, "print", "sop_page.py"), join(PLUGIN, "cli", "lib", "pages.mjs")]) {
    const text = read(file);
    assert.doesNotMatch(text, /approved (model )?version|approved design/i, file);
    assert.match(text, /version in force/, file);
  }
});

test("no skill, nor the agent or the README, names another product's commands or names", () => {
  const files = [...SKILL_NAMES.flatMap(skillFiles), join(PLUGIN, "agents", "assistant.md"), join(ROOT, "README.md")];
  // The other product's names, in base64 so this file doesn't spell them out.
  const names = ["SFVNVkk=", "SHVtYW50cmE="].map((b) => Buffer.from(b, "base64").toString()).join("|");
  const pattern = new RegExp(`\\bht_[a-z_]+|\`acmekb\\b|\\bhed:[a-z]|${names}`, "g");
  const found = files.flatMap((file) => [...read(file).matchAll(pattern)].map((m) => `${file}: ${m[0]}`));
  assert.deepEqual(found, []);
});

test("fabrik's copy of the humanizer's checks is the humanizer's file below its header", () => {
  const copy = read(PLUGIN, "cli", "lib", "humanizer-checks.mjs");
  const source = read(ROOT, "plugins", "humanizer", "skills", "translate", "references", "checks.mjs");
  assert.equal(copy.slice(copy.indexOf("\n\n") + 2), source);
});

test("no text the agent or the person reads uses yes as a noun", () => {
  const files = [
    join(PLUGIN, "agents", "assistant.md"), join(PLUGIN, "card-rules.md"),
    ...SKILL_NAMES.flatMap(skillFiles),
    ...readdirSync(join(ROOT, "docs", "guides")).filter((f) => f.endsWith(".md")).map((f) => join(ROOT, "docs", "guides", f)),
    join(ROOT, "README.md"), join(ROOT, "AGENT-SETUP.md"),
    ...readdirSync(CONNECTOR).filter((f) => f.endsWith(".ts")).map((f) => join(CONNECTOR, f)),
  ];
  const found = files.flatMap((file) => check(read(file)).filter((x) => x.rule === "yes-as-a-noun").map((x) => `${file}: ${x.at}`));
  assert.deepEqual(found, []);
});

test("the business skill asks which applications the business can't work without, and not what it must work within", () => {
  const skill = readFileSync(new URL("../skills/business/SKILL.md", import.meta.url), "utf-8");
  assert.match(skill, /which of those applications the business can't work without/);
  assert.match(skill, /`essential` true/);
  assert.doesNotMatch(skill, /must work within|`constraint`/);
});

// The skills that need the card rules and the question hook, which reach only a session on fabrik's agent. Run
// elsewhere, such as in fabrik's source folder, each stops before it asks or saves anything.
const AGENT_SKILLS = ["getting-started", "business", "interview", "design", "purpose", "brand"];

test("each skill that needs fabrik's agent opens by checking the session runs as fabrik:assistant", () => {
  for (const name of AGENT_SKILLS) {
    const body = read(SKILLS, name, "SKILL.md").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    const opening = body.split(/\n## /)[0].split("\n").slice(1).join("\n").trim().split(/\n\n/).slice(0, 2).join("\n\n");
    assert.match(opening, /^This skill runs only as fabrik's assistant, `fabrik:assistant`\./, name);
    assert.match(opening, /`\.claude\/settings\.json`/, name);
    assert.match(opening, /`~\/fabrik`/, name);
    assert.match(opening, /stop/i, name);
  }
});
