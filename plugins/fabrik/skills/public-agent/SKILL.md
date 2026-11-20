---
name: public-agent
description: Use when the owner asks for a chat box on their website that answers visitors. Also use when they ask about the public agent, its chat page, KNOWLEDGE.md, its keys, its daily cap or its model. Covers writing KNOWLEDGE.md with the owner, and putting up the chat page in the business's brand. Covers the card where an administrator types the Anthropic API key and the Turnstile keys. Covers the cap, and the line that puts the chat button on a website.
---

# The public agent

The public agent is a chat page in the business's brand, which Cloudflare Pages hosts, and a chat button that opens it from any website. It answers visitors from one file, KNOWLEDGE.md, and from nothing else in fabrik. It never reads a record, a file or a search. A visitor can see anything in KNOWLEDGE.md, so only what the owner would put on their website goes in it.

fabrik's `public-agent` hosted function answers each question with Claude, through the business's own Anthropic API key. Cloudflare Turnstile checks each visitor is a person before Claude is called. fabrik keeps no question or answer, only each day's count of tokens.

Only an administrator sets it up. When `fabrik_get_actor` gives another `authority_class`, tell the person an administrator sets up the public agent, and stop.

When the connector has no `public_knowledge_get` tool, Claude connected to fabrik before the update that added it. Ask the person to reconnect fabrik in Settings, then Connectors, and then to open a new session and ask again. Opening a new session without reconnecting doesn't show the tool.

## 1. KNOWLEDGE.md

1. Call `public_knowledge_get`. When it gives text, show it and ask what to change.
2. Otherwise, ask the owner what visitors ask about: opening hours, services, prices, where to find them, how to get in touch. Read the business profile, as the `fabrik:business` skill's section 1 says, and offer what it already holds.
3. Write the file as short Markdown sections, one per subject, in the owner's words. End it with how to contact the owner.
4. Show the whole file. Save it with `public_knowledge_save` only once the owner approves it. It replaces the file before it, which isn't kept.

The file is at most 100,000 characters. Every question sends the whole file to Claude, so a shorter file costs less.

## 2. The chat page

fabrik builds the chat page from the Brand record, with its logo, colours and fonts. With no Brand record it takes fabrik's own look. Cloudflare Pages hosts it, on the Cloudflare account fabrik's sign-in page uses.

1. Run `node ~/.claude/plugins/marketplaces/fabrik/plugins/fabrik/cli/fabrik.mjs chat-page` with Bash in the session's folder.
2. It prints the page's address, such as `https://fabrik-chat-<ref>.pages.dev`, and the line for the website. Keep both for sections 3 and 5.
3. It may ask which Cloudflare account to use, or say Cloudflare's sign-in didn't finish. Then ask the person to run the same command in a Terminal tab and answer there.

The page asks for the Turnstile site key each time it opens, so a new key needs no new page. When the Brand record changes, ask the owner whether to put the page up again in the new look. Once they approve, run the command again.

## 3. The keys, on the card

The chat box needs an Anthropic API key and two Turnstile keys. They go on the card, never in the chat. A secret key pasted into the chat is no longer secret. Tell the person to delete it where they made it, and make a new one for the card.

1. Call `show_public_agent_setup` with `page` set to the chat page's address. The card says which keys are saved and whether KNOWLEDGE.md is. It gives the steps for each key, with the page's address as the Turnstile widget's hostname.
2. When the person asks for help with a step, give that step again from these lists. On the Turnstile page, Add widget manually is the route. Set up with Spin hands the job to a coding agent and isn't used here.
3. The person chooses Save. The card checks each key with Anthropic or Cloudflare before fabrik keeps it. End the turn.

When the card has no site key box, or `public_agent_settings` gives no `turnstile_sitekey`, the project is behind the plugin. Bring it up to date with the `fabrik:update` skill first.

The Anthropic API key, in more detail:

1. On a Claude Max, Ultra or Team plan, claim the plan's monthly API credits first. On claude.ai, open Settings, then Billing, and under "API credits" choose Link organization. Without one of those plans, buy credits in the Claude Console under Billing.
2. Open the Claude Console at platform.claude.com, in the organization that gets the credits.
3. Start a new API key. Where the Console asks "Where does your code run?", choose Somewhere else, since the chat box runs on Supabase, not on this computer.
4. Name the key fabrik website, leave Expires at Never and Scope at Default workspace, then create it and copy it. It starts `sk-ant-`, and the Console shows it only once.

The Turnstile keys, in more detail:

1. Open dash.cloudflare.com/?to=/:account/turnstile and sign in. It opens the Turnstile page of the person's Cloudflare account. A free account is enough.
2. Choose Add widget manually.
3. For Widget name, type fabrik chat. Under Hostname management, type the chat page's address without `https://`, such as fabrik-chat-abc.pages.dev. The owner's own website needs no entry, since the chat runs on the chat page. For Widget mode, leave Managed.
4. Choose Create. Cloudflare shows a site key and a secret key. Both go on the card.

The Anthropic API key is apart from the connections key. Saving one never turns the other on.

## 4. The cap and the model

Call `public_agent_settings` to read them. It gives `model`, `daily_cap_tokens`, `today_tokens` and `address`.

- The cap starts at 500,000 tokens a day, in UTC days. Once a day's tokens reach it, the box answers "The assistant is resting until tomorrow." and Claude isn't called. Point to anthropic.com/pricing for the rates. Never work out a price.
- Each answer counts every token Claude read and wrote, KNOWLEDGE.md included. When the last question came within five minutes, Claude reads the file from its cache. The cap counts that read at a tenth, as Anthropic charges it. Otherwise the file counts in full. So the bigger KNOWLEDGE.md is, the fewer questions a day the box answers under the cap. Tell the owner this when the file grows, or when they ask why the box rests early.
- The model starts as `claude-haiku-5-5`. Change it only when the owner asks.

Change either with `public_agent_settings_change`, once the owner approves the new value.

## 5. The chat on the website

Give the owner the two things `chat-page` printed:

- The page's address. They can link to it from their website, an email or a social profile.
- The line for the website, `<script src="https://fabrik-chat-<ref>.pages.dev/widget.js" async></script>`. Pasted into a page, it draws a round button in the brand's colour in the bottom right corner, which opens the chat in a panel.

Some website builders, such as Wix and Squarespace on lower plans, refuse a pasted script. The page's address then works as a link instead.

Then ask the owner to try two questions: one KNOWLEDGE.md answers, and one it doesn't. The first gets the file's answer. The second says the assistant doesn't know and suggests contacting the owner.

The owner may want the chat page at their own domain, such as chat.example.com. They add it to the Pages project fabrik-chat-<ref> in Cloudflare. The Turnstile widget then needs that hostname too.

## 6. Turning it off

The card's Turn off removes the Anthropic API key, and the box then tells visitors it can't answer. KNOWLEDGE.md and the Turnstile keys stay. To remove the button, the owner takes the line off the website.
