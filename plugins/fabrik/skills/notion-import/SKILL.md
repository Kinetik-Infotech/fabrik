---
name: notion-import
description: Use when a person wants their Notion workspace in fabrik, or mentions a Notion export, an Export-*.zip folder or Markdown & CSV pages. Saves pages as documents and people, companies, projects and tasks from databases, through the connector's tools.
---

# Notion import

A Notion "Export all workspace content" in Markdown & CSV format is a folder of pages. A page is `Title <32 hex characters>.md`. A page with children has a folder of the same name beside it. A database is a `.csv` with a folder of the same name that holds one `.md` per row, its columns at the top of each file. The 32 characters are the page's Notion id.

## Getting the files

- In Claude Code, the person unzips the export into the agent folder. The agent finds the pages with `Glob` and reads them with `Read`. It cannot unpack a zip, so it says so and asks the person to unzip it.
- In claude.ai or on the phone, the person attaches or pastes pages one at a time. A workspace cannot be brought across this way: the agent says so and suggests Claude Code, or a few pages.
- Pictures, PDFs and other attachments are not imported. `ingest_document` takes the content in the call, up to 6 MB, so it takes only text files. A page's link to an attachment stays in its text.

The connector has no bulk save. Every page is its own call, so the agent walks the folder, counts the pages and rows, and says how many calls it will make. Above 200 pages or 500 rows it asks the person to narrow them: by a top-level folder, by database name, or by last edited date, and keeps only those.

## Before the first save

The agent asks for a short label for the workspace, such as Rubytech ops, and tells the person what it will save: the counts, and the first three pages. One approval covers the import as told.

## Pages

For each page the agent calls `lookup_by_name` with the title. A match whose `properties.notionId` is the page's id, read with `get_record`, is already imported and is left alone. For any other page it calls `ingest_document`:

- `path` `notion/<workspace label>/<the page's folders>/<title>.md`, with the ids taken off the names.
- `content` the page's text, with the properties block at the top taken out. The agent sends only text and never a base64 file.
- `title` the page's title, and `properties` `notionId`, `parentNotionId` (the enclosing page's id, or none at the top), `workspace`, `createdAt`, `lastEditedAt`, `createdBy` and `source` `notion`.

fabrik has no relation for a page that holds another page, so the tree is kept in `parentNotionId` and in the path. An administrator who wants one adds it with `save_relation_type`.

Pages are not tagged as the person's own writing: a workspace holds other people's.

## Database rows

The agent picks the tool from the database's name and columns, and asks when it is unsure:

| Database | Tool |
|---|---|
| People, contacts or team, with an email or phone column | `contact_create` |
| Companies or organizations | `contact_create` with `type` `Organization` |
| Projects | `project_create`, with `due` from a due date column |
| Tasks or to-dos | `task_create`, with `project` when a column names one, and `due` |
| Anything else | `ingest_document`, as a page, with the columns in `properties` |

For a contact the agent calls `contact_lookup` first, by email or name, and leaves one it finds. Columns with no field of their own go in `properties` under their own names: `contact_update` for a contact, `properties` on `project_create` and `task_create`, with `notionId` among them.

## People and links

- A person named in a page, by a link or an `@` mention, is matched with `contact_lookup`. When one contact matches, the agent calls `link_records` on the page with a `mentions` link to it. When none or several match, it asks the person, and never makes a contact on its own.
- A column that relates one row to another becomes a `link_records` link from the first row's record to the second's. Use `mentions`, and put the column's name in `note`. Links are made after every record is saved, since the target must exist. Both records must be in the same scope.
- A page's author, when the person says it is a contact, is linked with `authored` from the contact to the page.

## After

The agent reads a saved page back with `get_record`, and gives the counts: pages, rows by tool, links, left as they were, and refused, each with fabrik's own message. Run again, it saves only what it has not seen. A page that changed in Notion is not updated; the agent tells the person which ones changed.
