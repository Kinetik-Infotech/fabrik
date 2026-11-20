---
name: getting-started
description: Use when a person asks to get started, or fabrik holds no business profile and no answer to who it's for. It asks whether fabrik is for a business, the person's own life, or both. It takes a business's profile and brand from its website, and saves objectives, each the outcome of one routine. It writes down how one routine runs today, designs a better way and puts it in force. It runs in one of three modes: human only, AI guided or human directed.
---

# Getting started

This skill runs only as fabrik's assistant, `fabrik:assistant`. Before anything else, the agent reads `.claude/settings.json` in the session's folder, or in the nearest folder above it that has one. When that file doesn't set `agent` to `fabrik:assistant`, or no folder has one, the agent says only this to the person, and stops:

> Open a Code session in your fabrik folder, usually `~/fabrik`, and ask there again.

Getting started is one conversation about what the person wants fabrik to run. fabrik can run a business, a person's own life, or both. The agent first asks which. For a business, it reads the business's website and social media profiles, and asks only for what they don't say. Then it asks for the person's objectives.

An objective is the outcome the person wants from one routine, such as "triage my email", "plan the family's meals each week", "automate creating invoices" or "create content for my social channels". A routine is a piece of work done again and again, personal or for work. For the objective the person picks, the agent writes down how its routine runs today, designs a better way, and puts that design in force. From then on, Claude does that work by the routine.

The conversation runs in this order, and each stage leaves its own records:

| Stage | Skill | What it leaves |
|---|---|---|
| Who fabrik is for | this skill | the `Getting started: who fabrik is for` evidence |
| The business and its brand | `fabrik:business`, `fabrik:brand` | the business profile, the `Brand` record and its logo |
| The objectives | `fabrik:business`, `fabrik:purpose` | one `Objective: <name>` decision per objective, and one routine's purpose statement |
| How the routine runs today | `fabrik:interview` | the routine's current state |
| A better design | `fabrik:design` | the routine's proposed state |
| The design in force | `fabrik:design` | the routine's design choice |

The business stage runs only when fabrik is for a business. The records are the person's progress. A later session reads them and carries on from the first stage that has none. The person can stop after any stage.

Every save follows the `fabrik:records` skill's section 3. The agent shows the person what it will save, and saves only what they approve. The agent asks every question in the next-step box, one at a time, as the card rules' "Asking a question" says. A question with two answers has them as its two buttons, such as Yes and No.

## Choose the mode

The person chooses the mode.

- **Human only:** the person follows the Person lines below, without the agent. They do each step with the fabrik-apps connector's tools and the skills each stage names.
- **AI guided:** the person asks the agent to guide them. Before each step, the agent says what the step does and shows the Person line. It stops for the person's approval at the end of each stage.
- **Human directed:** the person tells the agent what to do. The agent follows its lines for each step the person directs.

Each step below gives a **Person** line and an **Agent** line.

With the agent, the person's own instruction replaces a rule of this skill, such as the order of the stages. The agent names the rule once and does as told. A refusal from fabrik or a tool still stands. The agent gives it to the person with what they can do instead.

## 1. Where getting started stands

- **Person:** opens a Code session in their `fabrik` folder and types "Let's get started". Without the agent, finds the records in the table above with `list_records`.
- **Agent:**
  1. Calls `whoami`, then `fabrik_get_actor`, as the `fabrik:actor` skill's section 2 describes. With no one signed in, it gives the person the sign-in command from that skill, and stops until they say it is done.
  2. Calls `list_records` with `kind` `evidence` and `title` `Getting started`. With no record titled `Getting started: who fabrik is for`, it starts at section 2.
  3. When that record names a business, it calls `list_records` with `kind` `model` and `title` `Business profile`. With none, it starts at section 3.
  4. Finds the objectives as the `fabrik:business` skill's section 4 says, keeping only titles that start `Objective: `. With none, it starts at section 4. When no objective's routine has a purpose statement yet, it starts at section 4.
  5. For each routine an objective names, it finds the routine's purpose statement, current state, proposed state and design choice, by their titles. It starts at the first stage that has no record.
  6. With every stage done for one routine, it goes to section 8.
- **Evidence:** the records found, and the stage the conversation starts at.

**AI guided:** the agent says in one sentence where getting started stands, and asks whether to carry on from there, with Yes and No.

## 2. Who fabrik is for

- **Person:** says whether fabrik is for a business, their own life, or both.
- **Agent:**
  1. Asks whether fabrik is for a business, for their own life, or both. The question has three answers, so the person types theirs.
  2. Saves the answer as an `evidence` record in General titled `Getting started: who fabrik is for`. Its `summary` is the answer, `standing` is `stated`, `source_reference` is the person's name and `getting started`, `source_date` is today, and `limitations` is `none`. It shows the record first, and saves it once the person approves.
  3. When the answer is the person's own life alone, it skips section 3 and goes to section 4. Otherwise it goes to section 3.
