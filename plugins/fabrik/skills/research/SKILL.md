---
name: research
description: Use when the person asks the agent to find something out on the web, such as "find out what the new rules on short lets say" or "look into this supplier". Reads public pages in the built-in browser, answers with each claim's source, and saves each source it relied on in fabrik.
---

# Researching a question

Load `fabrik:browse` first. Its rules hold for every step here.

## Reading

1. Check what fabrik already holds first, with `search` for the question's subject. Say what it found, apart from what the web says.
2. Use the built-in browser. Open a search page with `preview_start` and its `url`, then open the most relevant results with `navigate`, and read each with `get_page_text`.
3. Prefer the source closest to the fact: the law's own text, the company's own site, the official statistics. Note each page's URL and when it was read.
4. Stop when three sources agree, or when the answer is clear from one primary source. Say where they disagree.

## Answering

5. Answer the question first, in a few sentences. Mark each claim with a link to the page it came from. A claim no page supports is left out.
6. Keep what fabrik holds apart from what the web says, and name which is which.

## Saving

7. Ask "Save the <n> sources this answer used?" with Yes and No. On Yes, save each page the answer relied on with `save-page`.
8. End with the record `browse` describes, with each page read and the answer as the outcome.
