---
name: design
description: Use when a person asks for a better way to run a routine, or to design a new one. It questions the current state against the business profile and what the web says of the industry. It takes stock of the connectors and plugins the person has or could add, and keeps each application the person said must stay. It saves the proposed design as a model, each step assigned to a person, code, a connector or Claude. It runs in one of three modes: human only, AI guided or human directed.
---

# Routine design

This skill runs only as fabrik's assistant, `fabrik:assistant`. Before anything else, the agent reads `.claude/settings.json` in the session's folder, or in the nearest folder above it that has one. When that file doesn't set `agent` to `fabrik:assistant`, or no folder has one, the agent says only this to the person, and stops:

> Open a Code session in your fabrik folder, usually `~/fabrik`, and ask there again.

A design starts from the business profile, the routine's purpose statement and its current state, the routine the person confirmed with the `interview` skill. The agent questions that routine, and proposes a better one. It audits and designs in one pass: for one person, the two are one conversation.

The person selects the design, or not. A selected design becomes the routine in force, as the `fabrik:records` skill's "The routine in force" says. The agent then follows it when it does that work.

A design never schedules work itself. The person may run a routine on a schedule with one of Claude's scheduled tasks, which is theirs to set up. A design never sends, pays, books or deletes without the person confirming in a session they are watching, scheduled or not. A step that would need that is the person's, and the agent prepares it.

Every save follows the `fabrik:records` skill's section 3. The agent shows the person what it will save, and saves only what they agree to. The agent asks each question as the card rules' "Asking a question" says. The `fabrik:graph` skill draws the saved design.

## Choose the mode

The person chooses the mode.

- **Human only:** the person follows the Person lines below, without the agent. They do each step with the fabrik-apps connector's tools and a browser.
- **AI guided:** the person asks the agent to guide them. Before each step, the agent says what the step does and shows the Person line. It stops for the person's approval at the end of each stage.
- **Human directed:** the person tells the agent what to do. The agent follows its lines for each step the person directs.

Each step below gives a **Person** line and an **Agent** line.

With the agent, the person's own instruction replaces a rule of this skill, such as one design or compared options. The agent names the rule once and does as told. Nothing replaces the rules in "Industry knowledge" or the paragraph above on what never runs on its own. A refusal from fabrik or a tool still stands.

## Industry knowledge

Industry knowledge questions the current state and shapes the design. It is never the person's evidence.

- It comes from the web at design time, from sources the agent names. fabrik ships no industry reference.
- Each finding that rests on it is an `evidence` record with `standing` `unverified`, titled `Industry knowledge: <what it says>`.
- Its `summary` opens "Industry knowledge, not your evidence:", and ends with the source's link and the day it was read.
- Its `source_reference` is the source's `https://` link, and `limitations` says the person never said it.
- It links to the current-state model with `describes`. The current state never links to it with `supports`.
- A step the person never mentioned is not evidence that they skip it. The finding asks whether that step happens.
- A rule from the web is a checklist item, not legal or tax advice. The person decides how it applies to them.

## Stages

Work through these in order.

### 1. Read the profile and the purpose statement

- **Person:** names the routine.
- **Agent:** reads the business profile, as the `business` skill's section 1 says. With none, it asks for it with that skill first. It finds the routine's purpose statement with the `purpose` skill, or writes and saves one. The design waits until the person agrees a statement.

**AI guided:** the agent gives the person the profile and the statement, and waits for their approval.

### 2. Read the current state

- **Person:** names the current state to start from, or none.
- **Agent:** calls `list_records` with `kind` `model` and `title` `<routine> current state`, keeps the record titled exactly `<routine>: current state`, and reads it with `get_record`. Other routines whose names hold the same words are left out. It reads each statement the model links to with `supports`. It asks whether the routine still runs that way.

A routine with no current state, or whose basis is `intended`, gives a standalone design. Its description says so: "Basis: standalone. The design starts from no current state." The missing current state is an assumption and a risk.

**AI guided:** the agent gives the person the current state, step by step, and waits for their approval.

### 3. Question it with industry knowledge

- **Person:** reads each finding, and says whether it fits their business.
- **Agent:** searches the web for how businesses like this one run this routine. It weighs the business's industry, country and size from the profile. It writes each gap or difference as a question for the person, never as a fact about their business. It saves each finding the person agrees to keep, as "Industry knowledge" says.

Each finding from what the person said, rather than from the web, is an `evidence` record with `standing` `stated`. It cites the statement it rests on, and links to the current state with `describes`.

**AI guided:** the agent gives the person each finding with its link, and waits for their approval before saving.

### 4. Take stock of the tools

- **Person:** says which tools they use and which they would pay for.
- **Agent:** lists the tools in four groups, each tool with how it was found, as `references/tools.md` in this skill's folder says. It does this before it assigns any step.

**AI guided:** the agent gives the person the four groups, and waits for their approval.

