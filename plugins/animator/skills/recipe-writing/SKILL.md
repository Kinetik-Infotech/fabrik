---
name: recipe-writing
description: How animated.recipes writes a recipe from a request — original wording, the whole-food rules, scaling to servings, allergen substitutes or declining, US amounts with densities, and what a recipe video never says. Use when writing or changing a job's script.json.
---

# Writing the recipe

## The recipe is ours

Write every recipe yourself, in your own words. Don't reproduce any particular book's or website's recipe, its wording or its quantities. Dishes, ingredients and methods are common knowledge; a writer's text is not.

## Whole-food rules

These are checked by `check.mjs` against `data/rules.json`, and a recipe that breaks one is not rendered.

- No seed oils: no sunflower, rapeseed (canola), soybean, corn, cottonseed, grapeseed, safflower or rice bran oil, and nothing called vegetable oil. Cook with butter, ghee, lard, beef dripping, tallow, olive oil or coconut oil.
- No margarine or spreads. Use butter.
- Wheat flour that is not wholemeal says "unfortified" in its name, such as "unfortified strong white flour".
- Organic meat, full-fat dairy, fresh produce. Say "organic" for meat.
- No additives: no stock cubes, no ready-made sauces. Make the stock or sauce, or leave it out.

## What a recipe video says, and never says

- It says the ingredients, the equipment, the method, the timings and the temperatures.
- It never gives nutrition figures, calories, health benefits or health advice, and never says an ingredient is healthy or unhealthy.

## Scaling

Write for the request's `servings`. Every amount in the ingredients, the narration, the captions and the drawings is scaled to it, in sensible kitchen numbers (round grams to 5 g above 50 g; whole eggs, not 1.3 eggs).

When the recipe makes something other than portions for people, such as a loaf, a jar of starter or dough balls, write what it makes in `script.json`'s `makes`, such as `"1 loaf"`, `"1 jar, about 150 g"` or `"4 dough balls"`. The recipe card says "Makes …" from it in place of "For 4 people".

## Allergens

The request's `allergens` are codes from the 14 UK allergens: celery, gluten, crustaceans, eggs, fish, lupin, milk, molluscs, mustard, nuts, peanuts, sesame, soya, sulphites. `allergensOther` holds anything else the cook typed.

- Leave each one out, and use a whole-food substitute that keeps the dish what it is. Butter without milk can be lard or olive oil; cream can be coconut cream.
- Every ingredient lists the allergen codes it contains in `allergens`. Be thorough: butter is milk, soy sauce is soya and gluten, Worcestershire sauce is fish.
- If an excluded allergen is essential and has no such substitute, decline: the agent prints `DECLINED <reason>`.
- The `si` ingredients scene says which allergens were left out and what replaced them, when there are any.
- `script.json` lists each replacement in `substitutes`, for the recipe card: `[{ "for": "butter", "use": "lard" }]`.

## Amounts

Each ingredient in `script.json`:

```json
{ "id": "flour", "name": "unfortified strong white flour", "grams": 600, "gPerCup": 120, "us": "4¾ cups", "allergens": ["gluten"] }
```

- `grams` is the metric amount, or `null` for "a little" items such as oil for the tin.
- `us` is the US amount in cups, tbsp, tsp, oz or lb, written with the fraction characters ¼ ½ ¾ ⅓ ⅔ ⅛, such as "1½ cups + 1 tbsp". For a `null` amount, write the words ("a little").
- `gPerCup` (for cups) or `gPerTsp` (for tbsp and tsp) is the ingredient's real density: flour about 120 g a cup, water 237, sugar 200, butter 227, fine salt 6 g a teaspoon. `check.mjs` requires the US amount to be within 10% of the grams through it.
- Each scene lists in `uses` what it adds, `{ "ingredient": "flour", "grams": 600 }`. Each ingredient's uses add up to its grams.
- Temperatures are °C in the metric text and °F in the US text. Lengths are cm and inches.

## Two sets of words

Every scene has `vo` (metric narration) and `voUS`, `cap` and `capUS`, and the same words in both wherever no measurement appears. Drawing texts with an amount carry the US version in `data-us`.

## Narration

Calm, plain and short: one action per sentence, the amount said as it is used. About 2.5 words a second. Number the steps by time where timing matters ("At about 6 in the evening…").
