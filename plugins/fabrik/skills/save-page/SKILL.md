---
name: save-page
description: Use when the person asks to save, keep or clip the web page in front of them, or a page they name, in fabrik, such as "save this page" or "keep this profile". Saves the page's text as a Web page record with its title, URL and date, which search then finds. It links it to the people and projects it names that fabrik already holds.
---

# Saving a page

Load `fabrik:browse` first. Its rules hold for every step here.

## Reading the page

1. Find the page. When the person means the page they are on, it is the tab in front. In Claude in Chrome that is the active tab in `tabs_context_mcp`, and in the built-in browser the fronted tab in `tabs_context`. A page the person names by its address is opened in a new tab, in the browser `browse` picks.
2. Read it with that browser's `get_page_text`. Keep the page's main text, and leave out menus, cookie banners, footers and advertisements.
3. Take the title from the page's own title. When it has none, take its first heading, and with no heading either, the last part of its URL.

## Finding what it names

4. For each person the page names, call `contact_lookup` with `name`. For each project or organisation, call `lookup_by_name`, and call `project_list` for the person's open projects. Keep only the records found: the agent creates no person or project from a page.

## Saving

5. Show the person the title, the URL, the first lines of the text and the records it will link to. Ask "Save <title>?" with Yes and No.
6. On Yes, call `ingest_document` with:
   - `path`: `web/<host>/<slug>.md`. The slug is the URL's path and query, without the host. Write it in lower case, keep only the letters a to z and the digits, and put one hyphen for each run of other characters. Drop hyphens at either end, and keep at most 80 characters. A URL with no path has the slug `index`. The same URL then always gives the same file.
   - `content`: Markdown. A first line `# <title>`, then `Source: <url>` and `Read: <date>`, then the main text.
   - `title`: the title. `type`: `Web page`.
   - `summary`: what the page is and what it says, in two or three sentences.
   - `properties`: `url`, `retrieved` (the date and time it was read), `site` (the host) and `source` `web`.
7. Link the saved record with `link_records`: one link with relation `mentions` to each record step 4 found.
8. Say what was saved and what it links to. A page saved within a larger task is listed in that task's record, as `browse` says.

When `ingest_document` refuses because a file is already at that path, the same URL was saved before, whatever its title was then. Say so, and ask whether to replace the saved copy, with Yes and No. On Yes, call it again with `overwrite` `true`.
