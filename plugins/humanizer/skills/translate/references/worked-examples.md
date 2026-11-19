# /plainly worked examples

Six examples that demonstrate the rules in SKILL.md. Each shows a source, a polished version, and the failure modes the polish avoids. Examples 1 to 4 are subtractive: sizing, scope, vocabulary, format. Example 5 is the positive counterpart. Example 6 is the opposite failure: prose compressed until it reads like a rulebook. Its "shape of natural writing" moves turn a flat-but-correct explanation into prose a human would actually write.

Em-dashes appear only inside quoted bad-pattern illustrations (what to avoid); every polished output is em-dash-free, per the rule in SKILL.md. Examples are presented in generic form; where an earlier draft named a specific codebase or pitch, the reference has been neutralised.

---

## 1. Sizing the explanation: primitive vs. richer concept

A primitive operation needs only the precise definition plus its immediate consequence, two sentences. A richer concept needs the full four-item template from the output contract: definition, consequences, visual, significance. Length is dictated by the concept's richness, not by a fixed template.

> **User:** what is integration, in plain English?

> Integration is the act of adding up all the infinitesimal changes specified by a differential equation over an interval, giving the system's state at the end of that interval. If each change is random, that end state is a distribution of possible values; if each change is deterministic, it is a single value.

> **User:** /plainly "S_T is lognormal"

> "S_T is lognormal" means the logarithm of S_T (denoted log(S_T)) is normally distributed. This means S_T itself is always positive and large upward moves are more likely than relative downward moves. Visually, the distribution is skewed to the right, with a long right tail. This property is exactly why Black-Scholes is closed-form (can be solved analytically rather than numerically).

**Failure modes:**

- *Definition only, no scaffolding.* "...the logarithm follows a bell-curve distribution." Correct terms, but the reader gets a dictionary entry they cannot use. A richer concept needs the consequences, the picture, and why the document cares.
- *Over-correction that drops the doc's own vocabulary.* Avoiding "logarithm" or "normally distributed" and substituting circumlocutions leaves the reader with no anchor to the rest of the document. Plain English keeps vocabulary the doc has already established.
- *Padding a primitive to four items.* Integration needs two sentences. Adding a manufactured "visual" or "significance" to a primitive is filler.

**Principle:** two items for a primitive, up to four for a rich concept; never pad past what the reader needs.

---

## 2. Transliterate, don't expand (match the scope of the question)

When the source is a single sentence dense with jargon, the plain version is also a single sentence. Keep the syntactic frame, swap each jargon term for its plain equivalent, and stop. When the source uses bare symbols, anchor them, putting the meaning first and the symbol in parentheses as a cross-reference back to the surrounding document.

> **User:** /plainly "parameter standard errors fall out of the calibrated Jacobian via the usual covariance formula."

> Since the calibration produces a table of sensitivities as part of its loss-minimisation process, this table is converted to statistics that express the margin of error in the parameters.

> **User:** /plainly "The V₀ memory has decayed to θ by the time of any VX-future expiry, so the V₀ term drops out."

> By the time any VX future expires, the variance has mean-reverted from its starting value (V₀) to its long-run level (θ), so the formula no longer depends on V₀.

The mapping is direct: "the calibrated Jacobian" becomes "a table of sensitivities"; "V₀ memory" becomes "starting value (V₀)" (meaning first, symbol parenthetical); "decayed to θ" becomes "mean-reverted to its long-run level (θ)". Each jargon term lands in the slot it occupied in the source. Nothing is added; nothing is cut.

**Failure modes:**

- *Expanding a one-sentence question into paragraphs.* The reader asked what one sentence means, not for a tutorial. Numeric examples, adjacent context (a connection that lives in neighbouring sentences, not the asked one), or a "the catch is…" paragraph are all scope creep.
- *Leading with the symbol.* "V₀ is the initial variance…" makes the reader decode the symbol first. Lead with the meaning, anchor the symbol once parenthetically, and never back-reference the bare symbol later. Mapping "V₀ here = starting value from a sentence ago" is the cost the anchor was meant to remove.

