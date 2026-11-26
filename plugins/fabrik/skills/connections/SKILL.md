---
name: connections
description: Use when a search shows parts waiting for connections while connections are off or wait for a class. Also use when a person asks about connections or the business's Anthropic API key. Covers when to offer connections and how to explain them. Covers proposing the glossary's classes and relationships from the files the business holds and its business profile. Covers the card where an administrator types the key to turn connections on, or turns them off.
---

# Connections between files

Connections are the links between the people, companies, orders and other things the business's files name. With connections on, fabrik reads who and what each new part of a file mentions, and how they're linked, as the `fabrik:records` skill's section 18 says. A search then follows those links.

Always say connections to the person. Never say the graph, the graph reader or extraction. The tools keep their own names, such as `fabrik_get_graph_reader`.

## 1. When to offer

Offer connections once in a session, in the next-step box, with Tell me more and Not now. Offer only when all of these hold:

- A search answer's `stages.awaiting_extraction` is above 0.
- `fabrik_get_graph_reader` gives `on` false.
- `fabrik_get_actor` gives `authority_class` `administrator`.
- The business has 20 or more files. Count them with the plugin's `list_files` on each scope's bucket, named by the scope's code from `list_scopes`. An entry with no `id` is a folder: count its files too, with its path as `prefix`. Stop counting at 20.
- The session has offered neither the update nor getting started.

Say it in one sentence, such as "Your files have 140 parts that fabrik could read for connections, so a search also finds a file through who and what it names." On Not now, save nothing and make no other offer of connections in this session.

When the person asks about connections themselves, explain them as section 2 says, whatever the count.

### Connections on, with no class

fabrik reads no part while the glossary has no class, even with the key kept. `fabrik_get_graph_reader` then gives `waiting_for_classes` true, a search's `stages.waiting_for_classes` is true, and the connections card says so. This happens when the key was saved on the card before the glossary had a class.

Whenever one of these shows it, tell the person in one sentence, such as "Connections are on, but fabrik reads none of the 15,146 waiting parts until the glossary has a class." Then propose classes as section 3 says, whatever the session has offered before. For a person who isn't an administrator, the same holds: any person may propose a class, as the `fabrik:reference` skill's section 2 says.

Call `fabrik_get_graph_reader` once in a session before offering, explaining or setting up connections, and again after the person says the card shows connected.

## 2. The explanation

Explain connections in this order, in plain words, in a few sentences:

1. **What they are.** The links between the people, companies, orders and other things the files name.
2. **How they work.** fabrik reads each new part of a file with Claude, usually within an hour and at most a day. It keeps who and what each part names, and how they're linked. Each kind of thing comes from the glossary's classes.
3. **What they add.** A search finds a file through those links. Ask about a customer, and search also finds the invoice that names the customer's director, though the invoice never names the customer.
4. **What they cost.** Anthropic charges the business's own API key for each part fabrik reads. Name how many parts are waiting, from `stages.awaiting_extraction`, and point to anthropic.com/pricing for the rates. Never work out a price. fabrik stops reading for the month once the month's cost reaches a cap. `fabrik_get_graph_reader` gives an administrator the cap as `monthly_cap_usd`, and the cost so far as `month_cost_usd`. Name both.
5. **When they're worth it.** Say which applies, from the number of files and the kinds of things they name. Connections are worth it when many files are about the same customers, suppliers, people or orders. For a handful of files, or one-off lookups, words and meaning are enough.

Then say that without connections, search still finds files by their words and their meaning. Ask in the next-step box whether to set connections up, with Set up and Not now.

## 3. The glossary's classes

Connections need at least one class in the glossary. Call `get_reference` with `part` `glossary`. When it has a class, go on to section 4.

Otherwise, propose classes and relationships drawn from what the business already holds:

1. Read the business profile, as the `fabrik:business` skill's section 1 says.
2. Read the files the business holds. Call `list_scopes`, then the plugin's `list_files` on each scope's bucket, named by the scope's code, and read the file names and folders. Read the titles of up to 50 files across the scopes. Then call `search` with no scope for three to five kinds of thing the names and the profile suggest, such as "customer" or "invoice". Read the snippets each search gives.
3. Take the kinds of things the files name most often. Name only kinds that the files or the profile show. A kind that's usual for this line of work but missing from both is left out. Propose 5 to 12 classes, most common first.
4. Take the relationships between those classes that the snippets state, such as an author writes an article, or a customer places an order. Propose only relationships between the classes proposed.
5. Show each class with its name, its definition in plain words, and where it was seen, such as "named in 214 file titles in the General scope". Show each relationship with its from and to classes in the same way.
6. Save each one as the `fabrik:reference` skill's section 2 says, only once the person approves it. Save the classes first, then the relationships.
7. Tell the person that connections keep only things of these kinds, so a file's other things are left out. They can add a class later, and fabrik reads new parts by the new list.
8. When the person wants files sorted by subject, propose a class such as `topic`. Propose the topics the files are mostly about, each saved with `instance_of` `topic`. Draw them from the same titles and searches, as the `fabrik:reference` skill says. fabrik then tags each new part with its topics as it reads it. Files read before are tagged with `tag_file`, as the `fabrik:records` skill's section 18 says.

With no files and no business profile, ask the person what kinds of things their files are mostly about, and propose those.

Once a class is saved with connections on, call `fabrik_get_graph_reader` again. `waiting_for_classes` is then false, and fabrik reads the waiting parts usually within an hour, and at most a day.

## 4. The key, on the card

Only an administrator turns connections on or off. When `fabrik_get_actor` gives another `authority_class`, tell the person an administrator turns connections on, and stop.

Write the steps first and show the card last, so the card sits under the steps in the chat.

Never ask for the key in the chat, and never accept one that's offered. When the person pastes a key into the chat, tell them to delete it in the Anthropic Console. Then they make a new one for the card.

1. Give the person these steps to make the key, one numbered line each:
   1. On a Claude Max, Ultra or Team plan, claim the plan's monthly API credits first. On claude.ai, open Settings, then Billing, and under "API credits" choose Link organization. Without one of those plans, buy credits in the Claude Console under Billing.
   2. Open the Claude Console at platform.claude.com, in the organization that gets the credits.
   3. Start a new API key. Where the Console asks "Where does your code run?", choose Somewhere else, since fabrik's reader runs on Supabase, not on this computer.
   4. Name the key fabrik, leave Expires at Never and Scope at Default workspace, then create it and copy it. It starts `sk-ant-`, and the Console shows it only once.
   5. Paste it on the card and choose Save.

2. Call `show_connections_setup`. It shows the connections card, which says whether connections are on.
3. End the turn. The card checks the key with Anthropic before it keeps it, and shows connected, or the reason Anthropic gave.

Once the person says the card shows connected, call `fabrik_get_graph_reader`. When it gives `waiting_for_classes` true, the card says fabrik reads no part yet: propose classes as section 3 says. Otherwise, tell them fabrik reads the waiting parts usually within an hour, and at most a day. A search after that finds a file through a connection, and `graph` is then among a hit's `found`. Name the link in plain words, as the `fabrik:records` skill's section 6 says.

## 5. Turning connections off

When an administrator asks to turn connections off, call `show_connections_setup`. The card's Turn off removes the key. fabrik then reads no more parts, and the connections already kept stay. Search keeps following them.
