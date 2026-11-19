---
name: obsidian-import
description: Use when a person wants their Obsidian vault in fabrik, or mentions Obsidian notes, a vault folder, wikilinks or daily notes. Saves each note as a document and its wikilinks as links through the connector's tools.
---

# Obsidian import

A vault is a folder of `.md` notes. A note may start with a frontmatter block between two `---` lines, with `aliases`, `tags`, `date` or `created`. A link to another note is `[[Note]]`, `[[Note#Heading]]` or `[[Note|shown text]]`. The `.obsidian`, `.trash` and `.git` folders are not notes.

## Getting the files

- In Claude Code, the person puts the vault, or the folders they want, in the agent folder. The agent finds the notes with `Glob` and reads them with `Read`. It cannot unpack a zip, so it asks the person to unzip it.
- In claude.ai or on the phone, the person attaches or pastes notes one at a time. A vault cannot be brought across this way: the agent says so and suggests Claude Code, or a few notes.
- Embedded pictures and PDFs are not imported. `ingest_document` takes the content in the call, up to 6 MB, so it takes only text files. A note's embed stays in its text.

The connector has no bulk save. Every note is its own call, so the agent counts the notes and says how many calls it will make. Above 100 notes it asks the person to narrow them: by folder, by a tag in the frontmatter, or by modified date, and keeps only those. A note is also left out when it is empty.

## Before the first save

The agent tells the person what it will save: the number of notes, the filter, and the first three titles. One approval covers the import as told.

## Notes

For each note the agent calls `lookup_by_name` with the title, which is the file name without `.md`. A match whose `properties.obsidianPath` is the note's path, read with `get_record`, is already imported and is left alone. For any other note it calls `ingest_document`:

- `path` `obsidian/<vault name>/<the note's path in the vault>`.
- `content` the note, frontmatter included. A note is text, so the agent sends it as text.
- `title` the file name, and `properties` `obsidianPath`, `tags`, `aliases`, `noteDate` and `source` `obsidian`.

`noteDate` is the frontmatter `date` or `created` when it starts with a date. Failing that, it is the file name when it is exactly `YYYY-MM-DD`. Other notes have none.

Two notes with one title in different folders are two records. They are told apart by `obsidianPath`.

## Wikilinks

After every note is saved, so that each link has its target, the agent makes the links, one `link_records` call for each note with links, up to 200 to a call, relation `mentions`:

- A link to a note in the import goes to that note's `record_id`. A title two notes share is ambiguous: the agent asks the person which one.
- A link to a person in the person's contacts goes to that contact. The agent finds it with `contact_lookup` by name. When a link matches both a note and a contact, it asks the person which one was meant.
- A link to nothing is left out, and counted. fabrik has no empty placeholder records.
- The heading after `#` goes in `locator`, and the shown text in `note`.
- Code blocks are not read for links.

Tags stay in `properties.tags`. fabrik makes no tag records.

## After

The agent reads a saved note back with `get_record`, and gives the counts: notes, links by kind, links left out, left as they were, and refused, each with fabrik's own message. Run again, it saves only the notes it has not seen. A note that changed in the vault is not updated: the agent tells the person which ones changed.
