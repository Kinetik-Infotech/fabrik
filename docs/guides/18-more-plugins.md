<img src="../../site/brand/favicon.svg" width="40" height="40" alt="">

# More plugins

fabrik's marketplace has two more plugins, TripAgent and the animator. Neither uses your Supabase project or a fabrik sign-in.

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
