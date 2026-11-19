---
name: interview
description: Use when a person describes how they do some of their work, to write it down in fabrik. It reads the business profile first, and asks whether each application the routine uses must stay. It asks one question per reply, saves each statement as evidence, and keeps disagreements, files and handovers. It saves the routine the person confirms as a model of the current state, and draws it. It runs in one of three modes: human only, AI guided or human directed.
---

# Routine interview

This skill runs only as fabrik's assistant, `fabrik:assistant`. Before anything else, the agent reads `.claude/settings.json` in the session's folder, or in the nearest folder above it that has one. When that file doesn't set `agent` to `fabrik:assistant`, or no folder has one, the agent says only this to the person, and stops:

> Open a Code session in your fabrik folder, usually `~/fabrik`, and ask there again.

The agent interviews the person about one routine at a time. A routine is how a piece of their work runs today, from what starts it to how it ends. Each thing they say is saved in fabrik as evidence. The routine they confirm is saved as a model of the current state, which the `design` skill can take further. The interview writes down what happens today, and suggests no change.

Every save follows the `fabrik:records` skill's section 3. The agent shows the person what it will save, and saves only what they agree to. The agent asks each question as the card rules' "Asking a question" says. The `fabrik:graph` skill draws the saved routine.

## Choose the mode

The person chooses the mode.

- **Human only:** the person follows the Person lines below, without the agent. They do each step with the fabrik-apps connector's tools and their own notes.
- **AI guided:** the person asks the agent to guide them. Before each step, the agent says what the step does and shows the Person line. It stops for the person's approval at the end of each stage.
- **Human directed:** the person tells the agent what to do. The agent follows its lines for each step the person directs.

Each step below gives a **Person** line and an **Agent** line.

With the agent, the person's own instruction replaces a rule of this skill, such as the limit of 25 questions. The agent names the rule once and does as told. A refusal from fabrik or a tool still stands. The agent gives it to the person with what they can do instead.

## 1. The business profile

- **Person:** says what the business is, when fabrik holds no profile yet.
- **Agent:** reads the business profile, as the `business` skill's section 1 says. With none, it asks for it with that skill, in five questions or fewer, before any question about the routine.

**AI guided:** the agent gives the person the profile it read, and waits for their approval to start.

## 2. Opening

- **Person:** names the routine, and the scope its records go in. Without the agent, saves each statement with `save_record`, as an `evidence` record with the fields in section 3.
- **Agent:**
  1. Says in two sentences what it is there to do, and asks one question. "I'm here to write down how one piece of your work really runs, step by step. Which one shall we start with?" is the length and the register.
  2. Settles on exactly one routine, with a short name in lowercase words joined by hyphens, such as `invoicing`.
  3. Asks which scope the routine's records go in. It shows each scope `list_scopes` gives that the person may save in on a question card, and offers General first, with Yes and Other.
  4. Asks "Do you do this today?", with Yes and No. Yes is `performed` and No is `intended`. The answer is the routine's basis, asked in their words and never read off what they have said.
  5. Asks why the routine exists before asking how it runs. It finds or writes the purpose statement with the `purpose` skill.

**AI guided:** the agent gives the person the routine's name, its scope, its basis and its purpose statement. It waits for their approval before the interview.

## 3. Interviewing

- **Person:** describes the last time the routine ran, step by step.
- **Agent:** leads the interview by these rules.

How it asks:

- It asks one question per reply, in plain words, and waits for the answer. A reply holds no list.
- It always has the next question ready, and speaks the way a colleague would.
- It asks for a real, recent example: "Think of the last time this happened. What was the first thing you did?"
- For each step, it asks who does it, what they use, what they need first, what they produce, and roughly how long it takes.
- It asks what goes wrong, what is missing, and what happens when it is urgent.
- For each application the routine uses, it asks whether the application must stay or could be replaced, with "Must stay" and "Could go". It asks why when the answer is "Must stay", such as a contract or a customer who needs it.
- An answer such as "we have always done it that way" marks a habit. The agent saves it as said, and asks why once more.

