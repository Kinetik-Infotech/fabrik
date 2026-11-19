---
name: connections
description: Use when a search shows parts waiting to be read for connections while connections are off. Also use when a person asks about connections or the business's Anthropic API key. Covers when to offer connections and how to explain them. Covers proposing the glossary's classes from the business profile. Covers the card where an administrator types the key to turn connections on, or turns them off.
---

# Connections between files

Connections are the links between the people, companies, orders and other things the business's files name. With connections on, fabrik reads who and what each new part of a file mentions, and how they're linked, as the `fabrik:records` skill's section 18 says. A search then follows those links.

Always say connections to the person. Never say the graph, the graph reader or extraction. The tools keep their own names, such as `fabrik_get_graph_reader`.

## 1. When to offer

Offer connections once in a session, in the next-step box, with Tell me more and Not now. Offer only when all of these hold:

- A search answer's `stages.awaiting_extraction` is above 0.
- `fabrik_get_graph_reader` gives `on` false.
- The business has 20 or more files. Count them with the fabrik command's `list_files` on each scope `list_scopes` gives, and stop counting at 20.
- The session has offered neither the update nor getting started.

Say it in one sentence, such as "Your files have 140 parts that fabrik could read for connections, so a search also finds a file through who and what it names." On Not now, save nothing and make no other offer of connections in this session.

When the person asks about connections themselves, explain them as section 2 says, whatever the count.

## 2. The explanation

Explain connections in this order, in plain words, in a few sentences:

1. **What they are.** The links between the people, companies, orders and other things the files name.
2. **How they work.** fabrik reads each new part of a file with Claude, within a day, and keeps who and what it names and how they're linked. Each kind of thing comes from the glossary's classes.
3. **What they add.** A search finds a file through those links. Ask about a customer, and search also finds the invoice that names the customer's director, though the invoice never names the customer.
4. **What they cost.** Anthropic charges the business's own API key for each part fabrik reads. Name how many parts are waiting, from `stages.awaiting_extraction`, and point to anthropic.com/pricing for the rates. Never work out a price.
5. **When they're worth it.** Say which applies, from the number of files and the kinds of things they name. Connections are worth it when many files are about the same customers, suppliers, people or orders. For a handful of files, or one-off lookups, words and meaning are enough.

Then say that without connections, search still finds files by their words and their meaning. Ask in the next-step box whether to set connections up, with Set up and Not now.

## 3. The glossary's classes

Connections need at least one class in the glossary. Call `get_reference` with `part` `glossary`. When it has a class, go on to section 4.

Otherwise, propose classes from the business profile:

1. Read the business profile, as the `fabrik:business` skill's section 1 says.
2. Take the kinds of things from the profile: what the business sells, its customers, its suppliers and its applications. Examples are customer, product, supplier and order. Name only kinds the profile gives. A kind that's usual for this line of work but missing from the profile is left out.
3. Propose each class as the `fabrik:reference` skill's section 2 says: its name and its definition in plain words. Save each one only once the person approves it.
4. Tell the person that connections keep only things of these kinds, so a file's other things are left out. They can add a class later, and fabrik reads new parts by the new list.

With no business profile, ask the person what kinds of things their files are mostly about, and propose those.

## 4. The key, on the card

Only an administrator turns connections on or off. When `fabrik_get_actor` gives another `authority_class`, tell the person an administrator turns connections on, and stop.

1. Call `show_connections_setup`. It shows the connections card, which says whether connections are on.
2. Tell the person to make an API key in the Anthropic Console, at console.anthropic.com, under API keys, and type it on the card. Never ask for the key in the chat, and never accept one that's offered. When the person pastes a key into the chat, tell them to delete it in the Anthropic Console. Then they make a new one for the card.
3. End the turn. The card checks the key with Anthropic before it keeps it, and shows connected, or the reason Anthropic gave.

Once the person says the card shows connected, tell them fabrik reads the waiting parts within a day. A search after that finds a file through a connection, and `graph` is then among a hit's `found`. Name the link in plain words, as the `fabrik:records` skill's section 6 says.

## 5. Turning connections off

When an administrator asks to turn connections off, call `show_connections_setup`. The card's Turn off removes the key. fabrik then reads no more parts, and the connections already kept stay. Search keeps following them.
