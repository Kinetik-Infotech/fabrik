<img src="../../site/brand/favicon.svg" width="40" height="40" alt="">

# fabrik in each Claude app

You add fabrik's connector once, in Claude's settings, and it then works in every Claude app signed in to the same Claude account.

## The connector

Setup ends with the connector's address. In Claude, open **Settings**, then **Connectors**, and add a custom connector named `fabrik` at that address. Claude opens your sign-in page. Sign in with your fabrik email and password, then choose **Allow**.

The connector gives Claude fabrik's tools: records, files and search, projects, tasks, contacts, routines, email and the cards that draw records, boards and graphs.

## claude.ai and the phone app

At claude.ai and in the Claude phone app, ask in a chat, such as "What did I note about the Harbour survey?". Claude calls fabrik's tools and shows you each change before saving it. If Claude does not use fabrik, turn the connector on for that chat in the chat's tools menu.

The phone app uses the connectors you added at claude.ai or in the desktop app. You add a custom connector from a computer.

## The desktop app

The desktop app has the same chats. Its **Code** tab also runs Claude Code in a folder on your computer. Setup made a `fabrik` folder in your home folder, signed in as you. A Code session in that folder has fabrik's assistant and the fabrik plugin, which add:

- uploading files from the folder, and saving files fabrik holds into it
- drawing boards and graphs as pages, and printing PDFs
- analysis, charts and live Excel workbooks
- imports from LinkedIn, Notion, Obsidian, Substack and X
- the routine skills, getting started and support

## fabrik without the connector

Some Claude teams don't let their members add a custom connector. You can still use fabrik in a Code session in the desktop app. The fabrik plugin runs a local connector on your computer. It signs in to your fabrik with the sign-in saved in your folder, and passes each of Claude's calls on to your fabrik. Claude gets the same tools and cards as through the connector.

To turn it on, say no when setup asks whether you can add a custom connector. To turn it on later, run this in a Terminal tab, with your own folder:

```sh
node ~/.claude/plugins/marketplaces/fabrik/plugins/fabrik/cli/fabrik.mjs sign-in --folder ~/fabrik --local
```

Then open a Code session in that folder. The local connector works only in a folder signed in with `--local`, so a folder that has the connector doesn't show each tool twice. claude.ai, the phone app and Cowork can't reach fabrik this way. Mail checks and the rest of fabrik's work in Supabase carry on as before. A change to fabrik's tools reaches you with the next plugin update, with nothing to reconnect.

## A change to the connector

When fabrik's tools change, Claude keeps the tool list it read when you connected. In **Settings**, then **Connectors**, disconnect fabrik and connect it again to read the new list.
