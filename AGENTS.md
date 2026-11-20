# fabrik

## Writing

Load the `humanizer:translate` skill before writing anything a person reads, and follow all of its rules, not only the ones its checks catch. Run `checks.mjs` on prose and `checkPage` on a page. Software and services take the field's own verbs: Supabase and Cloudflare host, fabrik stores, setup prompts.

## The name

Write fabrik in lower case everywhere, at the start of a sentence and in a heading too. Code names such as `exposeFabrik` keep their own case.

## Buttons above the prompt

A plugin that draws buttons above the prompt draws each one as the desktop app's own button, `<Button key label onPress />`, directly in the row's `Box`. It has no `Box` around it, no background, no border, no `plain` and no `variant`. The app makes it one line tall, rounds it and gives its label a readable colour in light and dark mode. The terminal draws it as `[ label ]`.

A `Text` child with its own colour inside a `Button` and a theme's `fill-primary` and `on-primary` don't work: the desktop app ignores both.

## Tests

One run of a test proves it. Never repeat a full run to show a fix holds: write a check that fails without the fix and passes with it. A full stand-in run takes at most 2 minutes, and when it takes longer, the slow check is the thing to fix.

`sh test/stand-in/run.sh` builds a throwaway project, then runs every step side by side, each on its own copy of the build. `sh test/stand-in/run.sh <step> ...` builds and runs only the steps named, and `sh test/stand-in/run.sh --list` names the steps. To check a change, run the step that covers it.

The stand-in's clusters write their messages in English whatever the computer's language, since each check reads PostgreSQL's `ERROR:` and `NOTICE:` lines.

## The website

`site/` is fabrik.tech. Cloudflare Pages hosts it as the project `fabrik-site`, at `fabrik-site-9qo.pages.dev`, on the Cloudflare account `39fedf2a4d187eb433a593ace0656637`, which also holds the fabrik.tech domain. Deploy with Wrangler's own sign-in and `CLOUDFLARE_ACCOUNT_ID` set to that account. Wrangler keeps the account it last used in `.wrangler/cache/pages.json`, and that wins over the variable, so check it names the same account.

Deploy `site/` from `main` once its pull request merges, with `--project-name fabrik-site --branch main`, and read the live page back. When a stylesheet changes, raise the `?v=` number on its links in `site/index.html` and `site/privacy/index.html`. Browsers keep a stylesheet for four hours.
