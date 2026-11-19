---
name: summarise
description: Use when the user types /summarise, or asks for a summary, recap, or "in short" version of what the agent just said or asked. Restates the agent's own immediately preceding turn under the doctrine and plainly rules. When that turn concluded an investigation, the summary carries exactly two things: the diagnosis and the proposed resolution.
---

# summarise

The subject is the agent's own last turn, not the codebase, not the conversation as a whole, and not the user's message. Whatever was just said or asked gets restated so a reader who skipped the turn ends up with the same working understanding, in a fraction of the words.

## What success looks like

The summary satisfies [doctrine](../doctrine/doctrine.md) in full: precise, concise, plain English, every claim already evidenced in the turn being summarised. It also satisfies [plainly](../plainly/SKILL.md): spoken register, no acronyms, no formulas, no AI tells, no em-dashes. Read both before writing; do not summarise from memory of what they say.

Three sentences is the ceiling for an ordinary turn. If the turn ended in a question, the summary states the question and what turns on the answer, and nothing else.

## Investigations

When the preceding turn concluded an investigation, the summary has exactly two parts, in this order:

1. **Diagnosis.** What is actually wrong, and the evidence that establishes it. Name the cause, not the layer where the symptom surfaced.
2. **Proposed resolution.** What would fix that cause, and its scope boundary.

Both parts are mandatory. A diagnosis with no proposed resolution is an unfinished summary; a proposed resolution with no diagnosis is speculation wearing a summary's clothes. Neither part introduces a finding, a fix, or a caveat that was absent from the turn being summarised. If the investigation reached a diagnosis but no resolution, say that in the resolution slot rather than inventing one.

## Constraints

- **No new content.** The summary is a compression, never an extension. Anything not in the turn being summarised does not belong here.
- **Drop the scaffolding, keep the load.** File paths, tool names, and step-by-step narration go unless the reader needs them to act. The outcome stays.
- **No hedging.** The original turn either established a claim or it did not. Do not soften a confirmed finding into "appears to", and do not harden a speculation into a fact.
- **No follow-up offers.** End on the summary.

## When NOT to use

- The user wants the summary of a document, a file, or someone else's text: that is ordinary reading work, and [plainly](../plainly/SKILL.md) or [whatis](../whatis/SKILL.md) fits better.
- The last turn was already one or two plain sentences: there is nothing to compress, so say so and stop.
