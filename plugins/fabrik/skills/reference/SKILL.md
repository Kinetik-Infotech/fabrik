---
name: reference
description: Use when a person asks what one of the business's words means, where a fact is stored, or which system a field comes from. Also use when a person uses a word the glossary lacks, or asks to add or change a term, class, relationship or record kind. Covers reading the glossary and the data dictionary in fabrik's reference scope, proposing a change, and saving it only once the person approves, with its history and audit log. It runs in one of three modes: human only, AI guided or human directed.
---

# fabrik glossary and data dictionary

The glossary and the data dictionary are kept only in fabrik, in the `reference` scope. Setup leaves both empty. They grow from interviews and sessions, one approved term or record kind at a time.

- The **glossary** says what the business's words mean, for people and agents alike. Each row is a term with its kind, its definition and its other names, such as "memorandum of sale", other name "MoS".
  - A **term** is a word the business uses.
  - A **class** is a kind of thing records and connections are about, such as customer or order.
  - A **relationship** names the classes at its two ends, from one class to the other, such as places, from customer to order.
  - The classes and relationships are the business's ontology. Connections take the kinds of things from the classes and the names of links from the relationships, as the `fabrik:records` skill's section 18 says.
  - A term can name one thing of a class, such as the topic Masks of the class topic. Its **instance_of** names that class, and its **broader** names the term of the same class it comes under, such as a topic for a subtopic. Connections then take only these terms for that class, and tag files with them, as the `fabrik:records` skill's section 18 says.
- The **data dictionary** says where each fact is stored and in what form. Each **record kind** is linked to its glossary class, and has a meaning and its fields. Each **field** has a type, whether it is required, the glossary term it holds and its meaning. Each field names the systems it comes from, such as Loop, with the field's name there. A system is itself a glossary term.

Each save is a new version of a model record in the `reference` scope, titled "Glossary: <term>" or "Data dictionary: <record kind>". The old version is kept in the record's history, and the audit log names who saved it.

The agent, the assistant, `@fabrik:assistant`, reads and saves through the fabrik-apps connector's tools, signed in as the person, within that person's grants. It proposes each new or changed term, class, relationship or record kind to the person, and saves it only once that person approves.

## Choose the mode

The person chooses the mode.

- **Human only:** the person follows the Person lines below, without the agent. They do each step with the connector's tools. A step the connector has no tool for is the agent's.
- **AI guided:** the person asks the agent to guide them. Before each step, the agent says what the step does and shows the Person line. It follows its own line with the person watching, or asks the person to follow theirs. It stops for the person's approval at the end of each stage.
- **Human directed:** the person tells the agent what to do. The agent follows its lines for each step the person directs.

Each step below gives a **Person** line and an **Agent** line.

With the agent, the person's own instruction replaces a rule of this skill, such as the wording of a definition. The agent names the rule once and does as told. A refusal from fabrik still stands, and the agent gives it to the person with what they can do instead. Nothing replaces the person's approval of a save.

The connector's tools are called with their own argument names, such as `{"tool": "get_reference", "arguments": {"part": "glossary"}}`. `fabrik_save_dictionary` has no tool yet. The agent calls it as a function in the `fabrik` schema, through the fabrik plugin's `rpc` tool, such as `{"function": "fabrik_get_history", "schema": "fabrik", "args": {"p_record_id": "<record id>"}}`.

## 1. Read the glossary or the data dictionary

The glossary table is the source of a word's definition. A question about what one of the business's words means is answered from it, with `get_reference`, before any file search. File search never finds the glossary, because it is not a file. A file search's `reference_hits` hold the hits in the files kept in the `reference` scope, such as a guide. The agent reads them before its `hits`, as the `fabrik:actor` skill's "Search results" says.

- **Responsible:** the person, who must be able to read the `reference` scope.
- **Person:** asks for the glossary or the data dictionary. `get_reference` with `part` `glossary` or `dictionary` gives it.
- **Agent:**
  1. Calls `get_reference` with `part` `glossary` or `dictionary`.
  2. Answers from the rows alone, naming the glossary as the source. It matches a word on a row's term or any of its other names, in any case. For a term, it names the term, its kind and its definition, and its other names. For a relationship, it names its two classes, from and to. For a record kind, it names its class, its meaning, each field with its type, whether it is required, its term and its meaning, and each field's sources, the system and the field there.
  3. When the glossary has no row for the word, it says so, and offers to propose one, as section 2 says. Only then does it say fabrik holds no definition of the word. A file, a search hit or an earlier session that says fabrik has no definition never decides it. It does not answer from its own knowledge as if the glossary held it.
