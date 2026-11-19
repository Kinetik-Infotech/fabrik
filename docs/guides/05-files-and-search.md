# Files and search

fabrik keeps files in each scope, and search finds them by what they say, with your records, in one question.

## Uploading a file

- **In a chat:** attach the file and ask Claude to keep it in fabrik. Claude sends its bytes through the connector, up to 6 MB.
- **In a Code session:** put the file in your `fabrik` folder and ask Claude to upload it. Claude shows you the file and where it goes before uploading.

Ask Claude to keep a file as a document, and it also saves a record about it. The record holds the file's summary and where it is kept.

## What search reads

fabrik reads the text of PDF, Word (.docx), Excel (.xlsx and .xls), OpenDocument spreadsheet (.ods), Markdown and plain text files, soon after each upload. Until then, search says the file is waiting. A scanned page with no text in it cannot be read this way.

## Searching

Ask a question in your own words, such as "What did the surveyor say about the harbour wall?". Search matches the words and the meaning together, and ranks your records and files in one list. Each answer names the record or the file, and the page or section the passage came from. Ask Claude how it found an answer, and it draws the search's graph: the sentences that matched, and what they name.

Search covers only what you may read, in every scope or in the one you name.

## Connections in your files

You can add your own Anthropic API key to fabrik. fabrik then reads the people, companies and things your files name, and how they relate, so search can follow them. Anthropic charges your key for that reading. Without a key, search still matches words and meaning.

## Saving a file to your computer

In a Code session, ask Claude to save a file from fabrik into your folder.
