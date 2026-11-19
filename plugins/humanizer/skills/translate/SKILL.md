---
name: translate
description: >
  How to write anything a person will read: replies, documents, generated pages,
  code comments. Strips the markers that make writing read as machine-written,
  and caps the length by what was asked for. Use before writing any prose a
  person will read. Use it whenever the user asks for plain English, a
  definition, a summary or a recap, asks to humanize a draft or run the
  humanizer over it, or says something reads as AI slop.
---

# translate

Two rules, and the second is the one that holds.

**Write plainly.** Short sentences, common words, one idea each, the thing as the
subject. Say what it is, what it does, and what follows in practice.

**Check what can be checked, and only that.** Written rules do not hold on their
own. Measured over one session: seven rules were broken by the
agent that had just written them, minutes earlier, in the same file. Every one
was caught later by a check that ran, and none by rereading.

But a check decides form, not meaning, and the two must not be confused. See
below.

## What a check can decide

**A check can decide form.** A character, a count, a closed list of words, a
syntactic shape. These are exact, and they belong in
[`references/checks.mjs`](references/checks.mjs), copyable into any validator:

- an em-dash, which is one character
- a sentence over twenty-five words, which is a count
- a paragraph over six sentences, which is also a count
- the inflation words, which are a closed list and always wrong
- a bare count standing as a sentence, which is a shape
- the self-narration phrases, which are distinctive enough to enumerate
- two names for one thing in one document, which is a closed list per project
- the rule-to-example pivot used three times in one document, which is a count
- "yes" as a noun, as in "your yes" or "on the person's yes", which is a closed list of the words before it. Say approval or approve instead. Yes as a button's name, a quoted "yes", "type yes", "yes or no", "the yes button" and "That's yes" pass

An HTML page goes through `checkPage(html, { form })` instead. It runs the
rules above on the text a reader sees, not on the markup, and adds four limits
counted from the markup:

- at most one table on a page
- at most ten words in a table cell
- at most four sections, each headed by an `<h2>`, unless `form` is `"guide"` or `"slides"`
- at most five items in a list

Two page limits depend on layout and are not checked: 50 to 120 words on the
first screen, and two lines to a paragraph. Both need the page rendered.

**A check cannot decide meaning**, and trying makes it worse than useless.
Measured here: a pattern for anthropomorphism was written to catch "the system
talks to" and "the part that watches". Its first run against 282 real files
returned sixteen findings. Ten of them were the word **live** as an adjective:
live install, live session, live database, live location, live registration.
A 63% false positive rate, on the first run, on the text it was written for.

The same happened to a pattern for the passive voice, and worse. It returned 507
findings across ten of these documents, and not one of them was a violation.
That attempt is recorded under rule 15.

A check that cries wolf is removed within a week, and then nothing is checked at
all. So a rule about meaning stays a rule, stated with its substitution table
and its examples, and is applied by whoever writes the prose. That is rules 2,
3, 4, 5, 6, 15 and most of 17 below. They are not weaker for being unchecked; they are simply
not the kind of thing a pattern can decide.

## Scope

Every word returned to a human reader:

- a reply in the terminal
- a document
- a generated page
- a heading in a template
- a comment in source

Not arguments passed to a tool. Those are machine payloads, where structured
tokens are required.

## The rules

### 1. Lead with the answer

The first sentence is the answer, never the proof. Paths, hashes, timestamps and
log excerpts sit underneath and are given when asked. No "likely", no "appears
to", no "this looks like". An evidence-first reply reads as more verbose and
less precise, not less.

### 2. Precision

Say what is true, not the most familiar instance of it. Narrowing a true
statement to its common case is a factual error, and it is invisible because the
common case is what a reader expects.

"A chat app on a phone" was wrong: the same client runs on a desktop too, and
the route works from either. It became "by sending it a message", which is both
shorter and true.

**Do not bake a current limit into general vocabulary.** Naming the machine
"the Mac" throughout is precise today and wrong the day a second operating
system ships, at which point every sentence needs editing. Use the durable word,
"the computer", and state the limit once where it belongs: the installer runs on
macOS only today.

The same test catches an over-general claim. Say the number if the number is
known. Name the thing if the thing has a name. Where a statement holds only
under a condition, state the condition rather than dropping it.

### 3. Look the term up before defining it

**Every term of art used as a heading or a definition is looked up first**, in
Wikipedia or Merriam-Webster. The standard definition is what the sentence opens
with. Not a paraphrase of it, and not an impression of it.

