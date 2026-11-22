<img src="site/brand/favicon.svg" width="56" height="56" alt="">

# fabrik

**Everything an AI assistant promises. Nothing it shouldn't keep.**

fabrik helps you run your life or business just like Grok Bot, Muse, Dots, Instinct or Duet. But all your valuable data remains under your sole control. It's free and open source.

Most assistants keep your data on their makers' servers, for those companies to use and profit from. With fabrik you own it, control it and can take it anywhere.

## What it does for you

- **Memory.** Tell Claude about a person, meeting or decision once, and fabrik stores it. Ask for it months later, in your own words.
- **Updates.** Ask what's new on LinkedIn or any site you're signed in to, and get the short version, with people you know picked out.
- **Email.** Find that message from your accountant while you're out, and reply to it. fabrik reads your mail, and sends only what you approve.
- **WhatsApp.** Ask what someone said on WhatsApp, and Claude finds it in fabrik. The WhatsApp plugin links to your WhatsApp as a device and saves each chat in your private scope. When you link it, you choose whether it brings in your recent chats too. It only reads and never sends, because Meta, which owns WhatsApp, bans numbers that send automated messages from anything but its paid business service.
- **Content.** Posts, proposals and replies that sound like you, because they're drafted from what you've already written.
- **Planning.** Tell Claude what you're working on and what's holding things up, and Claude lists what you can get on with next.
- **Networking.** Before a call, ask who someone is and get everything you've noted about them.
- **Research.** Claude reads the sources for you, and fabrik stores the ones the answer came from.
- **Files.** Ask a question, and search finds the answer in your files by their words and meaning. With connections on, it also finds a file through the people and companies it names.
- **Admin.** Forms filled in from what you've already told Claude. You see the form before anything is sent.
- **Analysis.** Prices, products or options weighed up across sites, with evidence.
- **Publishing.** Websites of any size, put live on your own Cloudflare account under your own web address.
- **Chatbot.** Chat agents in your brand, each with its own page on your own domain and a chat button for your website. Each one answers visitors from pages you write, in the name, voice and rules you give it, and from nothing else in fabrik. You edit their files with Claude as Claude Docs, and keep every conversation in your own Supabase project.
- **Work.** In any application with a connector or plugin, Claude can do the work for you, better than you can.
- **Look.** The Claude desktop and mobile apps show fabrik's colours in every session: cream in light mode, navy in dark mode, and an amber accent.

## Cards

Claude shows your records, lists, boards and graphs as cards you can work with, as an app would. You make each decision in one click, as in the apps you already know. A business's cards and printed pages take its own brand.

## Your routines

Say "Let's get started" and Claude asks whether fabrik is for a business, your own life, or both. For a business, it reads the website for its profile and brand. It asks what you want from each routine, such as triaging your email or creating invoices. For one of them, it writes down how it runs today, and which applications must stay. Then it designs a better way with the connectors and plugins you have or could add. Once you approve the design, Claude follows it whenever it does that work for you.

## What comes with it

fabrik ships three plugins for Claude, on top of Claude's own connectors and plugins.

| Plugin | What it does |
|---|---|
| fabrik | Tools and skills for your knowledge base: records, files and search, boards, graphs, printed PDFs, code and workbooks, projects, the glossary, and bringing in your LinkedIn, Notion, Obsidian, Substack and X exports. |
| cloudflare | Deploys a folder from your computer as a website on Cloudflare Pages, with its form handlers. It adds your own domain and manages its DNS records. |
| humanizer | Writing rules and checks, so what Claude writes for you reads as a person wrote it. |

## More plugins

fabrik's marketplace also has three other plugins. WhatsApp reads your WhatsApp messages and saves each chat in your private fabrik scope, so Claude finds them in every app. It never sends, because Meta bans numbers that send automated messages. TripAgent plans trips with Claude's Kiwi.com, Tripadvisor, Brek, Civitatis and AccuWeather connectors. The animator makes the videos for animated.recipes. The guide [More plugins](docs/guides/18-more-plugins.md) says how to install each and what each needs.

