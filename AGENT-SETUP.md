# Setup instructions for Claude

This file is written for Claude, the agent setting fabrik up. A human setting fabrik up follows the [Set up fabrik](https://claude.ai/artifact/FYM5oNpqMeacSiUpA2JjNR) page instead.

You are the Claude Code session a human started on their home folder to set fabrik up. Do each step below yourself, in the way that fits the human's system. Give the human only the steps that need them, one at a time, and wait for each.

Before the human types a password or token in a Terminal tab, tell them that nothing will show. They type or paste it once, then press Enter. Never ask for a password or token in the chat.

1. **Prerequisites.** Check each one, and install what is missing or out of date before going on:
   - **Node.js 26.** Any other version will not do. `installCommand()` in `plugins/fabrik/cli/node-version.mjs` in this repository gives the install for each system. An install that prompts for the computer's password runs in a Terminal tab with `run_in_terminal`, where the human types it.
   - **Git.** Install it with the system's usual installer if it is missing.

   Check each one again in a new Terminal tab once it is installed.

2. **fabrik's code.** Clone this repository to a folder named `fabrik-code` in the human's home folder. If that folder contains it already, bring it up to date with a fast-forward pull.

3. **Supabase account.** Ask whether the human has one. If not, open [supabase.com/dashboard/sign-up](https://supabase.com/dashboard/sign-up) in the browser pane, and let them sign up on the Free plan.

4. **Supabase access token.** Open [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) in the browser pane. Ask the human to choose **Generate new token**, name it `fabrik setup` and choose the shortest expiry. If the form shows **Resource access**, they choose **Organization** and pick the organization that holds fabrik's project, or will hold it. A token for one project cannot create a new one. Under **Permissions** they keep the **Full access** preset, since setup creates the project, builds its database, deploys its hosted functions and changes its sign-in settings. Then they generate the token. The page's **Copy** button fails in the browser pane. They select the token and copy it with Command-C on a Mac, or Ctrl-C elsewhere.

5. **Setup.** In a Terminal tab opened with `run_in_terminal`, run `plugins/fabrik/cli/fabrik.mjs` from `fabrik-code` with Node, and the arguments `setup --owner`. Never run it with Bash: its questions need the human's typing. Read the tab with `read_terminal` and tell the human how to answer each question as it comes:
   - **Supabase access token.** Paste the token.
   - **Organisation and project.** Pick by number, or choose a new project. For a new project, setup prompts for a name and a region near them.
   - **Type 'yes'.** Setup prints the name of the project it will set fabrik up in, and continues when they type `yes`.
   - **Name, email and password.** This is their fabrik sign-in. Setup suggests their Supabase account's email, and Enter accepts it. The password is a new one, and is asked twice.
   - **Cloudflare.** A browser window opens. They sign in to Cloudflare, or make a free account, and allow Wrangler, Cloudflare's tool. Then they come back to the Terminal tab.

   Setup prints one line as each step finishes. If it stops, read why, put it right, and run the same command again: it resumes at the step where it stopped.

6. **The connector.** Setup ends with the connector's address. Tell the human to open **Settings**, then **Connectors**, in Claude, and add a custom connector named `fabrik` at that address. Give the address in a fenced code block of its own, so Claude shows a Copy button beside it. They sign in there with the fabrik email and password they chose in setup, not their Claude or Supabase login.

7. **The token.** Open the Supabase tokens page in the browser pane again, and ask the human to delete the `fabrik setup` token.

8. **Done.** Tell the human to start a new session on the `fabrik` folder in their home folder and type: What is my fabrik status?
