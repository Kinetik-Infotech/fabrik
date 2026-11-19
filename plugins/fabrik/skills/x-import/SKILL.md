---
name: x-import
description: Use when a person wants their X or Twitter posts in fabrik, or mentions an X archive, a Twitter archive, tweets.js or an "Archive of" folder. Saves their tweets as one document for each month, tagged as their writing, through the connector's tools.
---

# X import

X's "Download an archive of your data" is a zip. Its `data` folder holds `tweets.js` (or `tweets-part0.js` and more), which is JavaScript, not JSON: it starts with `window.YTD.tweets.part0 = ` and then a JSON list. `account.js` names the account. Direct messages are in `direct-messages.js`, which this skill does not import.

## Getting the files

- In Claude Code, the person unzips the archive into the agent folder, and the agent reads `account.js` and the tweets file with `Read`, in parts, since the file is large. It cannot unpack a zip or run a program, so it says so and asks the person to unzip it. The agent reads the list itself and writes the months out as text.
- In claude.ai or on the phone, `tweets.js` is usually too large to attach. The person attaches a slice, or pastes the tweets they want, or uses Claude Code.
- Pictures and videos are not imported. `ingest_document` takes the content in the call, up to 6 MB, so it takes only text. The raw `tweets.js` is not saved either; the months below are.

A big archive costs a lot to read, since the agent reads every tweet it keeps. Above 2000 tweets it asks the person to narrow them to a range of years, and keeps only those.

## Before the first save

The agent reads `account.js` and asks the person to confirm the handle is theirs. It tells them what it will save: the handle, the years, the number of tweets and months, and the first three lines. One approval covers the import as told.

## Tweets

1. The agent checks that the file starts with `window.YTD.tweets.part`. Without it, the agent stops and says the file is not an X archive, and never reads on.
2. It keeps the person's own tweets and replies, from each item's `tweet` (`created_at`, `full_text`, `in_reply_to_screen_name`, `id_str`). It leaves out retweets, whose text starts with `RT @`, since they are not the person's writing, and counts them.
3. It groups them by month, oldest first, and writes each month as one text: a line for each tweet, with its date and time, then its text. A reply is marked `replying to @handle`.
4. For each month it calls `lookup_by_name` with the title `@handle tweets 2024-03`, and reads each match with `get_record`. A match whose `properties.month` and `handle` agree is already imported and is left alone. Otherwise it calls `ingest_document` with `path` `x/<handle>/2024-03.md`, `content` the month's text, `title` that title, and `properties`: `handle`, `month`, `tweetCount`, `body` (the whole text) and `source` `x`. Without `body`, the voice tools would read only the first 1000 characters, the summary.
5. It calls `voice_tag_content` with `records` set to the saved `record_id`s, 50 at a time, `format` `social-post` and `mode` `human-only`.
6. It calls `link_records` on the person's own contact, found with `contact_lookup` and made with `contact_create` when there is none, with an `authored` link to each month, up to 200 in a call.
7. It offers `voice_distil_profile`, and runs it only when the person says yes.

## The people they mention

The agent lists the handles the tweets mention or reply to, most often first, the top 20, and asks which the person wants as contacts. It never makes one it was not told to. For each, `contact_lookup` by name, and then, when none is found, `contact_create` with `name` `@handle` and `source` `x`, then `contact_update` with `properties` `xHandle`. It then calls `link_records` on each month that names the handle, with a `mentions` link to the contact. The month and the contact must be in the same scope.

## After

The agent reads a saved month back with `get_record`, and gives the counts: months, tweets, retweets left out, contacts, links, left as they were, and refused, each with fabrik's own message. Run again with a newer archive, it saves only the months it has not seen. The latest month of an earlier import may be incomplete: the agent tells the person, and does not change it.