This exists because of a specific and repeated failure. The standard definition
of user interface is "the part of a device, application, or website through
which a person interacts with it". What got written was "What a person sees and
touches". The paraphrase feels vivid, carries less, and reads as affected,
because it reached past a definition that was already exact.

The scope is small enough to be real. A document has a handful of headings and a
handful of definitions, not hundreds. Look those up. Ordinary sentences need no
lookup.

**A heading names the thing. It does not describe it.** The description belongs
in the body, where there is room. Rejected here, four headings in one list:
"Once, at install" / "Every time the computer starts" / "Every hour, while it
runs" / "Every time a session starts". Each stated a moment and never
said what the thing was. They became "Installer", "Server", "Agent reconciler",
"Agent tool configuration", with the timing kept underneath as a label.

**The same applies to a caption under a name.** It says what the thing is and
what it does. When it runs, how often, and from where are circumstance, and they
come after, if at all. Rejected here, on the nodes of a diagram: "Runs once,
from a terminal" / "Runs all the time" / "One folder per agent" / "One small
program per tool". Each stated a circumstance beside a name and left the reader
knowing neither what the thing was nor why it was there.

"Runs once, from a terminal" became "Installs the software, creates the folders
and the first agent, and sets up the database. Run once, from a terminal." The
circumstance survives, at the end, after the answer.

The test: can the heading and its caption be read on their own, out of the list?
Do they still say what the thing is and what it does?

Two consequences worth taking:

- **A coined term is a flag.** If the lookup returns nothing, the term is an
  invention, and inventing one is a decision somebody should make deliberately
  rather than find in a heading. Measured here: "Supervision" was coined for a
  part whose standard name is "cross-cutting concerns". That term's own examples
  are logging, monitoring and security, which is exactly what the part holds.
- **Use the standard word even when it is longer.** Shortness is not worth
  precision, and a reader who knows the field loses the anchor.

*Not checked. Whether a sentence is a definition, and whether it paraphrases
one, is a question about meaning.*

### 4. Systems have no senses and no intentions

A precise technical verb exists for almost everything software does. Reaching
past it for a human one is the same failure as rule 3, one step along: the
sentence gains a picture and loses accuracy.

| Written | Correct |
|---|---|
| talks to, speaks to | communicates with, calls, integrates with, exchanges data with |
| sees, watches, looks at | monitors, observes, reads, records |
| knows, understands, thinks | determines, resolves, holds, is configured with |
| remembers, forgets | stores, retains, discards |
| wants, hopes, tries to | attempts, is configured to |
| lives, sits, stands, wanders | runs, is located in, is stored in |
| hands it to, gives it to | passes it to, provides it to |
| wakes up, sleeps | starts, idles |

Rejected here: "the external systems it talks to, and the supervision that
watches all of it" became "the external systems it integrates with, and the
supervision that monitors it".

**Some verbs that sound human are the standard technical term, and those stay.**
A server *listens* on a port. A process *sleeps*. A lock is *held*. A parser
*reads*.

The test is not whether a word could describe a person, it is whether the field
already uses it. That is rule 3 again: look it up.

*Not checked, and the attempt is recorded above. Deciding that "live install"
is an adjective and "the part that lives here" is a verb needs a reader.*

### 5. Name the trigger, the action, and the result

A description of what something does has three parts, and leaving any of them
out is what produces an impression instead of a statement.

- **The trigger.** What causes it to happen, named.
- **The action.** What it actually does, in verbs.
- **The result.** What is different afterwards, and where that shows.

Rejected here: "It is the whole install, in one file, run from one command."
Three fragments arranged for rhythm, with no verb doing any work. A reader who
finishes it knows nothing they did not know from the file's name.

The operator's rewrite, which is the model: "When the installation is run with
{command}, it installs the entire application, logging the results to the
Terminal." Trigger, action, result, in that order.

**Watch for the three-fragment sentence.** "The whole install, in one file, run
from one command." "Small, fast, and local." "One job, one agent, one bot." The
cadence rises and nothing is asserted. Three comma-separated fragments with no
main verb between them is a cadence, not a claim.

### 6. Nothing explains itself

No telling the reader what they are looking at. No vouching for how the thing
was produced. No restating in a sentence a number already on the page. No
explaining a legend. No signing the work. No apologising for scope.

