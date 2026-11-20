# Scene library

Worked examples and reusable scenes for the animator agent. Read before drawing; reuse a scene wherever it fits,
changing only its words and numbers.

## Examples

- `examples/sourdough-pizza/script.json`: overnight sourdough pizza dough, 15 scenes: title, ingredients,
  equipment, weigh the starter, feed it, let it ripen, mix flour and water, salt and levain, mix by hand,
  stretch and fold, rise overnight, divide, shape into balls, refrigerate, the schedule.

## Scenes

One line per scene in `scenes/`, added by the agent when it draws one that passes its checks.

- `scenes/title-jar.json`: title card: dish in two lines over a small bubbly jar and its yield (from sourdough starter).
- `scenes/jar-mix-flour-and-water.json`: flour and water fall into a jar in turn, amounts at the side, water temperature and rest chips (from sourdough starter).
- `scenes/jar-mark-level-overnight.json`: rubber band marks the level in a jar while a window goes day, night, day (24 h) (from sourdough starter).
- `scenes/jar-keep-and-feed-on-scale.json`: old bubbly jar to discard; 50 g moves into a clean jar on a scale, then flour and water, the scale counting up (from sourdough starter).
- `scenes/jar-rise-and-fall.json`: a fed jar rises with bubbles then falls back past the FED line, window day and night (from sourdough starter).
- `scenes/feed-grid-twice-a-day.json`: a grid of days by 09:00 and 21:00, each feed popping in, with the per-feed amounts as chips (from sourdough starter).
- `scenes/jar-doubled-ready-checklist.json`: a jar doubles above the FED line with an arrow and 2x, beside a four-line ready checklist (from sourdough starter).
- `scenes/keep-worktop-or-fridge.json`: a jar on the worktop or a small jar in a fridge, each with its feeding chip (from sourdough starter).
- `scenes/schedule-seven-days.json`: a seven-day timeline with one label per day and a closing line (from sourdough starter).
- `scenes/title-loaf.json`: title card: dish in two lines over one crusty loaf and its weight (from sourdough loaf in a pot).
- `scenes/tip-out-on-floured-surface.json`: floured surface, one slab of dough drops onto it, weight chip (from sourdough loaf in a pot).
- `scenes/pre-shape-loose-ball.json`: slab, four fold-in arrows, loose ball that flips seam side down, rest chip (from sourdough loaf in a pot).
- `scenes/shape-boule-drag-towards-you.json`: loose ball tightens into a dome, dragged towards you three times beside a down arrow (from sourdough loaf in a pot).
- `scenes/prove-in-towel-lined-bowl-poke-test.json`: towel-lined bowl, dough seam up rises under a cover, then a top-view poke dent springs back slowly (from sourdough loaf in a pot).
- `scenes/bowl-into-fridge.json`: covered bowl shrinks into a fridge and the door closes, with time and bake-from-cold chips (from sourdough loaf in a pot).
- `scenes/oven-heat-pot-knob-check.json`: lidded pot in an oven with heat lines, temperatures, preheat chip and a zoomed lid knob (from sourdough loaf in a pot).
- `scenes/slash-and-load-into-pot.json`: dough on baking paper is slashed by a blade, the pot lid lifts and the dough arcs into the open pot (from sourdough loaf in a pot).
- `scenes/bake-in-pot-lid-on.json`: oven with a pot in section, lid on, the dough rising, time and temperatures at the sides (from sourdough loaf in a pot).
- `scenes/bake-in-pot-lid-off.json`: lid lifts off, temperatures change, the loaf browns, time and colour chips (from sourdough loaf in a pot).
- `scenes/loaf-cool-on-rack.json`: browned loaf on a wire rack with steam fading, time before cutting (from sourdough loaf in a pot).
- `scenes/schedule-one-morning.json`: one-morning timeline of seven timed steps, a closing line and an alternative (from sourdough loaf in a pot).
