<img src="../../site/brand/favicon.svg" width="40" height="40" alt="">

# Files and search

fabrik keeps files in each scope, and search finds them by what they say, with your records, in one question.

## Uploading a file

- **In a chat:** attach the file and ask Claude to keep it in fabrik. Claude sends its bytes through the connector, up to 6 MB.
- **In a Code session:** put the file in your `fabrik` folder and ask Claude to upload it. Claude shows you the file and where it goes before uploading.

Ask Claude to keep a file as a document, and it also saves a record about it. The record holds the file's summary and where it is kept.

## What search reads

fabrik reads the text of PDF, Word (.docx), Excel (.xlsx and .xls), OpenDocument spreadsheet (.ods), Markdown and plain text files, soon after each upload. Until then, search says the file is waiting. A scanned page with no text in it cannot be read this way.

When you replace or delete a file before search has finished reading it, fabrik stops reading the old content. The same happens to a record's older version once a newer one is saved. If the old content comes back, fabrik reads the rest of it.

## Searching

Ask a question in your own words, such as "What did the surveyor say about the harbour wall?". Search matches the words and the meaning together, and ranks your records and files in one list. Each answer names the record or the file, and the page or section the passage came from. Ask Claude how it found an answer, and it draws the search's graph: the sentences that matched, and what they name.

Search covers only what you may read, in every scope or in the one you name.

## Connections in your files

Connections are the links between the people, companies, orders and other things your files name. With connections on, fabrik reads who and what each new file mentions, and how they're linked. Each kind of thing comes from a list in your glossary, such as customer, supplier or order.

A search then follows those links. Ask about a customer, and search also finds the invoice that names the customer's director, though the invoice never names the customer.

Connections need your business's own Anthropic API key, and Anthropic charges that key for each part of a file it reads. Claude tells you how many parts are waiting before you turn connections on. See anthropic.com/pricing for the rates.

Connections are worth it when many of your files are about the same customers, suppliers, people or orders. For a handful of files, or a one-off lookup, words and meaning are enough. Without connections, search still finds files by their words and their meaning.

To turn connections on, ask Claude. Claude suggests the kinds of things for your glossary from your files' names and contents and your business profile, and saves each one you approve. Then it shows a card where an administrator types the key. The key goes from the card into your project's Vault, and never into the chat. The same card turns connections off.

fabrik reads no part until your glossary has at least one kind of thing. If the key is saved first, the card says connections are on but waiting for the glossary, and Claude suggests the kinds of things then.

To make the key:

1. On a Claude Max, Ultra or Team plan, claim the plan's monthly API credits. On claude.ai, open Settings, then Billing, and under "API credits" choose Link organization. Without one of those plans, buy credits in the Claude Console under Billing.
2. Open the Claude Console at platform.claude.com, in the organization that gets the credits.
3. Start a new API key. Where the Console asks "Where does your code run?", choose Somewhere else. fabrik's reader runs on Supabase, not on your computer.
4. Name the key fabrik, leave Expires at Never and Scope at Default workspace, then create it and copy it. It starts `sk-ant-`, and the Console shows it only once.
5. Paste it on the card and choose Save.

## Saving a file to your computer

In a Code session, ask Claude to save a file from fabrik into your folder.
