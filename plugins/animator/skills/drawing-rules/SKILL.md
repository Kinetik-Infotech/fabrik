---
name: drawing-rules
description: How animated.recipes draws a recipe as SVG scenes that the animator player plays — the scene object, the frame and layout, the drawing and text classes, motion, timing, arrows, and what is never drawn. Use when drawing, redrawing or checking a scene in a job's script.json.
---

# Drawing the scenes

The worked example is `${CLAUDE_PLUGIN_ROOT}/library/examples/sourdough-pizza/script.json`: 15 scenes that play as a finished video. Copy its structure, its classes and its pace.

## The video's shape

1. A title card: the dish in two lines and a row of what it makes (`s1`).
2. `si`: the ingredients, in groups by when they are used, with amounts.
3. `se`: the equipment.
4. One scene per step of the method, in order.
5. A last scene with the schedule, when the recipe spans hours or days (`s17`).

## A scene

```json
{ "id": "s5", "title": "Mix flour and water", "dur": 14, "clock": [[0, 1080], [14, 1085]],
  "vo": "…", "voUS": "…", "cap": [[0, "…"], [7.6, "…"]], "capUS": [[0, "…"], [7.6, "…"]],
  "svg": "<path … class=\"ln\"/> …", "tw": [ … ], "uses": [{ "ingredient": "flour", "grams": 600 }] }
```

- `id`: a letter then letters, digits or hyphens. Every element id in `svg` starts with the scene id and a hyphen (`s5-l1`).
- `dur`: seconds. The player lengthens a scene to fit its narration plus pauses, and stretches the tweens, captions and clock with it, so write times for a scene that reads about right.
- `clock`: `null`, or `[[t, minutes since midnight on day 1], …]`. 1080 is 18:00 on day 1; 1860 is 07:00 on day 2.
- `cap`: `[[t, text], …]`, the first at 0. `capUS` has the same times.
- `tw`: tweens, each `[elementId, t0, t1, props, ease?]` with props such as `{"o": [0, 1]}` (opacity), `x`, `y`, `s` (scale), `sx`, `sy`, `r` (degrees), and ease `"io"` (default), `"i"`, `"o"`, `"b"` (bounce) or `"l"` (linear). The shorthands `["pop", id, t]`, `["fadeUp", id, t]` and `["fadeOut", id, t]` cover most appearances. `data-o="b"` on an element scales it from its bottom (also `t`, `l`, `r`).
- An element that a tween fades in is drawn in place, at its final position.

## Frame and layout

- The drawing is 1600 × 760. Keep everything inside x 120–1480 and y 120–720.
- Top left holds the scene number and title, and top right the clock: leave x < 400, y < 110 and x > 1300, y < 140 empty.
- Group lists in columns at x 230 and x 940, rows 44 apart, with a `t-lbl` heading over a rule.
- No two texts overlap, and text never crosses the frame. `check.mjs` measures both.

## Classes

- Lines: `ln` (main ink), `lt` (thin grey), `dash`.
- Fills: `f-w` white, `f-d` dough, `f-l` levain, `f-s` surface, `f-wa` water, `f-i` ink, `f-o` oil, `f-sa` salt, `f-gr` grains, `f-wd` wood. For a new food, use the closest fill; the style sheets set the colours.
- Text: `t-disp` (title), `t-lbl` (small caps label), `t-body`, `t-list` (list rows), `t-m24` and `t-mono` (amounts), `t-sm` (small caption). `grey` softens any of them.
- `chip` around a `<rect/>` and a `<text>` makes a labelled box sized to its text; `chip light` is the soft one.

## Motion and pace

- One idea at a time: draw the container, add the ingredient, show its amount, then the result.
- Ingredients fall or pour in with `y` and an `"i"` ease, then fade out as the fill rises.
- Labels arrive with `fadeUp`, items with `pop`, 0.3–0.5 s apart.
- Time passing is the clock moving and a rise or a sun and moon, never a cut.

## Arrows

An arrowhead follows its line's direction at the tip. For a quadratic curve `M x0 y0 Q cx cy x1 y1`, the direction is from (cx, cy) to (x1, y1). Draw the head as two 24-unit strokes at ±28° back from that direction, from the tip. A head drawn by eye looks broken.

## Never

- No people, hands or faces, in any style.
- No handwriting fonts and no wobble.
- No comic sound effects (POP!, SIZZLE!).
- No brand names or logos.
- No nutrition figures or health claims.
- No elements beyond g, path, rect, circle, ellipse, line, polyline, polygon, text, tspan and title, and no attributes beyond class, id, the shape's own geometry, transform, text-anchor, opacity and data-*. No style attributes, images, links, scripts or event attributes: build.mjs and check.mjs refuse them.
