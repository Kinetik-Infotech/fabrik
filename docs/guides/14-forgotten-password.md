<img src="../../site/brand/favicon.svg" width="40" height="40" alt="">

# A forgotten password

Your Supabase account has full access to your project, so you can always set a new fabrik password from it.

1. Open your project in the Supabase dashboard, at supabase.com/dashboard, then **Authentication**, then **Users**.
2. Choose your own user, and **Send password recovery**.
3. Open the email's link. Your sign-in page opens with a field for a new password.

Then sign in again where fabrik asks: in Claude's connector, and in your `fabrik` folder with:

```sh
node ~/.claude/plugins/marketplaces/fabrik/plugins/fabrik/cli/fabrik.mjs sign-in --folder ~/fabrik --email <your email>
```

Never give a password to Claude in a chat. Claude never asks for one.
