---
name: compare
description: Use when the person asks to compare products, services, prices or offers on the web, such as "compare three standing desks under £500" or "which of these hotels is cheapest in March". Shows the options found on a list card, with the URL each value came from, and saves a record of the sites visited.
---

# Comparing options

Load `fabrik:browse` first. Its rules hold for every step here.

## Finding the options

1. Ask what to compare only when the request leaves it open. That is how many options, the limit, such as a price, and what matters, such as size or delivery. With "three under £500", take three under £500.
2. Use the built-in browser, unless the person names a site where they are signed in. Search, open each likely option, and read it with `get_page_text`.
3. Keep an option only when its own page shows it meets the limit. Note each value with the URL of the page that showed it, and when the page was read.

The agent adds nothing to a basket, starts no checkout and signs up for nothing. Buying is the person's step, and it waits for their approval as `browse` says.

## The options

4. Show the options on the list card, as the card rules say, one row per option. Each row's `name` is the option, and its `fields` are the price, each thing that matters and `Source`, the URL of the page each value came from. When values came from more than one page, `Source` lists each URL with the values it gave. A value a page didn't show is "not shown", never a guess.
5. In the reply, say in one or two sentences which option fits the request best, and why, from the values in the table only.

## Saving

6. End with the record `browse` describes, listing each site visited.
7. When the person asks to keep an option's page, save it with `save-page`.
