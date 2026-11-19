import test from "node:test";
import assert from "node:assert/strict";
import { check, passes } from "../references/checks.mjs";

const rules = (t) => check(t).map((x) => x.rule);

test("plain prose passes", () => {
  for (const t of [
    "It reads the list of agents from a file on disk. Where a setting is missing it chooses the safer answer. Nothing else on the machine interprets that list.",
    "Not a program. It is a list of instructions for the database, one per kind of thing that has to be findable by meaning.",
    "The function of this file is to take delivery of a message and return an answer.",
  ]) {
    assert.equal(passes(t), true, `${t}\n${JSON.stringify(check(t))}`);
  }
});

test("an em-dash is caught", () => {
  assert.ok(rules("It opens the port — and routes each request.").includes("em-dash"));
});

test("inflation vocabulary is caught", () => {
  assert.ok(rules("It lets you leverage a robust and seamless workflow.").includes("flourish"));
});

test("prose about the page is caught", () => {
  assert.ok(rules("This page shows every file and what each one does.").includes("self-narration"));
  assert.ok(rules("The code below is read from the repository at build time.").includes("self-narration"));
});

test("the count fragment and its absolute are caught", () => {
  // The clearest tell in the set, and the one no other rule here finds.
  assert.deepEqual(rules("Four moments, in order. None of them is a person."),
    ["count-fragment", "count-fragment"]);
  assert.ok(rules("What a person sees. There are three. A folder on the disk.")
    .includes("count-fragment"));
});

test("a count inside an ordinary sentence is not caught", () => {
  assert.equal(passes("Three tools are run by hand and two files are not programs at all."), true);
});

test("a pile-up is caught by length", () => {
  const long = "Put the software on the machine, create the folders, seed the first assistant, " +
    "and update all of it later without losing anything, which is the part that matters most " +
    "of all when something goes wrong later on.";
  assert.ok(rules(long).includes("sentence-too-long"));
});

test("every finding names what it matched, so it can be acted on", () => {
  const found = check("It is a seamless — experience.");
  assert.ok(found.length >= 2);
  for (const f of found) assert.ok(f.at.length > 0, JSON.stringify(f));
});

test("telling the reader how long to wait is caught", () => {
  // A loading panel once read "Reading the code and writing the explanation. It
  // takes a few seconds." in the slot where the explanation belonged. The reader
  // took it for the answer, and asked what the duration taught them about the
  // code. Nothing.
  for (const t of [
    "Reading the code and writing the explanation. It takes a few seconds.",
    "Please wait while the list is built.",
    "This may take a while.",
    "Almost there.",
  ]) assert.ok(rules(t).includes("waffle"), t);
  assert.equal(passes("It reads the file and returns the text it holds."), true);
});

test("project bookkeeping is caught", () => {
  // 743 of 5,718 comment blocks in one repository carried one of these: 426 a
  // task number, 293 a date. Asking for them to go was not enough.
  for (const t of [
    "Task 1 requires an idempotent re-run.",
    "Measured 2026-08-10, the spawn produced no init event.",
    "See plan 1.3 for why the gate exists.",
    "We found that launchctl refuses a loaded label.",
    "This used to be inline.",
  ]) assert.ok(rules(t).includes("internal-reference"), t);
});

test("the sentence that promotes the one before it is caught", () => {
  // The line that started this rule was in an installer's console output, where
  // a reader had come for a path. The first sentence was true of the machine.
  // The second was the first again with a superlative on it, and the third told
  // them how to organise their work.
  const wound = "claude-admin holds every plugin on this machine, so it can say what each one " +
    "does. That makes it the widest agent here. Use it to make and manage the others.";
  assert.ok(rules(wound).includes("elevation"));
  for (const t of [
    "This is what makes it the one to start from.",
    "Which makes them the only rows worth reading.",
  ]) assert.ok(rules(t).includes("elevation"), t);
});

test("a sentence that happens to use the same words is not caught", () => {
  // "makes" doing ordinary work, and a consequence rather than a promotion.
  assert.equal(passes("The installer makes the folders before it writes anything into them."), true);
  assert.equal(passes("It reads that file, which makes the second read unnecessary."), true);
});

