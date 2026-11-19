# Getting help

## How to do something

Ask Claude, such as "How do I add my calendar?". Claude answers from these guides, through fabrik's `guide` tool in any app. Ask "What guides does fabrik have?" for the list.

## When something goes wrong

In a Code session in your `fabrik` folder, say "Something's broken", and what happened. Claude writes the problem down with you:

- what you did, step by step
- what you got, each message quoted as it came
- when, and whether it happens every time

Claude leaves out passwords, keys and tokens. It saves the problem as a task in General, assigned to you, so you can follow it. It then drafts an issue for fabrik's GitHub repository, which you read and file yourself, or discard.

## Filing an issue yourself

Open github.com/Kinetik-Infotech/fabrik/issues, choose **New issue**, and give the same three parts. Leave out any password, key or token, and any other person's details.

## Problems you can fix yourself

- **Claude does not use fabrik:** check the connector is on for the chat, in the chat's tools menu.
- **A new tool is missing:** disconnect fabrik in **Settings**, then **Connectors**, and connect it again.
- **A Code session is not signed in:** Claude gives you the sign-in command. Run it, then open a new session.
- **A forgotten password:** see the guide to a forgotten password.
- **fabrik stopped answering:** your Supabase project may be paused. Restore it from the Supabase dashboard.