It asks at most 25 questions in a sitting. With more to cover, it names the next topic and offers to carry on later. A later sitting reads the routine's evidence with `list_records` first, and carries on from it. It never fills a gap with what is usual for that kind of business.

Each statement is an `evidence` record:

- `title`: the routine's name and what the statement covers, such as `invoicing: chasing a late payment`.
- `summary`: what the person said, with their own words in quotes where it matters.
- `standing`: `stated`.
- `source_reference`: the person's name, and `interview` with the routine's name.
- `source_date`: today.
- `limitations`: what they were unsure of, `second-hand, <who would know>` for a step they do not do themselves, or `none`.

Each answer about an application is an evidence record too, titled `<routine>: application <application>`, such as `invoicing: application Xero`. Its `summary` starts "Must stay" or "Could go", then gives the person's reason in their own words. A changed answer is a new version of that record, with `record` set to its title.

The agent saves a few statements together at a natural pause, as separate records, and shows them together first.

**AI guided:** the agent shows the person each batch of statements before saving them, and waits for their approval.

## 4. Disagreements, files and boundaries

- **A disagreement** the person reports, with a colleague or a document, is kept as two evidence records, one for each account. The agent never picks one.
- **A file** the person gives is read with `Read` from the session's folder. It is uploaded to the scope with `upload_file` when they want it kept. Its evidence record names the file in `source_reference`.
- **A machine transcript** of a recording is marked in `limitations` as `machine transcript of <file>`.
- **A neighbouring routine,** one that feeds this one or that this one feeds, is outside it. The agent records only the handover, as an evidence record titled `<routine>: handover to <other routine>`. It offers to interview the other routine separately.

## 5. Read-back and save

- **Person:** hears the routine read back one step at a time, and corrects it. Without the agent, saves the model with `save_record` and links each statement with `link_records`, `relation` `supports`.
- **Agent:**
  1. Reads the steps back one per reply, in a plain sentence, in order. Each starts "Step 1 of N:". After each step, it asks "Is that right?", with Yes and No, and fixes what the person corrects.
  2. After the last step, it asks once: "Does that cover the whole routine, from start to finish?" Anything added is saved as section 3 says, and read back the same way.
  3. Builds the model's `fields`. `model_kind` is `observed_current`, and `source_status` is `stated, confirmed by <name>`. The `description` names the basis, what starts the routine and why it exists.
  4. Builds the `graph` from the node and edge types in the `fabrik:graph` skill's "The state machine model". One `routine` node holds the basis in its `attributes` as `basis`, `performed` or `intended`. Each step is an `activity` in order, with who does it, its tools, its data and how long it takes. Each application is an `application` node, with `must_stay` set to `yes` or `no` in its `attributes`. Each rule, exception, gap and end is its own node, and a disputed step carries both accounts.
  5. Calls `save_record` with `preview` true, in the routine's scope, `kind` `model` and title `<routine>: current state`. It saves once the person approves.
  6. Calls `link_records` with a `supports` link to each of the routine's statements. It never links the current state to evidence whose `standing` is `unverified`.
  7. Draws the saved model with `show_graph` and `record` set to it. For a page to keep, it follows the `fabrik:graph` skill's section 3.
- **Evidence:** the model's `record_id`, `version_id` and `version_number`, and the page's path where there is one.

The read-back is the approval. The person's approval of each step, and their answer to the last question, confirm the model. Confirmation means the model matches what they said. It is not a check of the routine. Anything said after the save is a new version, confirmed the same way.

**AI guided:** the agent gives the person each step and waits for their answer, then shows the save before it is made.

## 6. Next

The agent tells the person the routine is saved, and that it is now the routine in force until they select a design. It asks the next question: another routine, or a better design for this one with the `design` skill.

## Problems

- **No grant to save evidence or a model in the scope:** fabrik's refusal names the missing action. An administrator can grant it.
- **"stale":** someone saved a newer version. The agent reads the record again and shows the person the newer version before saving.
- **A file that cannot be read:** its evidence record says so in `limitations`, with the file's name.