test("a measurement of behaviour is not bookkeeping", () => {
  // The number describes the thing, not the project, so it stays.
  assert.equal(passes("It takes about 14 seconds to stop, so the port is not free at once."), true);
  assert.equal(passes("The package is build-tools and the binary it installs is build."), true);
});

test("a sentence over twenty-five words is caught", () => {
  // Thirty was the cap until ASD-STE100's descriptive number replaced it.
  const s = "It reads the list from disk, resolves each entry against the database, " +
    "writes the result back to the same file, and then reports every row it changed.";
  assert.ok(rules(s).includes("sentence-too-long"));
  assert.equal(passes("It reads the list from disk and writes the result back."), true);
});

test("a paragraph over six sentences is caught", () => {
  const seven = "It reads the file. It resolves each row. It writes the result. " +
    "It reports what changed. It closes the handle. It clears the cache. It exits.";
  const found = check(seven).filter((x) => x.rule === "paragraph-too-long");
  assert.equal(found.length, 1);
  assert.match(found[0].at, /^7 sentences/);
});

test("six sentences pass, and a blank line splits the count", () => {
  const six = "It reads the file. It resolves each row. It writes the result. " +
    "It reports what changed. It closes the handle. It exits.";
  assert.ok(!rules(six).includes("paragraph-too-long"));
  const split = "It reads the file. It resolves each row. It writes the result. It reports what changed.\n\n" +
    "It closes the handle. It clears the cache. It exits. It logs the run.";
  assert.ok(!rules(split).includes("paragraph-too-long"));
});

test("a list, a table and a heading are not paragraphs", () => {
  const list = "- It reads the file.\n- It resolves each row.\n- It writes the result.\n" +
    "- It reports what changed.\n- It closes the handle.\n- It clears the cache.\n- It exits.";
  assert.ok(!rules(list).includes("paragraph-too-long"));
  const table = "| Written | Correct |\n|---|---|\n| a. | b. |\n| c. | d. |\n| e. | f. |\n| g. | h. |\n| i. | j. |";
  assert.ok(!rules(table).includes("paragraph-too-long"));
});

test("two names for one thing in one document are caught", () => {
  const drift = "The folder holds one file per agent. Each directory is created on install. " +
    "A folder is never removed. The directory name is the agent name.";
  const found = check(drift).filter((x) => x.rule === "two-names-one-thing");
  assert.equal(found.length, 1);
  assert.match(found[0].at, /folder\(\d+\), director/);
});

test("one name used throughout passes", () => {
  const steady = "The folder holds one file per agent. Each folder is created on install. " +
    "A folder is never removed. The folder name is the agent name.";
  assert.ok(!rules(steady).includes("two-names-one-thing"));
});

test("a word quoted as the rejected version does not fire the term check", () => {
  // The register's own files name the wrong word on purpose, inside quotation
  // marks. Reading the raw text put four false positives on them; reading the
  // text with quotations removed puts none.
  const quoting = 'The folder holds one file per agent. Each folder is created on install. ' +
    'Rejected here: "the directory is created" and "each directory is named". ' +
    'The folder name is the agent name.';
  assert.ok(!rules(quoting).includes("two-names-one-thing"));
});

test("a single passing mention is not drift", () => {
  const once = "The folder holds one file per agent. Each folder is created on install. " +
    "The folder name is the agent name. On Windows the directory separator differs.";
  assert.ok(!rules(once).includes("two-names-one-thing"));
});

test("a quoted example is not counted as the writer's own sentence", () => {
  // These documents quote the prose they reject. Reading a citation as the
  // writer's own sentence put 33 findings on them that no rewrite could clear.
  const citing = 'Rejected here: "so the record of your world belongs to you rather ' +
    'than to whichever company collected it and filed it away somewhere else entirely".';
  assert.ok(!rules(citing).includes("sentence-too-long"));
  // The writer's own words around a short quote are still counted.
  const own = 'The installer reads the list, resolves each entry against the database, ' +
    'writes "done" to the log, and then reports every single row that it changed today.';
  assert.ok(rules(own).includes("sentence-too-long"));
});

test("a bold lead-in ends the sentence before it", () => {
  // "**Watch for this.** Natural prose alternates a long sentence with a short
  // one." is a heading and a sentence, not a 26-word sentence.
  const bullet = "- **Let the sentences breathe unevenly.** Natural prose alternates a long, " +
    "winding sentence with a short flat one, and now and then a fragment standing alone.";
  assert.ok(!rules(bullet).includes("sentence-too-long"));
});