**Principle:** match the scope of the question, not the depth of the topic. One sentence in, one sentence out.

---

## 3. Default to plainer than you think; the audience is newer than the writer

The writer's audience-model is calibrated to the writer's own background. The words that feel obvious ("Fourier methods", "characteristic function") are exactly the ones to downgrade. The cost of going one level too plain is mild, and an expert only feels slightly patronised. The cost of going one level too jargon-heavy is severe, because the new reader bounces off entirely. The asymmetry favours plainer.

> **Source:** "Exact VIX pricing under Heston would require Fourier methods on the integrated CIR variance distribution; the closed-form approximations match shape to negligible practical error and are fast enough for repeated pricing."

> **First pass (still too jargon-heavy):** "Exact VIX pricing under Heston would require Fourier methods applied to the distribution of integrated variance; the closed-form approximations match the exact shape to negligible practical error and are fast enough to call repeatedly."

> **Polished:** "Exact VIX pricing under Heston would require a transformation of the variance probability distribution but the closed-form approximations we use here instead are close enough in terms of residual error and fast enough that we can call them repeatedly."

The second pass downgrades each borderline word:

- "Fourier methods" becomes "a transformation", dropping the proper noun and the placeholder noun "methods".
- "integrated CIR variance distribution" becomes "variance probability distribution", unstacking the modifier chain.
- "match shape to negligible practical error" becomes "close enough in terms of residual error", collapsing elaborate phrasing to the plain claim.

An explicit "but" is added so the reader does not have to infer the contrast from punctuation. Note the polished version is no shorter than the first pass: plainness is substituting vocabulary downward, not cutting words.

**Failure modes:**

- *Treating proper nouns as low-cost.* A reader need not know who Fourier was to understand a transformation. Keep a proper noun only where it is load-bearing as a citation the reader might look up.
- *Placeholder nouns and stacked modifiers.* "methods / techniques / approaches" name a category without naming the operation; three modifiers on one noun ("integrated CIR variance distribution") cannot be parsed in sequence by a new reader.
- *Precision without bridging.* A short answer using three specialist phrases is *longer* in reading time than a longer answer using none. The reader has to look each one up. If a phrase compresses several specialist ideas ("exact for a polynomial family"), unpack it inside the explanation or expect the new reader to bounce.

**Principle:** default plainer than feels necessary; restore precision only where it would otherwise be lost. If a word feels obvious, that is evidence to drop it, not keep it.

---

## 4. Format scaffolding is itself the AI tell

Some sources arrive in the heading-and-bullet format AI defaults to in marketing copy: bold-tag headings, em-dash separators, stacked one-liners, a signpost line, a closing tricolon. The polish must question the *format*, not just refine the words inside it. In human-facing copy, prose almost always does the same job better. The heading-and-em-dash format is the visual signature of an AI marketing page, however plain the words are.

> **Source:** A consultancy pitch presenting three offerings as `**Bold Heading** — description` blocks, introduced by a signpost line ("Three ways I work with clients:") and closed with a tricolon of three parallel-shape sentences ("I [verb] the [noun].").

> **Failed polish (kept the format):** Same headings, same em-dash separators, tricolon merged to one sentence with three verbs. Word-level tells were caught; the visual scaffold was preserved, so it still reads as AI marketing copy.

> **Gold standard (prose):** Three offerings folded into running prose, each opened by a verb the writer would actually say. No bold headings. No em-dashes (the separator becomes a comma, or a hyphen with spaces if needed). The signpost line is deleted. The closing tricolon is removed entirely, not collapsed. Any closing sequence becomes a single conditional invitation: "If you have recognised X and understand Y, then I can help you put Z into practice."

**Failure modes:**

- *Treating the heading-and-em-dash format as a feature of the source rather than a constraint to question.* For three short offerings, prose with conversational lead-verbs reads faster than a heading-bulleted list.
- *Collapsing a rhetorical tricolon instead of removing it.* If a closing adds no new content, only strong-form repetition, cut it. The reader has read the offerings and does not need a chant of the verbs.
- *Specific-sounding numbers the writer cannot source.* "a 1-2 year head start", "30% faster" read as authoritative; if you cannot defend the bound, "a limited head start", "noticeably faster" express the same shape without false confidence.

