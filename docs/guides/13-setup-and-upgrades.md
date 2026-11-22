<img src="../../site/brand/favicon.svg" width="40" height="40" alt="">

# Updates, and running setup again

fabrik updates on one approval. A new release reaches your computer when Claude starts. When you next open a Code session in your `fabrik` folder, Claude says what the update brings and asks whether to update. Approve it, and Claude brings your project up to the new release. It applies fabrik's database upgrades and deploys fabrik's hosted functions that changed, then tells you what's new.

## What the update needs

When the update deploys a hosted function, it needs a Supabase access token. Claude gives you a command to run in a Terminal tab, and the command asks for the token. Make the token at supabase.com/dashboard/account/tokens, in the account that holds your fabrik project, with the shortest expiry. Paste it at the prompt, and delete it on that page once the update is done. An update that only changes the database needs no token.

The update runs only for an administrator, in the folder fabrik was set up from. fabrik applies a database upgrade only when fabrik's upgrade key signed it, and only in order. Each update is one approval, and nothing updates without it.

When the update adds a new connector tool, reconnect fabrik in Claude, in Settings, then Connectors. Claude keeps the connector's tools from when it was last connected, so a new session alone doesn't show the new tool. Then open a new session to use it. A folder signed in with `--local`, which uses fabrik without the connector, gets the new tool in its next session, with nothing to reconnect.

## Updates when Claude starts

fabrik's setup turns on updates for the fabrik marketplace, so Claude Code fetches each new release a few minutes after a session starts. To fetch one straight away, run:

```sh
claude plugin marketplace update fabrik
claude plugin update fabrik@fabrik
```

## Running setup again

Running setup again is safe. It deploys each hosted function whose files changed, and puts your sign-in page up again when its files changed. Bring fabrik's code up to date, then run setup in a Terminal tab:

```sh
cd ~/fabrik-code && git pull --ff-only
node plugins/fabrik/cli/fabrik.mjs setup --owner
```

Setup asks for a Supabase access token, which you make at supabase.com/dashboard/account/tokens. Choose the shortest expiry. If the page asks for resource access, choose **Organization**, pick the organization that holds your project, and keep the **Full access** preset. If setup stops, it says why. Put that right, and run the same command again: it carries on from the step where it stopped. Delete the token on the tokens page once setup is done.
