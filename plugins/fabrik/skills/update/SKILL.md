---
name: update
description: Use at the start of a session for an administrator, and when the person asks whether fabrik is up to date or to update it. It finds what the person's fabrik project is missing from the installed plugin, and offers the update once with what it brings. On approval it applies the database upgrades and deploys the hosted functions that changed. It then offers to set up sending for each mailbox that only reads.
---

# Updating fabrik

A new fabrik release reaches the computer when Claude starts. The person's project catches up only when an administrator approves the update. This skill finds what is behind, offers the update, and applies it.

This skill runs only as fabrik's assistant, `fabrik:assistant`, in the folder setup was run in, which holds `.fabrik-setup-project.json`. Run the fabrik command as the assistant's "The connector's tools" says:

```sh
node ~/.claude/plugins/marketplaces/fabrik/plugins/fabrik/cli/fabrik.mjs update --check
```

## 1. Find what is behind

At the start of a session, once `fabrik_get_actor` gives `authority_class` `administrator`, run `update --check`. It answers:

- `behind`: whether there is anything to update.
- `upgrades`: each database upgrade the project doesn't hold, with `about`, its own sentence about what it changes. `null` when the project's upgrade function is too old to say. The update finds out as it goes.
- `functions`: the name of each hosted function whose files changed.
- `unsigned`: upgrades that came with no signature. Name them to the person as a problem with the release, and leave them out.

With `behind` false, say nothing about updates. With no `.fabrik-setup-project.json` in the folder, say nothing either: this folder isn't the one fabrik was set up from. When `update --check` refuses, tell the person what it said, and make no offer.

## 2. Offer it once

Tell the person, in one or two sentences, what the update brings, from each upgrade's `about` and the functions that changed, in plain words. Then ask in the next-step box "Update fabrik now?", with Update and Not now. Offer it once per session. On Not now, carry on with their request.

## 3. Apply it

`update --apply` applies the whole update. It deploys fabrik-upgrade first when it changed, then applies the upgrades in order, then deploys the other functions that changed. It deploys each function from the files on the person's computer, and records it in `.fabrik-setup-project.json`. It stops at the first failure and says what failed.

- **No function changed.** Run `update --apply` yourself. It asks for nothing.
- **A function changed.** Deploying it needs a Supabase access token, which the person pastes at a hidden prompt in a Terminal tab. Give them these two lines exactly, with the folder's full path, and stop until they say it has finished:

```sh
cd <the folder's full path>
node ~/.claude/plugins/marketplaces/fabrik/plugins/fabrik/cli/fabrik.mjs update --apply
```

Tell them the command asks for a token, says where to make it, and says to delete it once the update is done. Never ask for the token in the chat, and never accept one that is offered.

When it stops, tell the person what it said, and that running the same command again carries on from where it stopped.

Run `update --check` again at the end. It must answer `behind` false. Then tell the person what's new in fabrik, in one or two sentences. When a connector tool was added or changed, ask them to open a new session to use it.

## 4. Sending for a mailbox that only reads

After an update that brings sending, call `mail_list_mailboxes`. For each mailbox with no `smtp_host`, offer once to set up sending. On approval, call `show_mail_setup` with the mailbox's `name` alone. The card fills in its saved settings and the sending server for its provider, and the person types the password.