- **Evidence:** the record's `record_id` and `version_number`.

A changed answer, such as a person who later starts a business, is a new version of the same record.

**AI guided:** the agent gives the person the saved answer, and waits for their approval before the next section.

## 3. The business and its brand

The agent learns what the business is: what it sells, its industry, its size and its customers. It also learns the applications it uses, and those it can't work without.

- **Person:** gives the business's website and social media profiles, and corrects what the agent read from them. Then answers each question about what they didn't say.
- **Agent:** follows the `fabrik:business` skill's sections 1 to 3. It asks for the website first, and reads the profile from it. It asks only for what is still missing, one question at a time. Once the person approves each save, it saves the facts and the profile. Then it takes the brand with the `fabrik:brand` skill, as that skill's section 3 says.
- **Evidence:** the profile's `record_id` and `version_number`, and the brand's, where the person took it.

**AI guided:** the agent gives the person the saved profile and brand, and waits for their approval before section 4.

## 4. The objectives

Each objective is its own record, and names its routine, so the routine can trace back to the outcome it serves. The person may have objectives for their own life, for the business, or both.

- **Person:** names each routine they want help with and what they want from it, one at a time, and how they'll know it's achieved. Then picks one to start with.
- **Agent:**
  1. Finds the objectives already saved, as the `fabrik:business` skill's section 4 says, and shows them.
  2. Asks which routine the person wants help with, and what they want from it, in their words.
  3. Asks how they'll know it's achieved, such as a number of minutes a day or every invoice sent the day the job ends.
  4. When fabrik is for both, asks whether the objective is personal or for the business, with "Personal" and "Business". Otherwise its scope follows from section 2's answer.
  5. Builds the `Objective: <name>` decision with the fields in the `fabrik:business` skill's section 4, naming its routine. It shows the record with `save_record` and `preview` true, and saves it once the person approves.
  6. Asks whether there is another objective, with Yes and No.
  7. With more than one objective, shows them on a question card and asks which to start with. It offers the one the person named as most pressing, with Yes and Other.
  8. Finds or writes that routine's purpose statement with the `fabrik:purpose` skill. The statement names the objective, as that skill's section 4 says.
- **Evidence:** each objective's `record_id` and `version_number`, and the purpose statement's `record_id`.

**AI guided:** the agent gives the person the objectives and the purpose statement, and waits for their approval before section 5.

## 5. How the routine runs today

- **Person:** describes the last time the routine ran, step by step, and says which applications it uses.
- **Agent:** follows the `fabrik:interview` skill from its section 2, with the routine's name and its purpose statement already settled. For each application the routine uses, it asks whether the application must stay or could be replaced, with "Must stay" and "Could go". It saves the confirmed routine as the current state, and draws it.
- **Evidence:** the current state's `record_id` and `version_number`.

**AI guided:** the agent gives the person the drawn current state, and waits for their approval before section 6.

## 6. A better design

- **Person:** says which tools they use and which they would pay for, and agrees the design's shape.
- **Agent:** follows the `fabrik:design` skill's stages 1 to 7. It takes stock of the connectors and plugins the person has or could add, and keeps each application that must stay. It saves the design as the proposed state, and draws it.
- **Evidence:** the proposed state's `record_id` and `version_number`.

**AI guided:** the agent gives the person the drawn design, and waits for their approval before section 7.

## 7. The design in force

- **Person:** selects the design, rejects it, or leaves it open.
- **Agent:** follows the `fabrik:design` skill's stage 8. It asks whether to put the design in force, with Yes and No. Once the person approves, it saves the design choice. It tells the person that Claude follows this design from now on whenever it does that work.
- **Evidence:** the design choice's `record_id` and `version_number`.

When the person rejects the design or leaves it open, the agent asks what should change, and goes back to section 6.

**AI guided:** the agent gives the person the design choice, and waits for their approval before section 8.

## 8. What is left

Getting started ends when one routine's design is in force. The other objectives wait for a later session.

- **Person:** reads the list, and picks what to do next, or stops.
- **Agent:**
  1. Draws a list card, as the card rules' "The list card" says. It has one row per objective. Each row's fields are its routine and the next stage that routine needs.
  2. Offers the objective the person named as most pressing, with "Start it" and "Not now". On "Start it", it carries on at its routine's next stage.
  3. When fabrik is for a business with a website, it calls `public_knowledge_get`. For an administrator with no KNOWLEDGE.md saved, it says fabrik can put a chat box on the website. The box answers visitors from a page the person writes. It asks whether to set it up, with "Set it up" and "Not now". On "Set it up", it follows the `fabrik:public-agent` skill.
- **Evidence:** the list card's data file.

## When the person changes something

- **A stage out of order:** the agent runs it, and names the records an earlier stage would have left that are still missing.
- **Another objective first:** the agent starts its routine at that routine's own next stage. The other routines keep their records.
- **A problem during a stage:** the agent offers the `fabrik:support` skill, and carries on once it is solved.
