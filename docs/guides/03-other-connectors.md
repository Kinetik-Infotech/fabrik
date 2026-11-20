<img src="../../site/brand/favicon.svg" width="40" height="40" alt="">

# Adding other connectors in Claude

A connector links Claude to another service, such as Gmail, Google Calendar, Google Drive, Slack or Notion. Once you add one, Claude can use it in the same chat or session as fabrik. It reads from one and saves to the other, such as tomorrow's meetings saved as a note in fabrik.

This guide was written for the Claude desktop app 5.11492.5 and claude.ai. Claude's settings can move between versions.

## A connector from Claude's directory

1. In Claude, open **Settings**, then **Connectors**.
2. Choose **Browse connectors**, and find the service, such as Google Calendar.
3. Choose **Connect**, and sign in to the service in the window that opens. The service asks you what Claude may read and change.

A connector you add at claude.ai or in the desktop app also works in the phone app. Some connectors need a paid Claude plan, and the directory says which.

## A custom connector

A service that is not in the directory may publish its own connector address, as fabrik does. In **Settings**, then **Connectors**, choose **Add custom connector**, give it a name and the address, and sign in when Claude asks.

## What Claude can do with each

What Claude can do with a connector depends on that service's tools, which its entry in the directory lists. With fabrik beside it, Claude can:

- read your calendar, and save a meeting's notes or its actions as records and tasks
- find an email or a document, and keep it as a file in fabrik with its record
- read a shared drive's files, and save a summary of each in fabrik
- answer a question from the service and fabrik together, naming which said what

fabrik's assistant acts in another service only while you are in the session, and only for something you asked for. Before anything that sends, pays, books or deletes, it says exactly what it will do and waits for you to approve that one step.

## A connector in a Code session

A Code session in the desktop app reads your connectors when it opens. After you add one, open a new session in your `fabrik` folder to use it there.

When you ask Claude to design a better way to run a routine, it suggests connectors that would fit your business. See the routines guide.