- **Evidence:** the rows the answer quotes, each with its `record_id` and `version_id`.

The glossary answer is `{"part": "glossary", "rows": [{"term", "kind", "definition", "other_names", "from_class", "to_class", "instance_of", "broader", "record_id", "version_id"}]}`, in the order of the terms. The dictionary answer is `{"part": "dictionary", "tables": [{"table", "class", "meaning", "record_id", "version_id"}], "columns": [{"table", "column", "type", "required", "term", "meaning"}], "sources": [{"table", "column", "system", "field"}]}`.

**AI guided:** the agent gives the person the rows it answered from, and waits for their approval.

## 2. Propose and save a term, class or relationship

The agent proposes a term when the person uses a word the glossary lacks, or asks to change one.

- **Responsible:** the person who approves the term. The agent never saves a term the person has not approved.
- **Person:** names the word, or agrees to the agent's proposal.
- **Agent:**
  1. Reads the glossary, as section 1 says, for the word and each of its other names, in any case.
  2. Proposes the term to the person: its name, its kind (term, class or relationship), its definition in plain words, its other names and, for a relationship, its from and to classes. It asks the person the meaning they use. It does not invent a definition.
  3. Calls `save_term` with `term`, `kind`, `definition`, `other_names`, `reason`, for a relationship `from_class` and `to_class`, and for a term of a class `instance_of` and `broader`, with `preview` true. The preview returns the `request` it would save, and the grant it would save with as `authorisation_id`. Its `actions` are `create` for a new term, or `edit` for a changed one.
  4. Shows the person the proposal and the preview: the title "Glossary: <term>", the kind, the definition, the other names and the ends.
  5. Once the person approves, calls `save_term` again with the same arguments and without `preview`. With changes, it shows the changed proposal and previews again.
  6. Reports the saved version: its `record_id`, `version_id` and `version_number`.
- **Evidence:** the preview, the person's approval in their words, and the saved `record_id`, `version_id` and `version_number`.

The rules:

- A relationship's ends must already be classes in the glossary. Save each class first, then the relationship.
- A term with `instance_of` is of kind term, and its class is already in the glossary. A term with `broader` also has `instance_of`, and its broader term is of the same class. Save the class first, then each term before the terms under it.
- To make an existing term one of a class, save it again with its definition and other names unchanged, and `instance_of` and `broader` added.
- A class at the end of a relationship or of a record kind stays a class.
- A term's name is fixed. A new name is a new term. Save the new name as a new term, with the old spelling among its other names. The old term stays until nothing uses it; it is deleted as the `fabrik:records` skill's section 7 says.
- A term is found in any case, so "MoS" and "mos" are one term. A save to an existing term keeps its spelling.
- A definition is 1 to 1,000 characters. A term has at most 20 other names.
- The relations a link between records may use are read with `get_reference` with `part` `relations`, and an administrator adds one with `save_relation_type`.

**AI guided:** the agent gives the person the proposal and the preview, and waits for their approval before the save.

## 3. Propose and save a record kind in the data dictionary

- **Responsible:** the person who approves the record kind. The agent never saves a record kind the person has not approved.
- **Person:** names the record kind and its fields.
- **Agent:**
  1. Reads the glossary and the data dictionary, as section 1 says.
  2. Proposes the record kind to the person: its name, in lower case letters, digits and underscores, its glossary class, its meaning, and each field with its type, whether it is required, the glossary term it holds, its meaning and the systems it comes from.
  3. Checks that the class, each field's term and each source's system are in the glossary. It proposes and saves each missing one first, as section 2 says, with the person's approval.
  4. Calls `fabrik_save_dictionary` with `p_table`, `p_class`, `p_meaning`, `p_columns` as `[{column, type, required, term, meaning, sources: [{system, field}]}]`, `p_reason`, and `p_preview` true. The fields given replace the record kind's fields, so a change gives every field the record kind keeps.
  5. Shows the person the proposal and the preview: the title "Data dictionary: <record kind>", the class, the meaning and each field.
  6. Once the person approves, calls `fabrik_save_dictionary` again with the same arguments and without `p_preview`.
  7. Reports the saved version: its `record_id`, `version_id` and `version_number`.
- **Evidence:** the preview, the person's approval in their words, and the saved `record_id`, `version_id` and `version_number`.

A record kind's name is fixed. A record kind has at most 200 fields, and a field is given once.

