<img src="../../site/brand/favicon.svg" width="40" height="40" alt="">

# Chat on your website

fabrik can give your website a chat that answers visitors' questions. It answers from one file you write, called KNOWLEDGE.md, and from nothing else in fabrik. It never reads your records, files or email. A visitor can find out anything in that file, so put in only what you'd put on your website.

To set it up, ask Claude in your fabrik folder for a chat on your website. Claude takes you through four steps. Only an administrator can set it up.

## 1. What it knows

Claude asks what visitors ask you about, such as opening hours, services, prices, where to find you and how to get in touch. It offers what your business profile already holds. Then it writes the file in your words and shows it to you. It saves the file only once you approve it.

When the chat doesn't find an answer in the file, it says it doesn't know and suggests the visitor contacts you. To change what it knows, ask Claude to change the file.

## 2. The chat page

Claude builds a chat page in your brand, with your logo, colours and fonts, and Cloudflare hosts it for you. Claude gives you its address, which ends in pages.dev. If you haven't given fabrik your brand, the page takes fabrik's own look until you do. When your brand changes, Claude offers to put the page up again in the new look.

## 3. Three keys

The chat needs three keys, and you paste them on a card Claude shows you, never in the chat.

- **An Anthropic API key.** Claude writes each answer, and the key pays for it. Claude gives you the steps to make one in the Claude Console. On a Claude Max, Ultra or Team plan, the plan's monthly API credits pay for it.
- **Two Turnstile keys.** Turnstile is Cloudflare's free check that a visitor is a person and not a program. Claude gives you the steps to add a Turnstile widget in your Cloudflare account, for your chat page's address. Cloudflare then shows you a site key and a secret key.

The card checks each key before fabrik keeps it.

## 4. The chat on your website

Claude gives you one line of code. Paste it into your website's pages, and a round chat button in your brand's colour appears in the bottom right corner. It opens the chat in a panel. You can also link to the chat page's address from your website, an email or a social profile. Some website builders, such as Wix and Squarespace on lower plans, refuse pasted code, and the link works there instead.

Then try two questions: one KNOWLEDGE.md answers, and one it doesn't.

## What it costs

Each answer uses some of your Anthropic API credits. A daily limit stops the chat running up a bill: once a day's answers reach it, the chat tells visitors it's resting until tomorrow. Every question sends the whole file to Claude, so a shorter file lets the chat answer more questions a day. Ask Claude to raise or lower the limit.

fabrik keeps no question or answer, only how much the chat used each day.

## Turning it off

Ask Claude to turn the chat off. It removes the Anthropic API key, and the chat then tells visitors it can't answer. To remove the button, take the line off your website.
