<img src="../../site/brand/favicon.svg" width="40" height="40" alt="">

# Chat on your website

fabrik can put a chat box on your website that answers visitors' questions. It answers from one page you write, called KNOWLEDGE.md, and from nothing else in fabrik. It never reads your records, files or email. A visitor can find out anything in that page, so put in only what you'd put on your website.

To set it up, ask Claude in your fabrik folder for a chat box on your website. Claude takes you through three steps. Only an administrator can set it up.

## 1. What it knows

Claude asks what visitors ask you about, such as opening hours, services, prices, where to find you and how to get in touch. It offers what your business profile already holds. Then it writes the page in your words and shows it to you. It saves the page only once you approve it.

When the box doesn't find an answer in the page, it says it doesn't know and suggests the visitor contacts you. To change what it knows, ask Claude to change the page.

## 2. Two keys

The box needs two keys, and you paste both on a card Claude shows you, never in the chat.

- **An Anthropic API key.** Claude writes each answer, and the key pays for it. Claude gives you the steps to make one in the Claude Console. On a Claude Max, Ultra or Team plan, the plan's monthly API credits pay for it.
- **A Turnstile secret key.** Turnstile is Cloudflare's free check that a visitor is a person and not a program. Claude gives you the steps to add a Turnstile widget in your Cloudflare account. It gives you a site key for your website and a secret key for the card.

The card checks each key before fabrik keeps it.

## 3. The box on your website

Claude gives you a small file, chat.js, and two lines of code to add to your website where the box should appear. Then try two questions on your website: one the page answers, and one it doesn't.

## What it costs

Each answer uses some of your Anthropic API credits. A daily limit stops the box running up a bill: once a day's answers reach it, the box tells visitors it's resting until tomorrow. Every question sends the whole page to Claude, so a shorter page lets the box answer more questions a day. Ask Claude to raise or lower the limit.

fabrik keeps no question or answer, only how much the box used each day.

## Turning it off

Ask Claude to turn the chat box off. It removes the Anthropic API key, and the box then tells visitors it can't answer. To remove the box itself, take the two lines off your website.