Rejected examples: "Read from the repository at 09:41. Every line of code below
is the file itself." / "The map is complete, the commentary is not." / "The tree
is read from disk and the links from the import statements, so neither can
disagree with the code." / "The method has seven stages, lettered A to G so
they are not confused with the numbered lessons." That last one sat above a
table whose first column read A to G. The count and the labelling were both
on the page already.

What replaces them is nothing.

*Checked. The labelling legend is a shape: "lettered A to G", "numbered 1 to
9", "so they are not confused with". Across 333 documents only the sentence
above had it.*

### 7. No pitch

No benefit, no use case, no reason the design is good. What it is, what it does,
what follows in practice.

Rejected: "This is the whole product for someone who never wants a bot" / "so
every write is checked in one place" / "This is the only way the tool list is
really enforced". The last became a fact by dropping "only" and the emphasis:
"The tool list is enforced here. In the folder it is not."

**A pitch is a reason the design is good. A reason the reader needs is not a
pitch.** "Give the name and description in the same request, or the agent will
have to invent them" tells a reader what goes wrong if they skip a step. It
stays. Rule 17 covers what happens when this rule is applied to those reasons
too.

### 8. No flourish

Strip the sentence that has finished saying something and then says it again
with feeling. It arrives at the end and it usually contrasts.

Rejected: "so the record of your world belongs to you rather than to whichever
company collected it" / "each agent stays at its job instead of wandering off
into work you never asked it to do" / "which is what puts it on your phone".
Each should have been a full stop earlier.

**The aphorism is the other costume, and it is the harder one to see.** The
closing reframe restates the point with feeling. The aphorism leaves the subject
entirely and states a general truth, which reads as insight and carries no fact
about the thing being described.

Rejected here: "A silent skip is the failure that looks like success", tacked on
the end of a paragraph that had already said the installer prints its skips.
"A token in a log is a token in every copy of that log", where the field was
supposed to say what goes wrong in this file. "The project closes. The requests
go on for years.", after a sentence that had already said the everyday requests
and the project belong in different scopes. Two short sentences in a row, with
nothing new in either, is the same move dressed as rhythm.

**The contrastive tail is the third costume.** "X rather than Y", where Y is not
a real alternative behaviour but a judgement about the world. Rejected here: "A
missing one stops the run rather than producing a warning nobody reads." The
first half is the fact. The second half is an opinion about warnings in general,
and the reader learns nothing about this code from it.

**The participial tag on a title is the fourth costume.** A name, a comma, and a
past participle: "Ledger, read end to end", "The pipeline, explained". The tag
adds nothing the name did not already carry, and nothing a reader would not have
assumed from opening the document. It is a title that describes the act of
writing rather than the subject, which is rule 6 wearing a bow tie.

The title is the name of the thing. "Ledger" is a title. "Ledger, read end to
end" is a title with an apology attached. Where the document genuinely covers a
narrower subject, name the subject: "The Ledger install layout".

*Checked. The shape is a noun phrase, a comma and a participle from a closed
list, with no finite verb. That is a form rather than a meaning.*

**A contrastive is a fact when both halves are concrete behaviours of this
code**. These all stayed: "an empty list rather than leaving the file out",
"marks a record deleted instead of removing it", "reloaded rather than
restarted", "updates the existing record rather than adding a second". Each
names a thing the code could have done and does not.

Thirteen contrastive tails were audited in one document. Ten were facts. Three
were editorial. The word is not the tell; what sits after it is.

**The test is whether the sentence names the thing.** A sentence whose subject
is not the subject of the passage is not a description of it. "The token would
be readable in the log file, in every backup of that file, and in anything the
log was pasted into" says the same thing about this code and is checkable
against it.

Also out: the inflation words (leverage, unlock, seamless, robust, myriad,
pivotal, journey, landscape of, delve, elevate, testament to). The antithesis
goes with them: "it is not X, it is Y" used as a move rather than a correction.

*Partly checked: the vocabulary and the antithesis are refused. The closing
reframe cannot be, because it is built from ordinary English that honest
sentences need. Read the last clause of every paragraph and ask what a reader
loses if it goes. When the answer is nothing, delete it.*

### 9. No count fragment

A bare count standing as its own sentence, and the absolute that follows it.
"Four moments, in order. None of them is a person." Neither half carries
information, and together they are the clearest tell in the set.

Also: "There are three." as a whole sentence, and any sentence opening "None of
them", "All of them", "Both of them".

*Checked.*

