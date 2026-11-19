# Costs and limits

fabrik itself is free and open source. You pay for the services it runs on, on your own accounts.

## What each service charges

- **Supabase** hosts your database, files and functions. fabrik runs on its Free plan. A paid plan raises the limits on storage, file size and use. See supabase.com/pricing.
- **Cloudflare** hosts your sign-in page on Cloudflare Pages, which has a free plan. See cloudflare.com/plans.
- **Claude** is your Claude plan. Some connectors and features, such as Claude Code, need a paid plan. See claude.com/pricing.
- **Anthropic**, only if you turn connections on, so fabrik reads the people and things your files name. Anthropic charges your own API key for each part of a file it reads. See anthropic.com/pricing.

## Limits

- A file sent through the connector in a chat is at most 6 MB. A larger one goes in from a Code session.
- Supabase's Free plan takes files up to 50 MB each, and limits the database's size and the project's storage.
- Supabase pauses a Free plan project after a week with no activity. Restore it from the Supabase dashboard, and your data is kept.
- Search reads a file's text soon after its upload, not at once. A large file takes longer.
- A tool gives at most 100 records in one answer, and Claude asks for the next page when there are more.

Supabase's dashboard shows your project's use, under **Usage** in your organisation's settings.
