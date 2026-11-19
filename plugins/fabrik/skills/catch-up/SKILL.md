---
name: catch-up
description: Use when the person asks to catch up on a site they are signed in to, such as "catch me up on LinkedIn notifications", their LinkedIn messages or another feed. Reads the pages in Claude in Chrome and shows one row per item with its time. It marks who is already in fabrik and what fits the person's open projects, and saves the items the person picks. It only reads the site.
---

# Catching up on a site

Load `fabrik:browse` first. Its rules hold for every step here.

## Reading

1. Use Claude in Chrome, since these pages need the person's login. Check it is connected, as `browse` says.
2. For each page the person names, open a new tab with `tabs_create_mcp` and `navigate` to it. For LinkedIn notifications that is `https://www.linkedin.com/notifications/`, and for LinkedIn messages `https://www.linkedin.com/messaging/`.
3. Read it with `get_page_text`. When the page shows a sign-in form instead, ask the person to sign in in that tab and say when it is done.
4. Make one item for each notification, message or post. Each holds when it happened as the page says it, who it is from, and what it says in a line.

The agent clicks nothing that changes the site: no Like, no Accept, no Reply and no Mark as read. It scrolls only to read more.

## Checking fabrik

5. For each person an item names, call `contact_lookup` with `name`. For each organisation, call `lookup_by_name`. An item whose person or organisation is found is marked "in fabrik", with that record's name.
6. Call `project_list` once. An item that names one of the person's open projects, its people or its subject is marked with that project.

## Showing the items

7. Show the items on a question card, up to 20 rows, newest first. Each row's `name` is who it is from, and its `fields` are When, What, In fabrik and Project. Ask which items to save. With over 20 items, show the 20 newest and say how many more there are.

## Saving

8. Show the items picked, with what each will be saved as, and ask "Save <n> items?" with Yes and No.
9. On Yes, save each item with `ingest_document`, as `save-page` step 6 says, with these differences, since every item on a page shares its URL:
   - `title`: who it is from and what it says, such as "Ann Lee: commented on your post", at most 100 characters.
   - `path`: `web/<host>/<slug>/<date>-<item slug>.md`. The slug is the page's, made as `save-page` says. The item slug is made from the title the same way, at most 60 characters, and the date is when the item happened, as year-month-day.
   - `content`: the item's text, under `# <title>`, `Source: <url>` and `Read: <date>`.
   When `ingest_document` refuses because the file is already there, that item was saved before. Leave it, and say so at the end.
10. Link each saved item with `link_records`, with relation `mentions`, to the person, organisation and project records step 5 and step 6 found for it.
11. Close the tabs the agent opened with `tabs_close_mcp`, unless the person asked to keep them.
12. When anything was saved, end with the record `browse` describes.