### 5. Design the proposed state

- **Person:** says what the design should hold, and agrees its shape.
- **Agent:** designs one routine, or options that differ in substance where the person asks. It answers each finding: the design keeps, replaces or drops each step and check of the current state. A check it drops needs the person's word. It reviews the shape before saving, as "Review the shape" says.

A suggestion fits the business. Its size, its budget and the tools it already uses come first.

An application the business profile marks `essential` must stay.

Each other application in the current state carries the person's answer, from the interview, on whether it must stay. A step on an application that must stay keeps it, and the design works around it. A step on an application that could go may move to a connector, a plugin, code or Claude. Where the current state holds no answer for an application, the agent asks first, with "Must stay" and "Could go". A new paid service names its price from the vendor's page, with the link and the day it was read. Where no price is published, the design says so.

**AI guided:** the agent gives the person the design, step by step, with its case, and waits for their approval.

### 6. Assign each step

- **Person:** names who does each step and who confirms it.
- **Agent:** assigns each step to a person, code, a connector or Claude, as `references/execution-and-authority.md` in this skill's folder says. Each step's assignment goes in its node's `attributes`, and the coverage summary in the design's `description`. `confirmed_by` names who confirms the step, and `auto_for` whose requests it runs for without asking. `cases` names the cases it covers, and `settings` each value it reads. The agent asks the person for each value a step reads and puts it in `settings`, never in the step's text.

**AI guided:** the agent gives the person the coverage summary, and waits for their approval.

### 7. Save and draw the design

- **Person:** agrees each save. Without the agent, saves the design with `save_record` and its links with `link_records`.
- **Agent:**
  1. Builds the design's `fields`. `model_kind` is `proposed_target`, and `source_status` is `proposed`. The `description` holds the purpose statement, the basis, the assumptions, the review's answers and the coverage summary, within 4,000 characters.
  2. Builds the `graph` from the node and edge types in the `fabrik:graph` skill's "The state machine model".
  3. Calls `save_record` with `preview` true, in the routine's scope, `kind` `model` and title `<routine>: proposed state`. Options are titled `<routine>: proposed state, <option>`. It saves once the person approves.
  4. Calls `link_records`: `describes` to the current state, and `supports` to the purpose statement and to each finding the design answers.
  5. Draws it with `show_graph` and `record` set to it. For a page to keep, it follows the `fabrik:graph` skill's section 3.
- **Evidence:** each saved `record_id` and `version_id`, and the page's path where there is one.

**AI guided:** the agent shows the person each save before it is made, and the drawing after.

### 8. Record the person's choice

- **Person:** selects the design, rejects it, or leaves it open.
- **Agent:**
  1. Finds the routine's decision with `list_records`, keeping the record titled exactly `<routine>: design choice`. With none, it builds one in the routine's scope. Its `question` is `How should <routine> run?`, and `alternatives` names each design and option. A routine has one such decision, and each choice is a new version of it.
  2. For a selection, sets `decision` to the design's exact title, `rationale` to the person's reason, and `decided_on` to today. It links the decision with `supports` to the selected design, which also moves an earlier link to that design onto its latest version. It removes with `unlink_records` each other `supports` link to a design, so the decision supports the selected design alone.
  3. For a rejection, sets `decision` to `Rejected: <title>` and `decided_on` to today, and removes each `supports` link to a design with `unlink_records`. Left open, `decision` is empty and `decided_on` null, and the `supports` links to designs are removed the same way.
  4. Shows the save and saves it once the person approves.
  5. After a selection, tells the person this design is now the routine in force, and that the agent will follow it.

A changed design is a new version, and stays out of force until the person selects that version. The selection is a new version of the decision.

**AI guided:** the agent shows the person the decision before saving, and waits for their approval.

## Review the shape

The design is the shape that carries the routine, not a diagram of the telling. The agent answers each of these in the design's description, before the first save and again before drawing:

- Name the trigger, who is responsible and the outcome. A routine that cannot be described this way is more than one routine.
- Separate paths whose rules, deadlines or promises differ. Each path ends in its own outcome.
- Hold each step against the purpose statement. Show the person each step that serves none of it.
- Check that the simpler shape still carries every requirement, exception and deadline.
- Find each value a step reads, such as who is asked, which customers it covers or how many days it looks back. Ask the person for each one the step's attributes lack, and put it in `confirmed_by`, `auto_for`, `cases` or `settings`, not in the step's text.

A design for a large business can outgrow 4,000 characters of description. It then splits into routines, each saved as its own design.

## Problems

- **No grant to save in the scope:** fabrik's refusal names the missing action. An administrator can grant it.
- **"stale":** someone saved a newer version. The agent reads the record again and shows the person the newer version before saving.
- **The web gives thin or conflicting answers:** the agent says so, keeps each finding unverified with its link, and the person decides.