test("an abbreviation does not end a sentence", () => {
  // "the surrounding doc (e.g. "vol-of-VIX")" was being cut at the "e.g.",
  // which reported half a sentence and hid the length of the other half.
  // 28 words as one sentence. Cut at the "e.g." it becomes 15 and 13, and the
  // length rule sees nothing.
  const t = "Use the symbol parenthetically once for cross-reference to the surrounding " +
    "doc (e.g. a short label), and never back-reference the bare symbol on its own " +
    "at any point thereafter.";
  assert.ok(rules(t).includes("sentence-too-long"));
});

test("the rule-to-example pivot repeated through a document is caught", () => {
  // A tutorial passed every other check here, and a reader still marked 62 of
  // its sentences as machine-written. One shape recurred through all sixteen
  // sections: a general rule, then "Here" standing in for "in this project".
  // These are its own sentences.
  const tutorial = [
    "When you have a decision to make, ask for its requirements.",
    "Here the agent gave six requirements.",
    "The agent reads the existing sprints and shows every field before it saves.",
    "Here it proposed Sprint 13, with five tasks and three blocker questions.",
    "Interview the person who owns the routine.",
    "Here that was the head of operations.",
  ].join("\n\n");
  const found = check(tutorial).filter((x) => x.rule === "here-pivot");
  assert.equal(found.length, 1);
  assert.match(found[0].at, /^3 times/);
});

test("an occasional Here, and the presentational Here it is, pass", () => {
  // Across 215 documents in four repositories, no other document used the
  // pivot three times. The tell is the repetition, not the word.
  const twice = "Ask for the board. Here the agent found no diagram. " +
    "Redraw it after every batch.\n\nHere only Manual mode asked before posting.";
  assert.ok(!rules(twice).includes("here-pivot"));
  const presenting = "Here it is in the code. Here is the list. Here are the rows. Here it is again.";
  assert.ok(!rules(presenting).includes("here-pivot"));
});

test("a sentence explaining how a table is labelled is caught", () => {
  // It sat above a table whose first column already read A to G, beside
  // numbered lessons. The reader could see both. Across 333 documents in five
  // folders, no other sentence had either shape.
  const legend = "The method has seven stages, lettered A to G so they are not confused with the numbered lessons.";
  assert.ok(rules(legend).includes("legend"));
  assert.ok(rules("The steps are numbered 1 to 9.").includes("legend"));
});

test("ordinary uses of numbered and confused pass", () => {
  assert.ok(!rules("Plan tasks are numbered by sprint, and each one has an owner.").includes("legend"));
  assert.ok(!rules("People confused the two names, so the second was dropped.").includes("legend"));
});

test("yes used as a noun is caught", () => {
  for (const t of [
    "Save lesson 3 with your yes",
    "It saves the profile on the person's yes.",
    "It waits for their yes before each upload.",
    "Each step waits for the owner's yes in this session.",
    "It reads them after the person's yes.",
    "It replaces no file without your yes.",
    "It shows the change and saves it on your yes.",
    "One yes covers the import as told.",
    "It uploads them on the person's one yes.",
    "It waits for a yes from the person.",
    "I'll save it when I get a yes from you.",
    "It saves nothing until the yes.",
  ]) assert.ok(rules(t).includes("yes-as-a-noun"), t);
  const [found] = check("Save lesson 3 with your yes").filter((x) => x.rule === "yes-as-a-noun");
  assert.match(found.at, /say approval or approve/);
});

test("Yes as a button and yes as an answer are not caught", () => {
  for (const t of [
    "It asks with Yes and No.",
    "Press Yes to save it.",
    "It offers the best fit, with Yes and Other.",
    'The person types "yes" to go on.',
    "The person answers 'yes' to go on.",
    "Type yes to go on.",
    "Dana, I need 3 yes or no answers at our Monday 1:1.",
    "It asks one yes or no question.",
    "It saves once the person approves.",
    'Never write "your yes" in a question.',
    "Never write ‘your yes’ in a question.",
    "That's yes for me.",
    "The answer's yes, the file is there.",
    "Click on the yes button.",
    "Press it with one yes or one no for each row.",
  ]) assert.ok(!rules(t).includes("yes-as-a-noun"), t);
});
