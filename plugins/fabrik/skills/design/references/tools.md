# Taking stock of the tools

Before it assigns any step, the agent lists the tools that could do the routine's work. It lists four groups, in this order. Each tool carries how it was found, so the person can check it.

- **Person:** says which tools they already use, and which they would pay for.
- **Agent:** builds the four groups below, and shows them to the person as one list per group.

## 1. In this session

The connectors and plugins the session already has, read from the tools the agent can call. Each one is named with what it does for the routine.

- **Source:** `in this session`.
- **The person has it:** yes.

## 2. fabrik's own plugins

The plugins fabrik's marketplace lists, read from its `marketplace.json` file. In Claude Code, the file is at `~/.claude/plugins/marketplaces/fabrik/.claude-plugin/marketplace.json`. Elsewhere, the agent reads it from fabrik's GitHub page, `https://github.com/Kinetik-Infotech/fabrik`.

- **Source:** `fabrik marketplace`.
- **The person has it:** yes when the session lists its skills or tools, otherwise no.

## 3. Claude's catalogue

Where the client offers a search of Claude's catalogue of connectors and plugins, the agent searches it for each step's need. The Claude desktop app's Code tab offers `search_mcp_registry`, `suggest_connectors` and `SearchPlugins`. Where the client offers none, the agent says so and leaves this group empty.

- **Source:** the search it came from and today's date, such as `SearchPlugins, read <date>`.
- **The person has it:** no, unless it is also in group 1.

## 4. Official integrations on the web

Integrations a vendor publishes for an application the business already uses, found on the vendor's own site. An application the profile lists comes first.

- **Source:** the page's `https://` link and the day it was read.
- **The person has it:** no, unless they say so.

## What each entry holds

| Field | What it holds |
|---|---|
| Tool | its name |
| Step | the routine's step it serves |
| Source | as its group says |
| Has it | yes or no |
| Price | for a new paid service, from the vendor's page |

A price comes from the vendor's own page, with its link and the day it was read. Where no price is published, the entry says so. A tool the business could not afford, or does not need at its size, is left out, and the agent says why.

A catalogue entry can change or be withdrawn. The agent never says a tool exists without naming where it read that.
