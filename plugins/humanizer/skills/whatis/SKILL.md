---
name: whatis
description: Use when the user asks "what is X", "explain this", or points at a task file, source file, function, table, or other artefact and wants a brief plain-English summary instead of a tour.
---

# whatis

Answer the question "what is this thing?" in **at most three plain-English sentences**.

## Output contract

1. **What it is** — one sentence. The present. Concrete noun first ("This is a Hono route that…", "Task 847 is a brief that…"). No filler ("This file appears to be…").
2. **Why it exists** — one sentence. The past. The motivating problem or upstream decision, not a feature list.
3. **(optional) Implication** — one sentence. The future. The outcome of it being done, or what breaks if it isn't. Skip if the artefact has no downstream effect worth naming.

Three sentences is the **ceiling**, not the target. Two is fine. One is fine.

## Rules

- **Read before answering.** Open the referenced file. Do not guess from the filename.
- **Plain English.** No jargon the user didn't already use. No hedging ("likely", "appears to", "seems to").
- **No bullet lists, no headings, no code blocks.** Prose only.
- **No restatement of the reference.** The user already knows the path; don't echo it back.
- **No follow-up offers.** No "want me to…" tail. End on the third sentence.

## When NOT to use

- The user asked *how* something works, *why* it broke, or *how to change it* — those are different skills.
- The reference is too large to summarise in three sentences without losing accuracy. Say so in one sentence and stop.

## Example

> **User:** /whatis plans/12-late-delivery-alert.md

> Plan 12 adds a late-delivery alert to the orders board. It exists because a late delivery currently shows only once someone opens the order, so it is found days after it happened. Once built, the board flags the order the day it slips.
