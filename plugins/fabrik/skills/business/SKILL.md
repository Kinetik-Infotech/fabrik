---
name: business
description: Use when the agent needs to know the business it works for. It reads the business profile from one fabrik model record. With none, it reads the business's website and social media profiles, then asks only for what they don't say. It saves each fact as evidence and the profile as a new version, and keeps each objective as a decision record. It runs in one of three modes: human only, AI guided or human directed.
---

# The business profile

This skill runs only as fabrik's assistant, `fabrik:assistant`. Before anything else, the agent reads `.claude/settings.json` in the session's folder, or in the nearest folder above it that has one. When that file doesn't set `agent` to `fabrik:assistant`, or no folder has one, the agent says only this to the person, and stops:

> Open a Code session in your fabrik folder, usually `~/fabrik`, and ask there again.

The agent works for one business. The **business profile** says what that business is: its industry, where it trades, its size and its stage. It also says what it sells, to whom, and the applications it uses, with those it can't work without. The `interview` and `design` skills read it before anything else. The agent reads it once per session, before its first answer about the business's work.

The profile is one `model` record in General, titled `Business profile: <business name>`, with `model_kind` `observed_current`. Each fact the person gives is an `evidence` record of its own. The profile links to each one with `supports`.

Every save follows the `fabrik:records` skill's section 3. The agent shows the person what it will save, and saves only what they agree to. The agent asks each question as the card rules' "Asking a question" says.

## Choose the mode

The person chooses the mode.

- **Human only:** the person follows the Person lines below, without the agent. They do each step with the fabrik-apps connector's tools.
- **AI guided:** the person asks the agent to guide them. Before each step, the agent says what the step does and shows the Person line. It stops for the person's approval at the end of each stage.
- **Human directed:** the person tells the agent what to do. The agent follows its lines for each step the person directs.

Each step below gives a **Person** line and an **Agent** line.

With the agent, the person's own instruction replaces a rule of this skill, such as the number of questions. The agent names the rule once and does as told. A refusal from fabrik or a tool still stands. The agent gives it to the person with what they can do instead.

## 1. Read the profile

- **Person:** asks what fabrik knows about their business. `list_records` with `kind` `model` and `title` `Business profile` finds the profile, and `get_record` reads it.
- **Agent:**
  1. Calls `list_records` with `kind` `model` and `title` `Business profile`. When the person has more than one business, it shows the profiles on a question card. It asks which one this session is for, offering the best fit with Yes and Other.
  2. Reads the profile with `get_record`. The `business` node's `attributes` hold the facts. Its links name the evidence behind each fact.
  3. With no profile, it calls `search` with the business's name, in case the facts sit in a note. Then it asks for the profile, as section 2 says.
- **Evidence:** the profile's `record_id` and `version_number`, or that there is none.

**AI guided:** the agent gives the person the profile it found, or says there is none, and waits for their approval.

## 2. The facts the profile needs

The profile needs these facts, each in the `business` node's `attributes`:

| Attribute | What it holds |
|---|---|
| `website` | the business's website address |
| `social` | the addresses of its social media profiles |
| `industry` | the line of work, in the person's words |
| `country` | where the business trades |
| `people` | how many people work in it |
| `revenue_band` | only where the person gives one |
| `stage` | such as starting, growing or established |
| `mail_account` | the email account the business sends from: `fabrik:<mailbox name>` for a mailbox set up in fabrik, or `connector:<service>:<address>` for a Claude connector, such as `connector:gmail:ann@example.com` |

The graph also holds nodes for what the business sells, its customers and the applications it uses. Objectives are their own records, as section 4 says.

- **Person:** gives the business's website and social media profiles, and corrects what the agent read from them. Then answers each question about the rest, or says to skip it.
- **Agent:**
  1. Before any other question, asks for the business's website and social media profiles, such as its LinkedIn or Instagram page. The other answer is I have none.
  2. Reads each page with the tools the session has, such as fetching the page or the browser. A profile behind a sign-in is read in the person's own browser when one is connected.
  3. Fills the profile from what the pages say. That is the business's name, what it sells, its industry, where it trades, its customers and its size. A marketing line stays a claim. "Over 35 years" is a claim about experience, and not the business's age.
  4. Shows the person what it read, page by page, and asks them to correct anything wrong or out of date.
  5. Names each page that can't be read, and asks for the facts it would have given instead.
  6. Asks only for the fields still missing, one question per reply. Pages rarely say which applications the business uses, so it asks that, and then which of those applications the business can't work without. It asks which email account the business sends from. It names the mailboxes set up in fabrik and the session's mail connectors, with the address each is signed in to. It takes a skipped question as unknown, and never fills a gap with what is usual for that kind of business.
  7. Once the profile is saved, takes the brand from the website with the `fabrik:brand` skill, as section 3 says.

