---
name: brand
description: Use once the business profile is saved, or to change the business's brand. It takes the business's brand from its website, or from a logo file and the colours the owner gives. Once the owner approves it on a question card, it saves the logo in General and the brand as a model record there titled Brand. fabrik's cards, PDFs and decks then use it. It runs in one of three modes: human only, AI guided or human directed.
---

# The business's brand

This skill runs only as fabrik's assistant, `fabrik:assistant`. Before anything else, the agent reads `.claude/settings.json` in the session's folder, or in the nearest folder above it that has one. When that file doesn't set `agent` to `fabrik:assistant`, or no folder has one, the agent says only this to the person, and stops:

> Open a Code session in your fabrik folder, usually `~/fabrik`, and ask there again.

The brand is the business's logo, colours and fonts. fabrik keeps it as one `model` record in General, titled `Brand`, with `model_kind` `observed_current`. The connector's cards, the question and list cards, printed PDFs and decks read it each time they are drawn. A new version of the record changes all of them at once. With no `Brand` record, each keeps its plain look.

A card keeps the host's text and background colours, so it reads in light and dark mode. It takes the brand's accent for its buttons, links and header rule, the brand's fonts, and the logo at the start of its header. A printed page or a deck takes the whole light palette, the fonts and the logo.

Every save follows the `fabrik:records` skill's section 3. The agent shows the person what it will save, and saves only what they approve. The agent asks each question as the card rules' "Asking a question" says.

## Choose the mode

The person chooses the mode.

- **Human only:** the person follows the Person lines below, without the agent. They do each step with the fabrik-apps connector's tools.
- **AI guided:** the person asks the agent to guide them. Before each step, the agent says what the step does and shows the Person line. It stops for the person's approval at the end of each stage.
- **Human directed:** the person tells the agent what to do. The agent follows its lines for each step the person directs.

Each step below gives a **Person** line and an **Agent** line.

With the agent, the person's own instruction replaces a rule of this skill, such as the font. The agent names the rule once and does as told. A refusal from fabrik or a tool still stands. The agent gives it to the person with what they can do instead.

## The brand record

The record's `graph` holds one node, `id` `brand`, `type` `brand`, `label` the business's name. Its `attributes` hold three things.

**`palette`** holds `light` and `dark`, each with the same six tokens. Each value is a colour as `#` and six hex digits, such as `#3fa66b`.

| Token | What it is for |
|---|---|
| `ink` | text and headings: the website's darkest text colour |
| `paper` | the page: its lightest surface, usually white |
| `muted` | captions and secondary text: a mid grey |
| `rule` | borders and dividers: a pale neutral line |
| `accent` | buttons, rules and the header: the logo's own colour, as it is |
| `accent_text` | links and small text in the accent: the accent deepened until it reads on `paper` |

In `dark`, `paper` is the dark surface and `ink` the light text. A card in dark mode uses the dark `accent` and `accent_text`.

**`fonts`** holds `heading` and `body`. Each has `family`, the font's name, `source`, `google` or `system`, and `fallback`, the fonts to use in its place, such as `Georgia, serif`. A font is used only from Google Fonts or the computer, so every card and page can load it. A font the website hosts itself is replaced by the nearest Google Font, which the owner approves.

**`logo`** holds `bucket` `general`, `path`, the logo's file in General, `alt`, the business's name, and `data_address`, a copy at most 200 pixels across as `data:image/png;base64,...`. A card shows the copy, so it needs no second read. The full file stays in Storage. The logo is a PNG, JPEG, GIF or WebP picture. A card leaves out an SVG logo, so the agent saves an SVG as a PNG.

The record's other fields:

- `source_version`: the website's address, or `files from <name>`.
- `source_status`: `approved by <name>`.
- `description`: one or two sentences, such as "Smith Joinery's logo, colours and fonts, read from its website."
- `type`: `brand`.

## 1. Find the brand

