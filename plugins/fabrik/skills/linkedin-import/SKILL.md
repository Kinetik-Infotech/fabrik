---
name: linkedin-import
description: Use when a person wants their LinkedIn data in fabrik, or mentions a LinkedIn data export or a Basic_LinkedInDataExport folder. Saves the profile, the connections as contacts and the person's own posts through the connector's tools.
---

# LinkedIn import

A LinkedIn "Basic data export" is a zip of CSV files. The agent saves three of them: `Profile.csv`, `Connections.csv` and, when the export has it, `Shares.csv`, the person's own posts. It leaves the rest, such as ads, rich media and messages.

## Getting the files

- In Claude Code, the person unzips the export into the agent folder, and the agent reads each CSV with `Read`. It cannot unpack a zip, so it says so and asks the person to unzip it.
- In claude.ai or on the phone, the person attaches or pastes one CSV at a time. A connections file of several thousand rows may be too large to attach: they send a slice of it, or use Claude Code.

The connector has no bulk save. Every row is its own call, so the agent counts the rows first and says how many calls it will make.

## Whose archive

The agent asks whose export it is, and waits for the answer. When it is the person's own, nothing is added. When it belongs to someone else, the agent sets `source` on every contact and post to `linkedin, <that person's name>`, so the records say whose they are.

## Profile.csv

The profile is one row. The agent calls `profile_get`. When it answers null, it calls `profile_update` with `fields` `givenName`, `familyName` and `role` (the Headline). It then reads the profile's `record_id` with `profile_get` and calls `update_record` with `properties`: `headline`, `description` (the Summary), `industry`, `addressLocality` (Geo Location), `websites` and `twitterHandles` as lists, and `source` `linkedin`. A blank cell is left out.

When `profile_get` says the profile is left out because someone else last changed it, the agent tells the person and saves nothing.

## Connections.csv

The file starts with three lines of notes and a blank line. The header is on line 4. The columns are First Name, Last Name, URL, Email Address, Company, Position and Connected On.

1. When there are more than 100 rows, the agent asks the person to narrow them by company, position or connected-on date, and keeps only those rows.
2. For each row it calls `contact_lookup` with the email when there is one, otherwise the name. A contact found whose `properties.linkedinUrl` is the row's URL is left as it is. A found contact with the same email and no URL is the same person: the agent updates it in the next step.
3. For a new person it calls `contact_create` with `givenName`, `familyName`, `email` when there is one, `jobTitle` (Position) and `source` `linkedin`.
4. It then calls `contact_update` with `properties`: `linkedinUrl`, `company` and `connectedOn` as `YYYY-MM-DD`.

The company is kept as `company` on the contact. fabrik has no relation for working at an organisation, so no organisation records or links are made.

## Shares.csv, the person's own posts

The columns are Date, ShareLink, ShareCommentary, SharedUrl, MediaUrl and Visibility. A row with no commentary is left out.

1. For each post the agent calls `remember` with `type` `SocialPost`, `title` the first words of the commentary, `text` the commentary, and `properties` `postedAt`, `url` (ShareLink) and `source` `linkedin`. `remember` takes at most 4000 characters, so a longer post is cut there, and the agent says which.
2. It calls `voice_tag_content` with `records` set to the saved `record_id`s, 50 at a time, `format` `social-post` and `mode` `human-only`, so the voice tools learn from them.
3. It calls `link_records` on the archive owner's contact, found with `contact_lookup` and made with `contact_create` when there is none, with an `authored` link to each post, up to 200 in a call.
4. It offers `voice_distil_profile`, and runs it only when the person says yes.

## Before and after

Before the first save the agent tells the person what it will save: the counts per file, and the first three rows. One approval covers the import as told. A change to it, such as a wider filter, is told again.

After each file the agent reads a saved record back with `get_record` and gives the counts: saved, found and left as they were, and refused with fabrik's own message.

An import run again with a wider filter saves only the people it has not seen.
