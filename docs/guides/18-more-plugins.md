<img src="../../site/brand/favicon.svg" width="40" height="40" alt="">

# More plugins

fabrik's marketplace has three more plugins: WhatsApp, TripAgent and the animator. WhatsApp saves into your fabrik with your own sign-in. TripAgent and the animator don't use your Supabase project or a fabrik sign-in.

## WhatsApp

The WhatsApp plugin reads your WhatsApp messages and saves each chat in your private fabrik scope, as `whatsapp/<chat name>.md`. Claude then finds them through fabrik's search, at claude.ai and on your phone too.

It only reads. It never sends, replies or reacts, and it never marks a message read. Baileys, the library it connects with, still sends two things of its own on each check. It tells WhatsApp each message arrived, so the sender sees two grey ticks, and it shows you as unavailable, never online. The plugin never sends blue ticks.

It joins your WhatsApp as a linked device, the way WhatsApp on a computer does. In a Terminal tab, install it with `claude plugin install whatsapp@fabrik`. Then open a new Code session in your fabrik folder, the one you signed in with `fabrik sign-in --folder`, and say "link my WhatsApp".

Claude asks for your number, and whether to bring in your recent chats as well as new messages. Your phone sends them only when a device links, so adding them later means linking again. Claude then shows an 8-character code. On your phone, open WhatsApp → Settings → Linked devices → Link a device, tap Link with phone number instead, and type the code. If the phone asks whether someone else asked for the code, it was you, so approve the link.

If you chose your recent chats, Claude waits a few minutes after you type the code while your phone sends them. Say "check my WhatsApp" to save them in fabrik. Each check saves 20 chats, and says how many still wait, so check again until none do. No chat file passes 1 MB. A busy chat keeps its newest days in `whatsapp/<chat name>.md`. Its older days go in files of their own, each holding one month or part of one.

If you linked without them and want them now, say "link my WhatsApp again". WhatsApp sees each link as a new device, which adds to the risk below.

WhatsApp keeps no other history that a linked device can fetch later. So say "check my WhatsApp" in a Code session on that computer whenever you want the new messages in fabrik. Each check connects, takes what arrived since the last one, and disconnects. Photos, videos, voice notes and documents are noted by their kind and name, and stay on your phone.

Check at least once a week. WhatsApp drops a linked device that hasn't connected for about 14 days, and the messages it held for it are lost.

The link's keys stay on your computer, in `~/.config/fabrik/whatsapp/`, readable by you alone. Say "unlink WhatsApp" to remove the link and delete them. The chat files stay in fabrik.

The plugin uses Baileys, a library WhatsApp doesn't make or support, and WhatsApp can ban a number it flags. A short check that only reads is the lowest-risk way to use it, but the risk stays.

You need a private scope in fabrik for the chats. If you don't have one, an administrator adds it for you.

## TripAgent

TripAgent plans a trip like a travel agent across the desk. It learns your taste from pairs of hotel photos, then suggests countries, hotels and flights one at a time. It never books or pays: each result links to the provider.

In a Terminal tab, install it with `claude plugin install trip-agent@fabrik`, then open a new session.

It needs these connectors in your Claude account, which you add from Claude's connector directory:

| Connector | What TripAgent uses it for |
|---|---|
| Kiwi.com | Flights, with their stops and layovers |
| Tripadvisor | Reviews, rankings and photos |
| Brek | Hotel prices for your dates |
| Civitatis | Excursions and tours |
| AccuWeather | The weather |
| Veltra | More tours, if you want them |

When one is missing, TripAgent says which one, and carries on with the others.

Start it with its travel-agent agent, or its `plan-trip` command, in a folder of your own. It keeps your profile and each trip in a `Trip Agent` folder there.

## The animator

The animator makes the videos for animated.recipes. It writes an original recipe, draws it as scenes, narrates it and renders it to MP4.

Install it with `claude plugin install animator@fabrik`. It needs no connector. It needs Google Chrome, ffmpeg and an AssemblyAI API key on your computer.