### 10. One idea per sentence

Every sentence has a subject. The shape to avoid is the pile-up: a subject, four
clauses hanging off it, then a final clause referring back two lines.

Rejected: "Put the software on the machine, create the folders, seed the first
assistant, and update all of it later without losing anything. Runs before
either of the other two exist and is the only part that writes the layout they
both depend on."

Became: "It puts the software on the Mac, makes the folders, and creates the
first agent. Run again later it updates everything. It does not delete what is
already there."

*Checked: refused over twenty-five words, which is generous. Most sentences
should be well under half of it. Twenty-five is the cap ASD-STE100 sets for
descriptive writing, and it replaces thirty here.*

*A quoted span counts as one word. A document that quotes the prose it rejects
did not write that prose. Counting citations against the writer put 33 findings
on these three files, and no rewrite could clear them.*

### 11. No em-dashes

A comma, a colon, or two sentences. No exception.

*Checked.*

### 12. The recursive rule

A plain explanation cannot itself contain terms that need explaining. That rules
out acronyms, function names, type names, formulas, and any jargon with an
ordinary English substitute. Where a term is unavoidable, define it in the same
sentence in the words someone would use out loud.

Read it aloud. If it does not parse in conversation, without a whiteboard, it
fails. A compound survives only if its meaning is the sum of its parts:
"probability distribution" survives, "characteristic function" does not.

### 13. No elevation beat

A fact, then a sentence turning the fact into significance, then an instruction
nobody asked for. The middle sentence is the tell. It opens "That makes it",
"Which means", "This is what makes", and it carries no fact of its own. The
instruction after it is the reason it was written.

Rejected: "claude-admin holds every plugin on this machine, so it can say what
each one does when it designs an agent. That makes it the widest agent here. Use
it to make and manage the others, and give the work to an agent made for it."

The first sentence is checkable against the machine. The second is the first
again with a superlative on it. The third tells someone who came for a path how
to organise their work.

What replaces the second and third is nothing.

*Partly checked: the openers are a closed list. Whether the sentence after them
is an instruction has to be read.*

### 14. Six sentences to a paragraph

A paragraph longer than six sentences is doing the work of two. Split it where
the subject changes.

This is rule 10 one level up. A sentence pile-up hangs four clauses off one
subject. A paragraph pile-up puts four subjects under one opening line, and the
reader loses the thread in the same way.

Measured here: 944 paragraphs across these documents, four over the cap. Each of
the four held two subjects and split cleanly.

*Checked. Headings, list items, table rows and fenced code are not paragraphs,
and are skipped.*

### 15. Name the actor, or have no actor

Where something acts, it is the subject of the sentence. "The installer writes
the file", not "The file is written by the installer". A description that never
names what acts leaves a reader unable to say what to fix.

**The passive is correct when it holds the topic in the subject position**, and
most of the time here it does. "What an agent can do is decided by its tool
list" opens on the subject of the passage. Turning it around promotes the tool
list and buries the topic.

*Not checked, and the attempt is recorded. A pattern for the passive returned
507 findings across ten of these documents. Twenty-six named an actor, and
reading all twenty-six found no violation. The other 481 were agentless forms
like "is stored in" and "is loaded once at session start", which is the
vocabulary rule 4 prescribes. The check would have refused that table.*

### 16. One name per thing, for the length of the document

Rule 3 finds the standard term. This rule keeps it. Two names for one thing send
a reader looking for a distinction that is not there.

Measured here: README.md says folder twenty-one times and directory twenty-eight
times. AUDIT.md says agent 219 times and assistant 21 times. Neither document
draws a distinction anywhere.

The sets are declared in [`references/checks.mjs`](references/checks.mjs), and
they belong to the project rather than to the rule. Add one whenever a document
is found using two words for the same thing:

- agent, assistant, bot, worker
- folder, directory
- machine, computer, box
- repo, repository
- config, configuration
- start, launch, boot

*Checked, with quoted text removed first. A document that quotes prose it
rejects names the wrong word on purpose. Stripping quotations took the false
positives on these files from four to none.*

The full catalogue of tells, and six worked examples, are in
[`references/tells.md`](references/tells.md).

### 17. Do not compress past the reader

The rules above all cut. Applied without this one, they cut a document down to a
rulebook, and a rulebook reads as machine-written too. A human tutor
over-explains. This failure under-explains.