## With Claude's own features

fabrik's connector makes your records available to everything else Claude does. Which of these you have depends on your Claude plan and what you turn on.

- **Artifacts.** Spreadsheets, documents, slide decks, designs and dashboards, made from your records.
- **Connectors.** Gmail, Google Calendar, Google Drive, Slack, Notion and the rest of Claude's directory, used alongside fabrik.
- **Plugins and skills.** Anything in Claude's plugin directory, or your organisation's own.
- **Claude in Chrome and computer use.** Claude works on sites you're signed in to, and in apps on your computer.
- **Code.** Analysis, files and whole applications.

## How it works

**Supabase** is a service that hosts databases. fabrik stores all your data in a Supabase project you own: your records and their history, your files and the search index. The project also hosts the functions that run fabrik, including the connector Claude communicates with. You decide who sees your data, and you can export it or move it whenever you like.

**Cloudflare** is a service that hosts websites. Claude puts your websites, forms and apps live on your own Cloudflare account, under your own web address. Cloudflare also hosts the page where you sign in to fabrik.

**Claude** helps you think, create and get things done. It works in every app you connect, using the data fabrik stores.

## Setting fabrik up

Follow [Set up fabrik](https://claude.ai/artifact/FYM5oNpqMeacSiUpA2JjNR). You need a Claude plan, the Claude desktop app on a Mac, Windows or Linux computer, and free Supabase and Cloudflare accounts. Setup runs on macOS 15 or later, and on Windows 10 version 1809 or later. Setup takes about fifteen minutes. The page also explains the three sign-ins setup uses.

## Updating fabrik

Setup leaves a copy of fabrik's code in `~/fabrik-code`. Keep it: running setup again from it is how your project gets fabrik's newest version. In a Terminal tab, run:

```sh
cd ~/fabrik-code && git pull --ff-only
node plugins/fabrik/cli/fabrik.mjs setup --owner
claude plugin update fabrik@fabrik
```

The first two lines update what runs in your Supabase project. The last updates the fabrik plugin on this computer. The guide [Running setup again, and upgrades](docs/guides/13-setup-and-upgrades.md) gives each step.

## Guides

Each guide covers one thing fabrik does. In any Claude app, ask Claude how to do something, and it answers from the same guides.

- [What fabrik is](docs/guides/01-what-fabrik-is.md)
- [fabrik in each Claude app](docs/guides/02-claude-apps.md)
- [Adding other connectors in Claude](docs/guides/03-other-connectors.md)
- [Records and scopes](docs/guides/04-records-and-scopes.md)
- [Files and search](docs/guides/05-files-and-search.md)
- [Projects and tasks](docs/guides/06-projects-and-tasks.md)
- [Contacts and groups](docs/guides/07-contacts-and-groups.md)
- [Routines and their design](docs/guides/08-routines.md)
- [Importing from other apps](docs/guides/09-importing.md)
- [Reading email](docs/guides/10-email.md)
- [Drawing boards and graphs, and printing](docs/guides/11-drawing-and-printing.md)
- [Claude in Chrome and the built-in browser](docs/guides/12-browsers.md)
- [Running setup again, and upgrades](docs/guides/13-setup-and-upgrades.md)
- [A forgotten password](docs/guides/14-forgotten-password.md)
- [Costs and limits](docs/guides/15-costs-and-limits.md)
- [Getting help](docs/guides/16-getting-help.md)
- [Chat on your website](docs/guides/17-website-chat.md)
- [More plugins](docs/guides/18-more-plugins.md)

## Forgotten your fabrik password

Your Supabase account has full access to your project, so you can always set a new fabrik password from it:

1. Open your project in the [Supabase dashboard](https://supabase.com/dashboard), then **Authentication**, then **Users**.
2. Choose your own user, and **Send password recovery**.
3. Open the email's link. Your sign-in page opens with a field for a new password.
