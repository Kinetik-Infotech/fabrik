# Cards and questions

These rules apply to every reply, before any skill is loaded.

## Records on cards

When the person asks to see records, show them on the connector's `show_records` card. A plan or a model goes on `show_board` or `show_graph`. Rows that are not records, such as scopes, grants and mailboxes, go on the list card. A reply with a card holds no Markdown table of the same rows. Over 50 rows stay in the reply as a table.

## The list card

The list card shows rows the person asked to see that are not records, with no question. The person's scopes and their grants are examples. Records go on `show_records`, and any other rows go on the list card.

The agent writes the card's data file in the session's folder, `list-<date>-<time>.json`. It runs the fabrik command's `draw_widget` with `kind=list` and the file:

```sh
node ~/.claude/plugins/marketplaces/fabrik/plugins/fabrik/cli/fabrik.mjs draw_widget kind=list data_file=list-<date>-<time>.json
```

It shows the card with `show_widget`, passing `widget_code` unchanged, with the title `list` and one loading message. One card holds up to 50 rows.

The data file holds `kind` `list`, and `person`, `drawn_at`, `title`, `lead` and `rows` as the question card's do. It holds no `question`, and `draw_widget` refuses a list file that has one. Each row holds its `name`, its `code` and its `fields`, as a question card's row does.

## The question card

The question card shows the rows a question is about. A row is a record in fabrik, such as the scope a note goes in. It can be a row the person is adding, with its proposed values. It can also be a choice in a list, such as the person's scopes.

The agent writes the card's data file in the session's folder, `question-<date>-<time>.json`. It runs the fabrik command's `draw_widget` with `kind=question` and the file:

```sh
node ~/.claude/plugins/marketplaces/fabrik/plugins/fabrik/cli/fabrik.mjs draw_widget kind=question data_file=question-<date>-<time>.json
```

It shows the card with `show_widget`, passing `widget_code` unchanged, with the title `question` and one loading message. One card holds up to 20 rows.

The data file holds these fields. `draw_widget` refuses a file with a field missing, and draws nothing.

| Field | Value |
|---|---|
| `kind` | `question` |
| `person` | the person's name, from `fabrik_get_actor` |
| `drawn_at` | the time of the read, to the second |
| `title` | what the question is about |
| `lead` | one sentence above the rows, or left out |
| `question` | the question, one line of 100 characters at most |
| `rows` | one item for each row, at most 20 |

Each row holds its `name`, its `code`, such as the first eight characters of a record's id, and its `fields`. Each field is `{"label", "value"}`, with each value read from fabrik in this session. A row the person is adding holds `"new": true`, and a value still to be given is `null`. A choice in a list is a row with its name, its code where it has one, and no fields.

`draw_widget` returns the `question`, and the agent asks it word for word. The card shows each value in full, and a long one in a block that opens and closes. The card has no buttons, and writes nothing into the person's message box.

## Asking a question

The agent asks each question it needs the person's answer to in the desktop app's next-step box, with `mcp__ccd_turn__wrap_up`. It is the turn's one question. A question with two answers has them as its two buttons, and a press sends the answer at once. A question with more answers, or none, is asked in the box with no buttons, and the person types the answer.

An offer to do something is a question too, and the agent asks it in the box with Yes and No. "Shall I show a scope's records?" and "If you'd like, I can show a scope's records" are both offers. The reply never ends on one.

In a session whose tools hold no `mcp__ccd_turn__wrap_up`, such as one in a terminal, the agent asks in its reply's last line. Where `show_widget` is missing, the question card's rows stay in the reply as text.

1. A save the person has to agree to is a question with the buttons Yes and No, and the agent saves only on Yes.
2. A question with two named answers has a button for each, named in a few words. Getting started is offered with "Start" and "Not now".
3. A pick from a list shows the list's choices on a question card, the best fit first. The agent offers the best fit by its name, with Yes and Other. On Other, it drops that choice and offers the next. With two left, it offers both as two buttons. With none left, it asks the person to name one.
4. Several rows picked at once, such as the scopes a record goes in, are one set. The agent offers the set that fits best, with Yes and Other. On Other, it asks about each row in turn, with Yes and No.
5. The question names the one thing it is about, such as the record's title. It stays on one line of 100 characters, and each button's label is 24 characters at most. The question is the plain action, such as "Save lesson 3?".
6. The question is the box's own, and the reply leaves it out. Neither the question nor the reply says what a card's buttons or the box's buttons do.
7. The agent takes the answer as the person's own words, pressed or typed. A typed answer that names something else is taken as written.
8. A reply with a card never describes the card, and never tells how the agent made it or why it chose a step. The person sees the card. The reply says only what changed and what the agent needs from them.
9. A reply never says what the agent hasn't done, or won't do until the person approves, as "I haven't saved anything yet" does. The question in the box already asks for their approval. The reply says what changed, then the agent asks.

The plugin's question-asked hook sends a turn with no `wrap_up` call back once when it draws a question card. It does the same when the reply ends on a question or an offer. It also sends a turn back once when it shows 2 to 50 rows the connector returned as a table. A `show_records` call or a list card in the turn lets the table through.

The hook also sends a turn back once when its reply points at a card, as "the card above" does. It does the same when its reply, or the question in the box, uses yes as a noun, as "Save lesson 3 with your yes" does. It does the same when its reply, or the box's recap or question, says what the agent hasn't done, as "Nothing has been saved yet" does.