Measured here: a sixteen-section tutorial for a non-technical reader passed every
check in this file with two findings. A reader then marked 62 of its sentences as
machine-written. None had an em-dash, an inflation word or a long sentence.
Every one had been compressed until it no longer said who does what, or why.

The test is whether the reader, out loud, could answer three questions from the
sentence alone. Who does it? In what situation? What goes wrong if they do not?
Where the sentence cannot answer them, put back the words that do.

There are six costumes.

**The maxim.** Advice stated as a proverb, with no actor, no situation and no
consequence. It reads as wisdom and gives the reader nothing to do.

| Written | Correct |
|---|---|
| Mark work done when it is done. | As tasks finish, tell the agent so it can mark them complete. |
| An item the project cannot finish belongs outside it. | If a task cannot be finished within the project, take it out of the plan and name who will watch it. |
| Correct the dates as soon as you see them. | When the board appears, check the dates straight away. The first guess is often wrong. |
| Test any connector before you design around it. | Before you design around a connector, test that it works. |

A maxim is not always wrong. The tell is a run of them, one per paragraph, each
opening the paragraph as though it were a heading.

**The telegraphic line.** Articles, connectives and the second half of a
construction dropped, until the sentence no longer parses aloud. This is rule 10
overshot: one idea per sentence, with the idea missing its joints.

| Written | Correct |
|---|---|
| Describe the problem as it costs the business. | Describe the problem in terms of what it is costing the business. |
| Check the build is possible against your own source documents. | Make sure the solution can be built. Check it against the documents you loaded. |
| Work out what the project costs and what it has to save. | Work out what the project will cost in your time, and how much it has to save to pay for itself. |
| Give the agent the effort, the calendar and what each date means. | Tell the agent how much work there is, which days you have to do it in, and what has to happen on particular days. |
| Then check the dates follow the links. | Then check that no task is due to finish before the tasks it waits on. |
| It asks why, one question at a time, each about the answer before. | It asks why, one question at a time. Each question is about the answer you just gave. |
| It loses out to getting the stock there. | It gets dropped in favour of getting the stock delivered. |
| The second option, limited to their own records. | Read, create and edit, but only their own records. |
| It also carried four rules from the supplier's guide. | It also had to follow four rules from the supplier's guide. |
| The records system marks it that way. | The records system records it as stated, not observed. |
| Reissue the report from a fresh read. | Reissue the report from the latest records. |
| The requirements of the outside party. | What the other company requires. |
| For thin evidence or untested consequences. | Wherever the evidence is thin or the consequences are untested. |

Test a suspect line by saying it to a colleague across a desk. If you would
add words to make it land, add them on the page.

**The rule-to-example pivot.** A general rule, then "Here" standing in for "in
this project", then the example. "Interview the person who owns the routine.
Here that was the head of operations." Once is ordinary. The tutorial above did it eight
times, and the reader heard a template being filled in.

Say whose case it was: "In this project that was the head of operations", "For the project
owner, the agent proposed Sprint 13". Better still, put the example first and let the rule
follow from it.

**The abstract actor.** Rule 4 refuses human verbs for software. The same
failure happens with documents, meetings and permissions, and it is easier to
miss because the verb is not obviously human.

"The interview saves each
statement as evidence." An interview saves nothing; the agent does, while the
interview runs. "Unplanned stock, which no routine sees unless someone logs it."
A routine sees nothing; nobody can catch it unless someone records it. Name the
person or program that acts, as rule 15 asks.

**The orphan reference.** A sentence or a prompt points at something the reader
cannot see. It might be a record number, a draft they never read, or a choice
made off the page. The writer knows what it refers to, so it reads as complete to
them and as a riddle to everyone else.

| Written | Correct |
|---|---|
| Deliverable 1.5b should not be part of the project. | The deliverable for the first invoice after go-live cannot be finished within the project, because that invoice arrives after it ends. |
| Warn only, then save and draw it. | Make the five-working-day notice check a warning, not a block. Then save and draw it. |
| Operations should not be the first check. (answering a draft the reader never saw) | Name the draft's rule first: "The first draft made operations the first check on every request." Then give the correction. |

A word the document uses for two things is the same failure. "A model's answer
never grants permission to act" sat in a tutorial where a model was also a saved
process diagram. It became "An AI's answer is never permission to act on its
own."

Read each prompt and each correction as someone who has seen nothing but the
page. Name the thing a number stands for, and state what is being corrected
before the correction.

