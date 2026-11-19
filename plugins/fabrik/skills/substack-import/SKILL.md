---
name: substack-import
description: Use when a person wants their Substack posts in fabrik, or mentions a Substack export, posts.csv or a subscribers list. Saves each post as a document tagged as the person's writing, and the subscribers as contacts, through the connector's tools.
---

# Substack import

Substack's "Export your data" is a zip. It holds `posts.csv`, a `posts` folder with one `<post_id>.<slug>.html` per post, and `subscribers.csv`. It may also hold a file of email activity, which the agent does not read.

## Getting the files

- In Claude Code, the person unzips the export into the agent folder, and the agent reads the files with `Read`. It cannot unpack a zip, so it says so and asks the person to unzip it.
- In claude.ai or on the phone, the person attaches or pastes a post, or `posts.csv` or `subscribers.csv`, one at a time. Posts cannot be brought across by the hundred this way: the agent says so and suggests Claude Code.
- Images are not imported. `ingest_document` takes the content in the call, up to 6 MB, so it takes only text files. A post's image links stay in its text.

The connector has no bulk save. Every post and every subscriber is its own call, so the agent counts them and says how many calls it will make. Above 200 posts or 2000 subscribers it asks the person to narrow them: by published date, or by subscriber type free, paid or comp, and keeps only those. It asks first whether the subscribers are wanted at all.

## Before the first save

The agent asks for the publication's name, and whether every post was written by the person. It tells the person what it will save: the counts, the filter, and the first three titles. One approval covers the import as told.

## Posts

Only rows of `posts.csv` with `is_published` true and `type` newsletter, podcast or thread are posts. A post with no body file is left out, and counted. For each one, `lookup_by_name` with the title. A match whose `properties.substackPostId` is the row's `post_id`, read with `get_record`, is already imported and is left alone. Otherwise:

1. The agent turns the HTML into Markdown: headings, paragraphs, lists, quotes, code, links and emphasis. Images become their link.
2. It calls `ingest_document` with `path` `substack/<publication>/<slug>.md`, `content` the Markdown, `title` the post's title, and `properties`: `substackPostId`, `publication`, `publishedAt` (`post_date`), `subtitle`, `isPaid` (true unless `audience` is everyone), `body` (the whole Markdown) and `source` `substack`. Without `body`, the voice tools would read only the first 1000 characters of the post, its summary.
3. For the posts the person wrote, it calls `voice_tag_content` with `records` set to the saved `record_id`s, 50 at a time, `format` `article` and `mode` `human-only`. A post the person did not write is left untagged.
4. For the same posts, it calls `link_records` on the person's own contact, found with `contact_lookup` and made with `contact_create` when there is none, with an `authored` link to each post, up to 200 in a call.
5. It offers `voice_distil_profile`, and runs it only when the person says yes.

## Subscribers

For each row of `subscribers.csv` with an email, the agent calls `contact_lookup` with the email and leaves a contact it finds. Otherwise it calls `contact_create` with `email`, `givenName` and `familyName` (the name split at the first space; both left out when there is no name), `source` `substack` and `status` the subscription type, then `contact_update` with `properties` `publication`, `subscribedAt` and, when the row has it, `unsubscribedAt`.

Subscribers are contacts and are not linked to the posts: fabrik has no subscription relation. Email activity is not read.

## After

The agent reads a saved post back with `get_record`, and gives the counts: posts, tagged, subscribers, left as they were, and refused, each with fabrik's own message. Run again, it saves only what it has not seen. A post edited since is not updated: the agent tells the person which ones changed.
