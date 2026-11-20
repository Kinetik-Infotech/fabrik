---
name: public-agent
description: Use when the owner asks for a chat box on their website that answers visitors. Also use when they ask about the public agent, KNOWLEDGE.md, its keys, its daily cap or its model. Covers writing KNOWLEDGE.md with the owner, and the card where an administrator types the Anthropic API key and the Turnstile secret key. Covers the cap, and the script tag that puts the box on the website.
---

# The public agent

The public agent is a chat box on the owner's website. It answers visitors from one file, KNOWLEDGE.md, and from nothing else in fabrik. It never reads a record, a file or a search. A visitor can see anything in KNOWLEDGE.md, so only what the owner would put on their website goes in it.

fabrik's `public-agent` hosted function answers each question with Claude, through the business's own Anthropic API key. Cloudflare Turnstile checks each visitor is a person before Claude is called. fabrik keeps no question or answer, only each day's count of tokens.

Only an administrator sets it up. When `fabrik_get_actor` gives another `authority_class`, tell the person an administrator sets up the public agent, and stop.

When the connector has no `public_knowledge_get` tool, Claude connected to fabrik before the update that added it. Ask the person to reconnect fabrik in Settings, then Connectors, and then to open a new session and ask again. Opening a new session without reconnecting doesn't show the tool.

## 1. KNOWLEDGE.md

1. Call `public_knowledge_get`. When it gives text, show it and ask what to change.
2. Otherwise, ask the owner what visitors ask about: opening hours, services, prices, where to find them, how to get in touch. Read the business profile, as the `fabrik:business` skill's section 1 says, and offer what it already holds.
3. Write the file as short Markdown sections, one per subject, in the owner's words. End it with how to contact the owner.
4. Show the whole file. Save it with `public_knowledge_save` only once the owner approves it. It replaces the file before it, which isn't kept.

The file is at most 100,000 characters. Every question sends the whole file to Claude, so a shorter file costs less.

## 2. The keys, on the card

The chat box needs two keys. Both go on the card, never in the chat. When the person pastes either into the chat, tell them to delete it where they made it and make a new one for the card.

Write the steps first and show the card last, so the card sits under the steps in the chat.

1. Give the person these steps for the Anthropic API key, one numbered line each:
   1. On a Claude Max, Ultra or Team plan, claim the plan's monthly API credits first. On claude.ai, open Settings, then Billing, and under "API credits" choose Link organization. Without one of those plans, buy credits in the Claude Console under Billing.
   2. Open the Claude Console at platform.claude.com, in the organization that gets the credits.
   3. Start a new API key. Where the Console asks "Where does your code run?", choose Somewhere else, since the chat box runs on Supabase, not on this computer.
   4. Name the key fabrik website, leave Expires at Never and Scope at Default workspace, then create it and copy it. It starts `sk-ant-`, and the Console shows it only once.
   5. Paste it in the card's Anthropic API key box.
2. Then these steps for the Turnstile secret key, one numbered line each:
   1. Open dash.cloudflare.com/?to=/:account/turnstile and sign in. It opens the Turnstile page of the person's Cloudflare account. A free account is enough.
   2. Choose Add widget.
   3. For Widget name, type fabrik chat. For Region, choose Rest of World. Under Hostname management, add the website's address without `https://`, such as example.com. For Widget mode, leave Managed.
   4. Choose Create. Cloudflare shows a site key and a secret key.
   5. Paste the secret key in the card's Turnstile secret key box. Keep the site key for the line of code in section 4.
3. Call `show_public_agent_setup`. The card says which keys are saved and whether KNOWLEDGE.md is.
4. The person chooses Save. The card checks each key with Anthropic or Cloudflare before fabrik keeps it. End the turn.

This key is apart from the connections key. Saving one never turns the other on.

## 3. The cap and the model

Call `public_agent_settings` to read them. It gives `model`, `daily_cap_tokens`, `today_tokens` and `address`.

- The cap starts at 500,000 tokens a day, in UTC days. Once a day's tokens reach it, the box answers "The assistant is resting until tomorrow." and Claude isn't called. Point to anthropic.com/pricing for the rates. Never work out a price.
- Each answer counts every token Claude read and wrote, KNOWLEDGE.md included. When the last question came within five minutes, Claude reads the file from its cache. The cap counts that read at a tenth, as Anthropic charges it. Otherwise the file counts in full. So the bigger KNOWLEDGE.md is, the fewer questions a day the box answers under the cap. Tell the owner this when the file grows, or when they ask why the box rests early.
- The model starts as `claude-haiku-5-5`. Change it only when the owner asks.

Change either with `public_agent_settings_change`, once the owner approves the new value.

## 4. The box on the website

1. Copy `chat.js` from the fabrik plugin's `public-agent` folder into the session's folder, for the owner to put on their website beside its pages.
2. Give the owner this tag, with `address` from `public_agent_settings` and the Turnstile site key:

   ```html
   <div id="fabrik-chat"></div>
   <script src="chat.js" data-address="ADDRESS" data-sitekey="SITE_KEY"></script>
   ```

3. The box appears where the `div` is.

Then ask the owner to try two questions on the website: one KNOWLEDGE.md answers, and one it doesn't. The first gets the file's answer. The second says the assistant doesn't know and suggests contacting the owner.

## 5. Turning it off

The card's Turn off removes the Anthropic API key, and the box then tells visitors it can't answer. KNOWLEDGE.md and the Turnstile secret key stay. To remove the box itself, the owner takes the tag off the website.
