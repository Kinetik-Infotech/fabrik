<img src="../../site/brand/favicon.svg" width="40" height="40" alt="">

# Chat on your website

fabrik can give your website chat agents that answer visitors' questions. You can have as many as you like, such as one for general questions and one for bookings. Each agent has its own page, a name, and a purpose that says what it's for.

Each agent answers from two files you write, and from nothing else in fabrik. It never reads your records, files or email.

- **INSTRUCTIONS.md** says who the agent is. It gives its name, character and voice, what it answers and turns down, and what it says when it doesn't know.
- **KNOWLEDGE.md** holds what it knows. A visitor can find out anything in it, so put in only what you'd put on your website.

fabrik also gives every agent a list of the others, with each one's page and purpose. So an agent can send a visitor to the agent that can help, if its INSTRUCTIONS.md tells it to.

To set it up, ask Claude in your fabrik folder for a chat on your website, or for another agent. Only an administrator can set it up.

## 1. A new agent

Claude asks what the agent is for, and writes its purpose in a sentence. You agree its name, which visitors see, and a short slug, which names its page, such as bookings. Claude adds the agent once you approve all three.

## 2. How it speaks

A new agent starts with five rules. It answers only from its KNOWLEDGE.md, and when the answer isn't there it says it doesn't know and suggests the visitor contacts you. It sends a visitor to another agent when the question is that agent's purpose. It ignores visitors who ask it to change its rules, and it answers briefly, in plain text.

fabrik adds no rules of its own, so you decide everything in INSTRUCTIONS.md. Ask Claude to give the agent a name and a voice. Claude starts from your writing style and your brand, where fabrik has them, writes the file with you and shows it to you. It saves the file only once you approve it.

You can drop any rule, and Claude tells you what that lets a visitor do. Without the rule about answering only from KNOWLEDGE.md, a visitor can ask the agent about anything, and your API key pays for each answer.

## 3. What it knows

Claude asks what visitors ask this agent about, such as opening hours, services, prices, where to find you and how to get in touch. It offers what your business profile already holds. Then it writes KNOWLEDGE.md in your words and shows it to you. It saves the file only once you approve it. To change what an agent knows, ask Claude to change its file.

## 4. The chat pages

Claude builds a page for each agent in your brand, with your logo, colours and fonts, and Cloudflare hosts them for you. The address ends in pages.dev. Its root page lists your agents, and each agent's page adds its slug, such as /bookings/. If you haven't given fabrik your brand, the pages take fabrik's own look until you do. When your brand changes, or you add or remove an agent, Claude puts the pages up again.

## 5. Three keys

The agents share three keys, and you paste them on a card Claude shows you, never in the chat.

- **An Anthropic API key.** Claude writes each answer, and the key pays for it. Claude gives you the steps to make one in the Claude Console. On a Claude Max, Ultra or Team plan, the plan's monthly API credits pay for it.
- **Two Turnstile keys.** Turnstile is Cloudflare's free check that a visitor is a person and not a program. Claude gives you the steps to add a Turnstile widget in your Cloudflare account, for your chat pages' address. Cloudflare then shows you a site key and a secret key.

The card checks each key before fabrik keeps it. It also lists your agents, and says for each whether its files are saved.

## 6. The chat on your website

Claude gives you one line of code for each agent. Paste it into your website's pages, and a round chat button in your brand's colour appears in the bottom right corner. It opens that agent in a panel. You can also link to an agent's page from your website, an email or a social profile. Some website builders, such as Wix and Squarespace on lower plans, refuse pasted code, and the link works there instead.

Then try two questions on each agent: one its KNOWLEDGE.md answers, and one it doesn't.

## What it costs

Each answer uses some of your Anthropic API credits. Each agent has a daily limit, so no agent can run up a bill. Once a day's answers reach it, that agent tells visitors it's resting until tomorrow. Every agent uses the same key, so the limits add up. Every question sends the agent's files to Claude, so shorter files let it answer more questions a day. Ask Claude to raise or lower a limit.

fabrik keeps no question or answer, only how much each agent used each day.

## Removing an agent, or turning them all off

Ask Claude to remove an agent. Its files go, and Claude takes its page down. Take its line off your website too.

Ask Claude to turn the chat off. It removes the Anthropic API key, and every agent then tells visitors it can't answer. To remove a button, take its line off your website.