**Principle:** the AI-tells catalogue applies to format as much as to vocabulary. When the source is in heading-and-bullet format, the precision pass must ask whether prose would do the same job. In human-facing copy the answer is almost always yes.

---

## 5. The shape of natural writing (the positive counterpart)

The first four examples are subtractive: they remove jargon, notation, and format tells from text that was trying to be a definition. The fifth is additive. The source here is not wrong and has no obvious jargon to strip; it is simply lifeless, technically correct and recognisably machine-made. The job is to make it read like a person wrote it, using the five moves from the "shape of natural writing" section.

> **User:** /plainly "what is a database index?"

> **Flat source (the default machine answer):** "A database index is a data structure that improves the speed of data retrieval operations on a database table at the cost of additional writes and storage space to maintain the index data structure. Indexes are used to quickly locate data without having to scan every row in a table each time the table is queried."

> **Polished:** "Think of the index at the back of a book. Without it, finding every mention of caching means turning all four hundred pages. With it, you read one line and jump straight to page 212. A database index is that back-of-the-book list, kept for a column you search on a lot, so the database can find the rows it wants without reading the whole table. The cost is real. Every time you add a row, the index has to be updated too, and it takes its own space on disk. So you don't index everything. You index the columns you actually look things up by, and let the rest be read the slow way."

Each move did its work:

- A dropped-in concrete open: the book the reader already pictures.
- Uneven cadence: "The cost is real." between two long sentences.
- Abstractions anchored to things a reader can see: four hundred pages, page 212, space on disk.
- One earned turn: the index sounds free, then the write-time cost is the hinge.
- A landing close that hands the reader something to do rather than a recap.

**Failure modes:**

- *Restating the same claim twice.* The flat source says "improves the speed of data retrieval" then "quickly locate data without scanning every row": one fact, twice, in category language. The book picture carries it once.
- *Even cadence and no anchor.* Two ~30-word sentences in a row is the machine march; "data structure" is correct and weightless, leaving the reader picturing nothing.
- *Manufacturing a turn, or closing with a summary.* This concept has one genuine hinge (the write-time cost); do not stack more, and do not end with "In summary, an index trades write cost for read speed."

**Principle:** plain English is not only the absence of jargon; it is the presence of a human voice. A correct, jargon-free explanation still fails if it is evenly paced, anchored to nothing, and ends by repeating itself.

---

## 6. Over-compression: putting the joints back

A tutorial for non-technical readers passed every check in `checks.mjs` with two findings. A reader still marked 62 of its sentences as machine-written. This passage is typical. Every sentence is short, plain and free of inflation words.

> Give the project its own scope. Run this with the admin agent, from your records repository.
>
> A scope code takes lower-case letters, digits and underscores only, so use `project_asn`. A scope's code is permanent. Give its name and description in the same request. Administrators need no grant.

Rewritten:

> Next, give the project its own scope. A scope is a labelled area of the records system that holds related records, and you control who can see it. Creating one is an administrator's job, so this step uses the admin agent.
>
> A scope has a short code, a name and a description. The code can only contain lower-case letters, digits and underscores. You cannot change the code later, so get it right first time. Give the name and description in the same request, or the agent will have to invent them. Administrators can already see every scope, so they do not need to be granted access.

**Failure modes:**

- *Four rule-lines with no connective tissue.* Each sentence of the original is a separate rule. None says why, and the last arrives with no context at all. The rewrite gives each rule its reason: "so get it right first time", "or the agent will have to invent them".
- *Jargon left undefined because the sentence was already short.* "Scope" and "grant" are used as if known. Defining a term costs a clause. Leaving it undefined costs the reader the whole step.
- *Mistaking a reason for a pitch.* Rule 7 strips the reason a design is good. "Or the agent will have to invent them" is not that. It is the consequence the reader avoids by following the step.

**Principle:** short sentences are a means. If the reader cannot say who does it, when, and what goes wrong otherwise, the sentence is too short, not too long.

