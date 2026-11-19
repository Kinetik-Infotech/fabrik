# Execution and authority

Each step of a design is assigned before the design is saved. Each step's assignment goes in its node's `attributes`. The coverage summary goes in the design's `description`.

- **Person:** names who does each step and who confirms it, and approves the coverage summary.
- **Agent:** assigns each step by the method below, and writes the assignment and the summary.

## Who does the step

Classify the work first. Decide who confirms it separately.

| Work | Done by |
|---|---|
| An exact rule, a sum, a lookup or a format check | code |
| A choice from a fixed set of answers, with enough context | Claude, bounded |
| Research, drafting, summing up or planning | Claude, open-ended |
| A judgement the person keeps, or one with thin evidence | a person |

Each row is checked against the simpler choice. An exact rule stays in code, not with Claude. A bounded choice names its answers, and what happens with no match and with an unsure one. Open-ended work checks whether a template or a search is enough.

Code is an exact rule an application the person uses already runs, or one they set up. A step done through a connector names the connector, whether the person has it now, and its source from the stock-take. A step can be split: code checks an input, Claude drafts, and the person approves.

## What never runs on its own

fabrik never runs work unattended. So:

- No step runs on a schedule or in the background.
- A step that sends, pays, books, buys, accepts terms or deletes is the person's. Claude can prepare it, and the person confirms it in a session they are watching.
- Claude's answer grants no permission to act. The person's approval does, for that one step.
- A new service that would receive the business's data needs the person's approval before any data goes to it.

## Each step's attributes

| Attribute | What it holds |
|---|---|
| `done_by` | `person`, `code`, `claude_bounded` or `claude_open` |
| `tool` | the application or connector, or `none` |
| `has_tool` | `yes` or `no` |
| `tool_source` | from the stock-take |
| `confirmed_by` | who says yes before it takes effect |
| `if_it_fails` | what happens when input is missing or a tool is down |

Each failure route ends with the person. A retry reads the inputs again first.

Each Claude step starts untested. The person checks each result until they trust it. The design names what they check, and what counts as wrong.

## Coverage summary

The summary lists every step with who does it, its tool, whether the person has the tool, and who confirms it. Each step is assigned, or carries the reason it is not. A step that changes is assessed again before the design is drawn.

A worked line, for an invoicing routine: "3. Draft the invoice: Claude, bounded, from the job record, through the accounting connector the person has; confirmed by Sam before it is sent."
