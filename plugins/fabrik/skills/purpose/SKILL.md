---
name: purpose
description: Use before a routine is designed or changed, or when a person asks why one exists. It finds why with five whys, and writes the purpose statement: the person, the real problem and the measure of success. It saves each answer as evidence and the statement as a decision, linked to the objective it serves. It holds each requirement against it. It runs in one of three modes: human only, AI guided or human directed.
---

# Purpose statement

This skill runs only as fabrik's assistant, `fabrik:assistant`. Before anything else, the agent reads `.claude/settings.json` in the session's folder, or in the nearest folder above it that has one. When that file doesn't set `agent` to `fabrik:assistant`, or no folder has one, the agent says only this to the person, and stops:

> Open a Code session in your fabrik folder, usually `~/fabrik`, and ask there again.

A request arrives as what to build and how. The agent asks why first. Each answer is a fact about the problem. The real problem is usually simpler than the list of requirements around it, and it is often about someone's working day.

The **purpose statement** is one short paragraph that says why a routine exists and for whom. Every design starts from one. Each requirement and each design choice is held against it.

Every save follows the `fabrik:records` skill's section 3. The agent shows the person what it will save, and saves only what they agree to. The agent asks each question as the card rules' "Asking a question" says.

## Choose the mode

The person chooses the mode.

- **Human only:** the person follows the Person lines below, without the agent. They do each step with the fabrik-apps connector's tools and their own notes.
- **AI guided:** the person asks the agent to guide them. Before each step, the agent says what the step does and shows the Person line. It stops for the person's approval at the end of each stage.
- **Human directed:** the person tells the agent what to do. The agent follows its lines for each step the person directs.

Each step below gives a **Person** line and an **Agent** line.

With the agent, the person's own instruction replaces a rule of this skill, such as the number of whys. The agent names the rule once and does as told. A refusal from fabrik or a tool still stands. The agent gives it to the person with what they can do instead.

## 1. Find the statement

- **Person:** names the routine. `list_records` with `kind` `decision` and `title` set to the routine's name and `purpose` finds its statement. `get_record` reads it.
- **Agent:**
  1. Calls `list_records` with `kind` `decision` and `title` `<routine> purpose`, and keeps the record titled exactly `<routine>: purpose`. Other routines whose names hold the same words are left out.
  2. Reads the latest version of each match with `get_record`, and shows the person its statement.
  3. When the person says it still holds, uses it. When they say it has changed, revises it as section 5 says.
  4. With no statement, asks the five whys in section 2.

**AI guided:** the agent gives the person the statement it found, or says there is none. It waits for their approval to use it, or to ask the whys.

## 2. The five whys

- **Person:** answers each why, from what they have seen or know. Without the agent, writes the request at the top and the chain of whys below it. Saves each answer with `save_record`, as an `evidence` record with the fields below.
- **Agent:** writes the request at the top, as the person said it. Then it asks why, one question per reply, each about the answer before, by these rules:

- Ask why the problem happens, or why the routine is needed. Each answer rests on what the person has seen or knows.
- Take the answer and ask why again, five times or as many as it takes.
- Stop at an answer that cannot be reduced further. That answer is the real problem, and everything above it is a proposed solution.
- An answer that loops back, or "because that is how we have always done it", is a habit. Keep asking.
- Look for a person and a moment: who is slowed down, put at risk or left without help, and when.
- Ask the way a curious colleague would, to understand the problem well enough to serve it.

Each answer is an `evidence` record:

- `title`: the routine and the question, such as `invoicing: why 2`.
- `summary`: the question and the answer, in the person's own words where it matters.
- `standing`: `stated`.
- `source_reference`: the person's name, and `five whys` with the routine's name.
- `source_date`: today.
- `limitations`: what they were unsure of, or `none`.

The agent saves the chain at a natural pause, as separate records, and shows them together first.

**AI guided:** the agent gives the person the chain of whys and the real problem at its end. It waits for their approval before saving.

## 3. Write the statement

The statement has three parts:

- **The person.** A real person or role, named closely enough to describe their working day.
- **The problem.** The one at the bottom of the whys: what is hard, slow or risky for that person today.
- **The measure of success.** A moment that shows the routine has done its job, and what the person does then that is better than today.

- **Person:** answers the three questions below, and agrees the wording. Without the agent, writes the draft and holds it against the same questions.
- **Agent:** writes a quick draft and reads it back. It asks whether the person is specific enough to describe their working day. It asks whether the problem is real enough to see it happening. It asks whether the measure of success is concrete enough to recognise on sight.

It revises the draft until the person answers yes to all three. The statement reads in thirty seconds, in plain words. A statement that fits any business in the same line of work is too broad.

**AI guided:** the agent gives the person the draft that passes the three questions, and waits for their approval.

## 4. Save the statement

- **Person:** agrees the statement's wording, and names the objective the routine serves. Without the agent, saves it with `save_record`, as a `decision` record with the fields below. Links each why with `link_records`, `relation` `supports`, and the objective too when the routine is in General.
- **Agent:**
  1. Builds a `decision` record in the routine's scope, titled `<routine>: purpose`, such as `invoicing: purpose`.
     - `question`: `Why does <routine> exist, and for whom?`
     - `alternatives`: each earlier draft the person turned down, or `[]`.
     - `decision`: the statement.
     - `rationale`: the real problem at the bottom of the whys.
     - `decided_on`: the day the person agrees it.
  2. Shows it with `save_record` and `preview` true, and saves it once the person approves.
  3. Calls `link_records` with a `supports` link to each why.
  4. Finds the person's objectives as the `business` skill's section 4 says. It asks which one the routine serves, offering the objective that names the routine, with Yes and Other. With none saved, it asks for the objective first, as the `getting-started` skill's section 4 says.
  5. Once the person approves, it saves a new version of the statement with `properties` `objective` set to the objective's title, such as `Objective: Triage my email`. When the routine is in General, it also calls `link_records` with a `supports` link to the objective. fabrik refuses a link to a record in another scope, so a routine in any other scope names its objective in `properties` only.
- **Evidence:** the decision's `record_id`, `version_id` and `version_number`, and the objective it supports.

**AI guided:** the agent gives the person the decision record and its links before saving, and waits for their approval.

## 5. Use and revise it

- **A filter.** The agent holds each new requirement against the statement. It shows the person each one that serves none of its three parts, and asks whether to drop it or revise the statement. The buttons are "Drop it" and "Revise statement".
- **A test for a choice.** When two ways of working are on the table, the agent reads the statement out and asks which one serves it better.
- **A revision.** When new facts change the problem, the person revises the statement openly. The revision is a new version of the decision. Its `reason` says what changed, and its `rationale` says why.

## Problems

- **No grant to save a decision in the scope:** fabrik's refusal names the missing action, such as `decide`. An administrator can grant it.
- **The person asks to skip the whys:** the agent writes the statement from what they said. It marks each part it could not confirm as an assumption, in the `rationale`.
- **"stale":** someone saved a newer version. The agent reads the record again and shows the person the newer version before saving.