Each fact is an `evidence` record:

- `title`: `Business profile: <business name>: <what the fact covers>`, such as `Business profile: Smith Joinery: customers`.
- `summary`: the fact, in the person's own words or the page's, where it matters.
- `standing`: `stated`.
- `source_reference`: the page's address, or the person's name and `business profile`.
- `source_date`: today.
- `limitations`: what the person was unsure of, or that a page said it and the person confirmed it, or `none`.

The agent saves the facts together at a natural pause, as separate records, and shows them together first.

**AI guided:** the agent gives the person the facts it will save, and waits for their approval.

## 3. Save the profile

- **Person:** agrees the profile's wording. Without the agent, saves it with `save_record`, with `scope` `general`, `kind` `model` and `fields` as below. Links each answer with `link_records`, `relation` `supports`.
- **Agent:**
  1. Builds the model's `fields`: `model_kind` `observed_current`, `source_status` `stated, confirmed by <name>`, and a `description` of two or three sentences. Its `graph` holds one `business` node and nodes of type `offer`, `customer` and `application`. An `application` node holds `essential` true for one the business can't work without, and false otherwise. Each is joined to the business node by an edge.
  2. Calls `save_record` with `preview` true, shows the person the profile, and saves it once they approve.
  3. Calls `link_records` with a `supports` link to each answer's record.
  4. With no `Brand` record in General, asks whether fabrik should use the logo, colours and fonts from the business's website on its cards and PDFs. The answers are Yes and Not now. On Yes, it follows the `fabrik:brand` skill, which reads the website from the profile.
- **Evidence:** the profile's `record_id` and `version_id`, and each link.

A later answer is a new evidence record, and a new version of the profile with the changed facts. The agent shows the changed facts before it saves.

**AI guided:** the agent gives the person the profile and its links before saving, and waits for their approval.

## 4. The objectives

An objective is the outcome of one routine, personal or for work, such as "triage my email", "plan the family's meals each week", "automate creating invoices" or "create content for my social channels". Each one is a `decision` record in General, titled `Objective: <name>`, such as `Objective: Triage my email`. It names its routine, and the routine's purpose statement names the objective it serves, as the `purpose` skill's section 4 says.

- **Person:** names each routine they want help with, what they want from it, and how they'll know it's achieved. Without the agent, saves each with `save_record`, as a `decision` with the fields below.
- **Agent:**
  1. Calls `list_records` with `kind` `decision` and `title` `Objective`. It keeps only the records whose title starts `Objective: `, since `list_records` also finds other decisions with the word anywhere in their title. It reads each with `get_record`, and shows the person the objectives it found.
  2. Asks for a new objective as the `fabrik:getting-started` skill's section 4 says, so a person with no business is asked the same way.
  3. Builds the record, shows it with `save_record` and `preview` true, and saves it once the person approves.
- **Evidence:** each objective's `record_id` and `version_number`.

Each objective holds these fields:

- `question`: `What does <person or business name> want from <routine>?`
- `alternatives`: `[]`.
- `decision`: the objective, in one sentence.
- `rationale`: why it matters, in the person's own words, quoted.
- `decided_on`: the day the person approves it.
- `properties`: an object with `scope`, `personal` or `business`, and `routine`, the routine's name. It also holds `outcome`, in the person's words, and `measure`, how they'll know it's achieved.

The routine's name is short lowercase words joined by hyphens, such as `email-triage`. Its purpose statement, current state and design take their titles from it.

A new version replaces `properties` whole. A change to one key, such as a new `measure`, sends the other keys again as they were, or the new version loses them.

A `decision` takes `scope`, `routine`, `outcome` and `measure` only inside `properties`. fabrik refuses them as fields of their own.

**A profile that holds objectives.** An earlier profile may hold objectives as nodes in its graph. The agent shows the person each one as an objective record, and saves it once they approve. It then saves a new version of the profile without those nodes, with a `reason` of "Objectives moved to their own records".

**AI guided:** the agent gives the person each objective before saving it, and waits for their approval.

## Problems

- **No grant to save in General:** fabrik's refusal names the missing action. An administrator can grant it.
- **"stale":** someone saved a newer version. The agent reads the profile again and shows the person the newer version before saving.
- **Two profiles for one business:** the agent shows both, and asks which one stays. The other is deleted only on the person's word, as the `fabrik:records` skill's section 7 says.