**The process confession.** Narration of what went wrong while the thing was
being made, left in a text for someone who will never meet that problem. "The
interview stopped one step short, and step 4 shows the result." "The drawing
tool makes no picture. Take a screenshot." A reader of the finished document
needs the method as it works now. Describe the tools as they are at the end.

A past mistake stays only when it is the reader's mistake to avoid, and then it
is written as advice to them. "The owner first asked only for asn, and the agent
made up the name" becomes "Give all three in one request, or the agent will have to
invent them."

**Record where the work ended, not where it started.** A task begun in one place
and moved to where it belonged is a confession when the text keeps its first
home. A tutorial told the reader to "add the two new master data requirements to
the other project as in progress", then explained why they belonged there. A
later decision had moved them into the project that needed them. The finished
text names only the final home, and the other project drops out of the document.

**Provenance is a confession too.** A sentence about where the document's own
material came from is still about how the thing was made. "They are tidied
versions of the prompts the owner typed when the project was run." "The figures
had not been taken when this tutorial was written."

Rule 6 already refuses
vouching for how a thing was produced. This is the same failure, and it is easy
to keep because it sounds like useful context. Delete it, or state only what
the reader does with the material: "Copy them and change the details."

**Sweep for it by name.** Every confession found in one tutorial named a person
from the project. After each edit, search the whole document for those names
and read every sentence that has one. Ask whether it describes the method, or
the story of how this particular project or document was produced. Keep the
first and rewrite the second as advice or a fact.

A rewrite carries its source's
leakage over in new words unless each sentence is judged, not paraphrased.

*Partly checked. The rule-to-example pivot is a count: three uses of "Here" plus
a subject in one document fires. Across 215 documents in four repositories, only
the tutorial above reached three. The maxim, the telegraphic line, the orphan
reference, the abstract actor and the confession are questions about meaning and
are caught by reading.
Read each paragraph's first sentence on its own and ask the three questions.*

## Size

The rules never change. The size does, and it comes from what was asked for.

| Asked for | Ceiling |
|---|---|
| A recap of what was just said | Three sentences |
| "What is this thing?" | Three sentences: what it is, why it exists, what follows |
| A definition of one concept | Two to four sentences |
| An explanation, a document, a page | As long as the content needs, and no longer |

Three sentences is a ceiling, not a target. Two is fine. One is fine.

**A recap** restates the agent's own last turn, so a reader who skipped it ends
up with the same understanding. It introduces nothing that was not in the turn.
When the turn concluded an investigation it carries exactly two things, in this
order. First the diagnosis, naming the cause rather than where the symptom
surfaced. Then the proposed resolution. If the investigation reached no
resolution, say so
in that slot rather than inventing one.

**"What is this thing?"** is answered after opening the file, never from the
name. One sentence on what it is, one on why it exists, and one on what breaks
without it if that is worth naming. Prose only, no lists, no headings.

## Comments in code

The same register governs a comment, and every rule above applies to it.

A comment earns its place only by carrying what the code cannot say itself.

Worth writing:

- why an unusual approach was chosen
- an assumption the code rests on
- a warning about a consequence someone would trip over
- how an edge case is handled
- a link to the specification or issue that forced the shape
- a marker on unfinished work
- the inputs, outputs, errors and side effects of anything other code calls

Not worth writing:

- a restatement of the line below it
- anything out of date
- a design record that belongs in a document
- commented-out code
- an opinion
- an explanation propping up a name that could be better

Never worth writing: an internal reference. A task number, a plan or ticket
number, a requirements document, an issue number. A date something was measured
or changed, or the story of what somebody found out and when. It stops nobody
making a mistake and means nothing outside the tracker it came from. The line is
whether the number describes the code or the project: "takes about 14 seconds to
stop" describes the code and stays, "measured on 2026-08-14" describes the
project and goes.

Before writing one, ask what a future reader would misunderstand without it. If
the answer is nothing beyond what the code already shows, do not write it. Fix
the name or the structure first. A comment longer than the code it explains is a
design record in the wrong file.

## Never end on an offer

No "want me to…", no "let me know if…", no "hope this helps". End on the last
thing worth saying.

## What this replaces

`plainly`, `whatis`, `summarise`, and rules 1 and 2 of `doctrine`.

`doctrine` keeps rule 3, observability, and its hook. `violation` keeps the halt
procedure. `karpathy` and `writer-craft` are untouched: one is about code
behaviour and the other is a different craft.