**AI guided:** the agent gives the person the proposal and the preview, and waits for their approval before the save.

## 4. History and the audit log

- **Responsible:** the person, who must be able to read the `reference` scope.
- **Person:** finds the record with `list_records`, `kind` `model` and `title` "Glossary: <term>", or "Data dictionary: <record kind>". Its versions, and who changed what, come from `fabrik_get_history` and `fabrik_get_audit`, which the connector has no tool for yet.
- **Agent:** takes the `record_id` from the glossary or dictionary row, or finds it with `list_records`. It calls `fabrik_get_history` for each version, with who saved it, when and why, and `fabrik_get_audit` for the events in a period, as the `fabrik:records` skill's sections 2 and 8 say. It gives the person each change: the version, who saved it, when and the reason.
- **Evidence:** the history and audit pages, each with its `version_id` or event id.

**AI guided:** the agent gives the person the changes it found, and waits for their approval.

## 5. Print the glossary or the data dictionary

The glossary, with its classes and relationships, and the data dictionary print as A4 PDFs from the current rows, as the `fabrik:print` skill's section 1 says.

## Problems

Each refusal below comes from `save_term` or `fabrik_save_dictionary`, or from the check fabrik runs on each saved version. Nothing is saved. The agent gives the person the refusal and what they can do.

From `save_term`:

- **"A term is 1 to 100 characters":** shorten the term.
- **"A term's kind is term, class or relationship":** give one of the three.
- **"A definition is 1 to 1000 characters":** write a definition, or shorten it.
- **"A term has at most 20 other names":** keep the 20 the business uses.
- **"A relationship names the class at each of its ends, as p_from_class and p_to_class":** give both classes.
- **"A relationship's ends are classes, and "…" is not a class in the glossary":** propose and save that class first, with the person's approval, then save the relationship again.
- **"Only a relationship names classes at its ends":** leave out `from_class` and `to_class` for a term or a class.
- **""…" is the class at the end of a relationship or of a record kind, so it stays a class":** keep its kind `class`. Propose a new term with its own name when the person means something else.
- **"A term's name is fixed: save "…" as a new term":** save the new name as a new term, with the old spelling among its other names.

From `fabrik_save_dictionary`:

- **"A record kind's name is lower case letters, digits and underscores, starting with a letter":** such as `quote`.
- **"A record kind's meaning is 1 to 1000 characters":** write a meaning, or shorten it.
- **"A record kind needs its glossary class, and "…" is not a class in the glossary":** propose and save the class first, as section 2 says.
- **"The fields are a list of at most 200":** give the fields as a list, of at most 200.
- **"A field's name is lower case letters, digits and underscores, starting with a letter: "…"":** rename the field, such as `asking_price`.
- **"The field … is given twice":** give each field once.
- **"The field … has a type of 1 to 40 characters":** give its type, such as `text`, `numeric` or `date`.
- **"The field … says whether it is required, true or false":** give `required` as `true` or `false`, not as text.
- **"The field … has a meaning of 1 to 1000 characters":** write its meaning.
- **"The field … holds "…", which is not in the glossary":** propose and save the term first, or leave the field's term out.
- **"The field … comes from "…", which is not in the glossary":** propose and save the system as a term first, such as Loop.
- **"The field … names its field in … in 1 to 200 characters":** give the field's name in that system.
- **"A record kind's name is fixed: save "…" as a new record kind":** save it under a new name.

From the check on each saved version:

- **"A glossary term or a record kind is a model record in the reference scope"**, **"A glossary term's record holds one node, the term"** or **"A record kind's record starts with its table node":** the version was not made by `save_term` or `fabrik_save_dictionary`. Save the change with those.

Access and setup:

- **"Scope or record unavailable":** the person has no grant on `reference`. An administrator grants read there to read, and the create and edit actions to save, as the `fabrik:records` skill's section 1 says.
- **"No grant of yours covers … on … records in …":** the person can read `reference` but not save there. An administrator can grant it, or approve this exact change, as the `fabrik:records` skill's section 5 describes.
- **"Every save by this actor needs a person's approval":** the actor saves only with an approval. Save the preview's `request` with an approval, as the `fabrik:records` skill's section 5 describes.
- **"The reference scope is not set up":** setup has not created the `reference` scope. The owner finishes setup by running `fabrik setup --owner` again, which carries on from where it stopped.
- **"Name the glossary or the dictionary":** `get_reference` takes `part` `glossary`, `dictionary` or `relations`.