- **Person:** asks fabrik to use their brand, or is offered it after the business profile is saved. Without the agent, finds any brand with `list_records`, `kind` `model` and `title` `Brand`.
- **Agent:**
  1. Calls `list_records` with `kind` `model` and `title` `Brand`, and keeps the record in General titled `Brand` exactly, since the list also holds other titles with the word. With one, it reads it with `get_record` and shows it, as section 4 says. It asks whether to change it.
  2. Reads the business profile's `business` node for the website. With none, it asks for the website's address, with I have none as the other answer.
- **Evidence:** the brand's `record_id` and `version_number`, or that there is none, and the website's address.

## 2. Take the brand

**From the website.**

- **Person:** gives the website's address.
- **Agent:**
  1. Reads the home page and its stylesheets with `WebFetch`. It takes the colours from the text, the surfaces, the borders and the logo, and the fonts from `font-family`, using no colour the site lacks.
  2. Finds the logo: the image in the site's header, or the one its `og:image` or `apple-touch-icon` names. It downloads the file into the agent folder. Before reading a picture, it checks its size, and never reads one over 2,000 pixels on a side.
  3. Makes the 200-pixel copy. On macOS it runs `sips -Z 200 -s format png <logo> --out logo-200.png`. It then reads the copy's bytes as base64 for `data_address`.
  4. Works out `accent_text`, as section 3 says.
  5. Takes the dark palette from the site's dark mode, where it has one. With none, it proposes one. Its `paper` is the light `ink`, and its `ink` the light `paper`. Its `muted` and `rule` are a step lighter than its `paper`. It keeps `accent` as it is, and works out `accent_text` on the dark `paper`.

**From files.**

- **Person:** gives a logo file and names the colours.
- **Agent:** asks for the logo file to be put in the agent folder, and for the accent colour, one question per reply. It takes `ink`, `paper`, `muted` and `rule` from the logo where it can. Otherwise it proposes plain ones, `#1f1f1f`, `#ffffff`, `#5f5e5a` and `#d9d6cc`. It asks which fonts the business uses, with the system's own fonts as the other answer.

**AI guided:** the agent gives the person what it found and waits for their approval before section 3.

## 3. Check the text colour

Text in the accent must read on the page. The agent works out `accent_text` for each palette:

1. Start from `accent`.
2. Work out the contrast with `paper`, as WCAG 2 measures it. Take each colour's relative luminance L, and divide the lighter's L plus 0.05 by the darker's L plus 0.05.
3. While the ratio is under 4.5 to 1, darken the colour for the light palette, or lighten it for the dark one, keeping its hue.

The agent works this out with code, as the `fabrik:code` skill says. When `ink` on `paper` is under 4.5 to 1 too, the agent says so and asks the owner which colour to change.

## 4. Show the brand

- **Person:** reads the brand and approves it, or names what to change.
- **Agent:** draws a question card, `draw_widget` `kind=question`. Its rows are each palette token, with its light and dark values as fields, each font with its source, and the logo's file. The question is "Save this brand?". The agent asks it in the next-step box.

## 5. Save the brand

- **Person:** approves the brand. Without the agent, uploads the logo with `upload_file`, `scope` `general`, `path` `brand/logo.png`, and saves the record with `save_record`, `scope` `general`, `kind` `model`, `title` `Brand`, with `fields` as above.
- **Agent:**
  1. Uploads the logo with `upload_file`, `scope` `general`, `path` `brand/logo.<extension>`, the file's bytes as `content` with `encoding` `base64`. For a new logo in place of an old one, it passes `overwrite` true once the owner approves.
  2. Calls `save_record` with `preview` true, then saves it once the owner approves. With a `Brand` record already there, it saves a new version of that record, with `record` its `record_id`.
  3. Reads the saved version back with `get_record`, and checks its palette, fonts and logo are as the owner approved them.
- **Evidence:** the logo's path, and the brand's `record_id` and `version_id`.

## Problems

- **The website refuses the read:** the agent asks for the logo file and the colours, as section 2's From files says.
- **No grant to save in General:** fabrik's refusal names the missing action. An administrator can grant it.
- **"stale":** someone saved a newer version. The agent reads the brand again and shows the newer version before saving.
- **A card still looks plain:** the card reads the record titled `Brand` in General as the person viewing it. A person with no grant to read General sees the plain look.
