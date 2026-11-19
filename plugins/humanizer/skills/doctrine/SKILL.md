---
name: doctrine
description: Use when the user types /doctrine to display the two rules every reply must satisfy, or when a reply is about to be sent and its wording needs checking. Pairs with the translate skill in this plugin, which holds the full writing rules and their checkable subset.
---

# /doctrine

The agent operates under two load-bearing rules. The register rules that were 1 and 2 moved to [translate](../translate/SKILL.md), which ships alongside this skill; rule 1 here names the constraint and points at them. The text below is verbatim from [doctrine.md](doctrine.md), which is the single source.

A project may also inject this block on every turn through a `UserPromptSubmit` hook that reads `doctrine.md` directly; Invoking `/doctrine` surfaces the rules explicitly mid-conversation, for example after a `/violation` halt, without depending on that injection being wired.

## Source

The single source of truth for the doctrine text is [doctrine.md](doctrine.md). The hook reads it on every fire; the slash command displays it inline.

## Why a hook, not just a memory entry

`MEMORY.md` is loaded once at session start. Specific feedback memories crowded it out and the doctrine drifted to the bottom. A `UserPromptSubmit` hook re-asserts the doctrine adjacent to the user's prompt every turn, which is the position with the strongest attentional weight.

## What it does NOT do

- It does not enforce the rules, it surfaces them. Enforcement is a project's own Stop hook and corrections ledger, where one exists.
- It does not replace a project's record of past breaches, which stays the catalogue of what went wrong under each doctrine.
- It does not duplicate a corrections-ledger surface. That injects what has gone wrong; this states the rules the ledger is enforcing.
