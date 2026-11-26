---
name: records
description: Use when a person, or their agent, works in fabrik's records as themselves. Covers scopes and grants, finding and reading records, history, progress, the audit log and sign-ins. Covers saving records, states, assigned tasks, approvals, the task functions, moving records, limited grants, renaming or deleting a scope, private scopes and access templates. Covers the connections between what a scope's files name, and finding a routine's version in force. Each task names the connector tool the agent calls, or the database function where the connector has no tool.
---

# fabrik records

This skill is how a signed-in actor works in the records of fabrik, the business's organisational knowledge base. Changes to fabrik are made by the assistant, `@fabrik:assistant`, which follows this skill's rules on asking before each change. A session that is not the assistant calls it for each change. It passes on the person's answer, quoting their words with the change the agent proposed.

Every task is a call to a tool of the fabrik-apps connector, as the signed-in person: `search`, `get_record`, `list_records`, `save_record`, `link_records`, `unlink_records`, `list_scopes`, `get_reference`, `save_term`, `save_relation_type`, `upload_file` and `read_file`, and `show_records`, `show_board` and `show_graph`, which draw a list, a board and a graph. It also has `remember`, `update_record`, `lookup_by_name`, `delete_record`, `restore_record`, `ingest_document`, `profile_get` and `profile_update` for notes, documents and the person's profile; `project_create`, `project_list`, `project_get`, `project_update`, `project_complete`, `task_create`, `task_update`, `task_list`, `task_get`, `task_ready` and `task_complete` for projects and tasks; `workflow_save`, `workflow_list`, `workflow_get` and `workflow_delete` for workflows; `contact_create`, `contact_lookup`, `contact_update`, `contact_list`, `contact_delete`, `contact_export`, `group_create` and `group_manage` for contacts and groups; `voice_tag_content`, `voice_distil_profile`, `voice_get_conditioning` and `voice_record_feedback` for the person's writing voice; and, for an administrator, `mail_list_mailboxes`, `mail_read`, `mail_search`, `mail_fetch_body` and `mail_fetch_attachment` to read a mailbox set up in fabrik, `mail_save_attachment` to save an attachment into a scope's files, `mail_draft`, `mail_draft_edit`, `mail_draft_list` and `mail_draft_send` for its drafts, `mail_send` and `mail_reply` to send from it without a draft, `mail_signature_set` to set its signatures, `mail_delete` to move its messages to Trash, and `show_mail_setup` to set a mailbox up: the person types its password on that card, never in the chat. Each tool's description gives its arguments. A task the connector has no tool for yet names the database function instead, in the `fabrik` schema, which the fabrik plugin's `rpc` tool calls as the same person. fabrik itself decides what each call may see and change, from the actor's grants. A record the actor may not read is absent, and a change the actor may not make is refused.

When the person asks for an email from a mailbox in fabrik, draft it first with `mail_draft`. Tell them it's in the mailbox's Drafts folder. Send that draft with `mail_draft_send` only once they approve sending it. Use `mail_send` and `mail_reply` only when the person asks to send without a draft. Set a mailbox's signatures with `mail_signature_set`. For an HTML file the person gives, read it and pass its text as `html`.

When the person wants an email attachment that isn't text, such as a PDF, read or searched, save it into a scope with `mail_save_attachment`. First tell them the attachment's name, the scope and the path, and save it once they approve. File search then reads a PDF's text, so `read_file` reads it and `search` finds it.

Each step's **Person** line says what the person asks for, and which connector tool answers it.

The **records** are activities, decisions, evidence and models, each in a **scope**. A record never changes in place: each change saves a new **version**, and every version stays in the record's history. fabrik's work records data model sets the rules each kind follows.

A call to a tool looks like this, with the tool's own argument names:

```json
{"tool": "list_scopes", "arguments": {"limit": 100}}
```

A call to a database function looks like this, with the function's own argument names:

```json
{"function": "fabrik_get_actor", "schema": "fabrik", "args": {}}
```

## Choose the mode

The person chooses the mode.

- **Human only:** the person follows the Person lines below, without the agent. They do each step with the connector's tools. A step the connector has no tool for is the agent's.
- **AI guided:** the person asks the agent to guide them. Before each step, the agent says what the step does and shows the Person line. It follows its own line with the person watching, or asks the person to follow theirs. It stops for the person's approval at the end of each stage.
- **Human directed:** the person tells the agent what to do. The agent follows its lines for each step the person directs.

Each step below gives a **Person** line and an **Agent** line.

With the agent, the person's own instruction replaces a rule of this skill, such as the order of the reads. The agent names the rule once and does as told. A refusal from fabrik or a tool still stands, and the agent gives it to the person with what they can do instead. An autonomous agent follows the Agent lines, in human directed mode, with the person accountable for it as the person.

## 1. The actor, their scopes and grants

- **Responsible:** the actor.
- **Person:** asks who they are in fabrik, or what they can work on. `list_scopes` gives the scopes.
- **Agent:** calls `fabrik_get_actor` for the actor's own record. It gives the person their name, and whether they are an `administrator` or `restricted`. The record also holds whether they are a person, an agent or an application, and whether every save needs approval. It holds the person accountable for them. The agent gives these only when the person asks. A person who is an administrator can read and save in every scope that is not private, with no grant. They upload and delete its files too. An agent that is an administrator can read in every scope that is not private and handle its files. In a private scope, an administrator holds only the grants its owner gives, as section 20 describes. It still passes a grant's or an approval's id with every save. Every record deletion needs an approval, whoever makes it. A restricted actor can do only what their grants allow. Then calls `list_scopes` for the scopes the actor may read, and `fabrik_get_authorisations` for the actor's own grants: each grant's scope, record kinds, actions and expiry. A grant is limited to the actor's own records when its `own_records` is true. A person who is an administrator usually holds none, and needs none. Both return `items`, and a `next_cursor` only when the page is full and there may be more; `list_scopes` takes it back as `cursor`, and `fabrik_get_authorisations` as `p_cursor`, for the next page. `fabrik_get_history` and `fabrik_get_progress`, in section 2, page the same way.
- **Evidence:** each call's result, quoted.

**AI guided:** the agent gives the person their actor record, scopes and grants, and waits for them before the next step.

## 2. Reading

- **Responsible:** the actor.
- **Person:** names a record, or asks about the work in a scope. `list_records` with `title` finds a record, and `get_record` with `record` reads it. A record's versions and a scope's work come from `fabrik_get_history` and `fabrik_get_progress`, which the connector has no tool for yet.
- **Agent:** calls:
  - `list_records` to find a record the person names by its title or kind, with no record id. It lists each record the actor may read once, at its latest version, newest save first: `{"record_id", "kind", "scope_id", "title", "version_id", "version_number", "change_no", "saved_at", "saved_by"}`. It takes `kind`, one of `activity`, `decision`, `model` or `evidence`, `scope_id`, and `title`, words that must all appear in the title, in any case. Each is left out when not needed. Paging passes the answer's `cutoff` as `cutoff` and its `next_cursor` as `cursor`, while the answer has one. When more than one record fits, the agent lists each one's title, scope and when it was saved, and asks the person which they mean.
  - `get_record` with `record`, a record id or an exact title, for a record's latest version and its links. A refusal that no record the actor may read has that id or title means the record does not exist or the actor may not read it; the agent says exactly that, and nothing more. The person may name a file in the agent folder to read the record into, as the `fabrik:graph` skill does. The agent then calls `fabrik_get_record` with `p_record_id` and `result_file`, the file's full path, through `rpc`, which `get_record` cannot do. The `rpc` tool never replaces a file already there. A refused call has no result: name a new file and call again.
  - For what a scope holds, `list_records` with `scope_id`, and the actor skill's `list_files` for the scope's code. It gives the records by kind, with each one's title, who saved it and when, then the files by folder.
  - For a person's work, `list_records` for each scope the person names, or each scope `list_scopes` lists, keeping the records whose `saved_by` is that person's name. Then `fabrik_get_assigned`, keeping the tasks among those records. It names that person's sessions scope where `list_scopes` lists it, and offers to search it.
  - `fabrik_get_history` with `p_record_id` for every version, each with who saved it, when, why, and which fields changed. Paging passes the answer's `cutoff` as `p_cutoff` and its `next_cursor` as `p_cursor`, while the answer has one.
  - `fabrik_get_assigned` for the tasks assigned to the actor, as section 9 describes.
  - `fabrik_get_progress` for the activities the actor may read, with counts by state and each activity's dates, blockers and dependencies. For one scope, all five arguments are passed: `p_cutoff`, `p_observed_at`, `p_cursor`, `p_limit` and `p_scope_id`, with null for the ones not needed. Each activity carries its `state`, and its `parent` plan, `{"record_id", "referenced_version_id"}` or null, and its `evidence`: each evidence version its version links to as `supports`, `{"record_id", "referenced_version_id", "current_version_id", "title", "standing", "deleted"}`, or `[]`. Each activity also carries `assignee_name`, and each plan the person who created it, as `creator_actor_id` and `creator_name`. Each activity's `payload` names its owner in `owner_actor_id` and `owner_label`, as section 9 describes. To see a plan as a board, the agent calls `show_board` with the plan. To keep it as a page, it reads each page into a file with `result_file`, as the `fabrik:board` skill does.
- **Evidence:** each call's result, quoted.

**AI guided:** the agent gives the person what it read, with the call it made, and waits for them before the next step.

## 3. Saving a version

Every change, including a new record, is a call to `save_record`. To add a record, it takes `scope`, `kind`, `title`, `reason`, `fields` and, for a task in a plan, `parent`. To change one, it takes `record`, `reason`, `fields` for only the fields to change, and `title` to rename it. Links are saved with `link_records` and `unlink_records`, as section 11 describes.

`save_record` makes the request below itself. `fabrik_save_version`, which an approved change uses as section 5 describes, takes it as `p_request`, with `p_authorisation_id`. The request has exactly these keys, all of them, and no others:

| Key | Value |
|---|---|
| `request_id` | a new UUID for each change; the same one again only to retry a change whose answer was lost |
| `record_id` | a new UUID for a new record; the record's own for a new version |
| `scope_id` | the record's scope, set when it is created. A person who is an administrator can move it, as section 12 describes |
| `kind` | `activity`, `decision`, `evidence` or `model`, which never changes |
| `expected_previous_version_id` | null for a new record; otherwise the `version_id` of the latest version, from `get_record` |
| `title` | the record's title |
| `reason` | why this change is made |
| `payload` | the record's fields, as its kind sets out below |
| `links` | every link this version has, `[]` for none: each `{"target_version_id", "relation"}`, with an optional `locator` and `note` |

A link's `relation` is one of the relations `get_reference` with `part` `relations` returns, which setup seeds with `supports`, `describes`, `parent` and `depends_on`. An administrator adds another with `save_relation_type`, and a link naming a relation not on the list is refused. It points at an exact version in the same scope. `parent` and `depends_on` join activities only, a `parent` is a plan, and an activity has at most one.

**Authority.** Every actor except a human administrator needs the id of a grant that covers the change, and `save_record` finds it and passes it. An actor that needs a person's approval for every save passes the approval's id, from section 5, as `fabrik_save_version`'s `p_authorisation_id`. A human administrator may leave it out.

The grant is found with `fabrik_get_authorisations`. It is a live grant in the record's scope, whose record kinds include the record's kind, and whose actions include every action the change needs. A new record needs `create`, and any new version needs `edit`. An activity's change of state also needs the action in section 4. A decision that is made or changed needs `decide`.

With no such grant, the agent saves nothing and says which action is missing. An administrator can grant it, or approve this exact change, as section 5 describes.

**Kinds.** Each payload, which is `fields` in `save_record`, has exactly these fields:

- **activity:**
  - `activity_kind`: `plan` or `task`, fixed once saved.
  - `state`: `pending`, `in_progress`, `paused`, `completed` or `cancelled`. A new activity is `pending`.
  - `owner_actor_id`: the id of the person who owns the activity, as section 9 describes. fabrik writes their name into `owner_label`.
  - `description`, `completion_requirements` and `completion_note`.
  - `baseline_start_at`, `baseline_finish_at`, `forecast_start_at` and `forecast_finish_at`. Each is null, or a time with its time zone, such as `YYYY-MM-DDThh:mm:ssZ`. The baseline changes in any state, with the reason in `reason`.
  - `blockers`, each `{"blocker_id", "description"}`, and `external_references`, each `{"label", "reference"}`.
  - It may also carry `index`, one line of at most 20 characters. A task may carry `task_type`: `work`, `deliverable` or `blocker`.
  - A task may also carry `assignee_actor_id`, the id of the person it is assigned to, or null, as section 9 describes.
- **Any kind** may also carry these optional fields:
  - `source`: `{"system", "id"}`, both text, the system a record came from and the id it had there. `fabrik_find_by_source` finds a record by them.
  - `type`: text of 1 to 100 characters, the record's type in that system.
  - `labels`: a list of text, the labels it had there.
  - `properties`: an object with any keys, the properties it had there.
- **decision:** `question`, `alternatives` (a list of text), `decision` (empty while undecided), `rationale` and `decided_on` (a date, `YYYY-MM-DD`, or null while undecided).
- **evidence:** `summary`, `source_reference` (or null), `source_date` (a date, or null), `standing` (`stated`, `observed` or `unverified`) and `limitations`; optionally `file_sha256`, the file's SHA-256 checksum.
  - `source_reference` is a link, plain words or null. A link starts `https://`, in any case, with no `?` part, and may have a `#` part. Any other scheme with `://`, such as `http://`, is refused. Plain words name the source, such as `Vendor call, 10 Oct 11:00`. They start with neither `/` nor `\`, and hold no `..` between slashes. An external reference's `reference` is the same.
- **model:**
  - `model_kind`: `observed_current` or `proposed_target`.
  - `source_version`, `source_status` and `description`.
  - `graph`: `{"format_version": 1, "nodes": [...], "edges": [...]}`. Each node is `{"id", "type", "label", "attributes"}`, and each edge `{"id", "source", "target", "type", "attributes"}`. Every edge's source and target is a node's id.
  - The person may name a file in the agent folder that holds the payload, as the `fabrik:graph` skill does. `save_record` takes `fields` in the call itself, so the call is then `fabrik_save_version` through `rpc`, with `file_args` `{"/p_request/payload": "<the file's full path>"}`, and the rest of the request in `args` as usual.
  - A saved version returns its whole payload. A large one saved with `fabrik_save_version` carries `result_file` too, and the agent reports the ids from the reply's `summary`.

A new version carries the whole record again. `save_record` reads the latest version first, changes what the person asked for, and keeps the rest as it was.

**Deliverables.** An activity's `completion_requirements` are its deliverables: what must exist for it to be completed.

- For a new activity, the agent asks the person for its deliverables, and shows any that the source document states.
- The person may leave them empty. The agent then tells the person the activity can be completed once its deliverables are written, in a new version.
- When the agent builds activities from a document, it takes what the document states. That is each activity's deliverables, dates and `depends_on` links, and nothing more.

**Index, deliverables and blockers.** A plan's board and graph are drawn from its activities, in index order.

- Each activity in a plan carries its `index`, kept apart from its title. A title carries no number.
- A part of the plan is `<n>`, such as `2`. A task is `<part>.<n>`, such as `2.2`. A deliverable is its task's index and a letter, such as `2.2a`. A blocker is its task's index, `-B` and a number, such as `2.2-B1`.
- Each task carries its `task_type`. A deliverable is its own task, with `task_type` `deliverable`, under the same plan as its task, and the task `depends_on` it.
- A blocker is its own task, with `task_type` `blocker`, under the same plan as the task it holds up, and that task `depends_on` it. The task also lists it in `blockers`, with `blocker_id` set to the blocker's own `record_id` and `description` set to its title.
- A blocker is cleared in two saves: the blocker is completed, and the task's next version leaves it out of `blockers`.
- Two activities in one plan never share an index.

- **Responsible:** the actor, and the person accountable for them.
- **Person:** says what to record or change, and approves the save before it is made. `save_record` with `preview` true shows the change first.
- **Agent:**
  1. Calls `save_record` with `preview` true. It names the record by its id. Its preview holds the request, with the latest version read and the grant found.
  2. Shows the person what it will save: the scope, the kind, the title, the reason, each field it changes, and the links. For an activity, it shows the deliverables, or "Deliverables: none". It saves once the person agrees, and never a change they decline.
  3. Calls `save_record` again with the same arguments, without `preview`. A model's payload from a file is a request built as this section describes, saved with `fabrik_save_version`. When the answer is lost, it reads the record with `get_record` to see whether the version was saved, before it calls again. When the answer says another save changed the record, it reads the record again and shows the person the newer version before trying again.
- **Evidence:** the saved version's `version_id` and `version_number`, and the call's result.

**AI guided:** the agent shows the person each save before it is made, and waits for their approval.

## 4. An activity's state

An activity moves between states only these ways, each needing its own action as well as `edit`:

| From | To | Action |
|---|---|---|
| pending | in_progress | `start` |
| in_progress | paused | `hold` |
| paused | in_progress | `start` |
| in_progress | completed | `complete` |
| completed | in_progress | `reopen` |
| pending, in_progress or paused | cancelled | `cancel` |

A person reads them as Pending, In progress, Paused, Completed and Cancelled.

A cancelled activity stays cancelled. Completing an activity needs its completion requirements and a completion note, no blockers, and at least one `supports` link to an evidence version. A save that changes a completed activity's completion requirements must also set its state to `in_progress`, which is the `reopen` action.

- **Responsible:** the actor.
- **Person:** asks for the change. Completing needs a completion note, which the agent asks for.
- **Agent:** saves a new version with the new `state` with `fabrik_set_state`, as sections 3 and 11 describe.
- **Evidence:** as section 3.

**AI guided:** the agent shows the person each state change before saving, and waits for their approval.

## 5. Approving another actor's change

An administrator can approve an agent's exact change, once, instead of granting it standing permission. In a private scope, its owner approves in place of an administrator, as section 20 describes.

- **Responsible:** the administrator.
- **Person:** an administrator reviews the exact request the other agent will send.
- **Agent:** working for the administrator, calls `fabrik_approve_change` with a reason and these arguments. `p_issuance_request_id` is a new UUID, and `p_executor_id` the other actor's id. `p_request` is the exact request, and `p_expires_at` an expiry in the future. The other agent then calls `fabrik_save_version` with that request, unchanged, and the approval's `authorisation_id`. An approval is used once; any difference in the request is refused.
- **Evidence:** the approval's `authorisation_id`, and the save that used it.

**AI guided:** the agent shows the administrator the exact request before approving it, and waits for their approval.

## 6. Answering a question

- **Responsible:** the actor.
- **Person:** asks a question about fabrik, its terms or its work. `search` with the question as `query` searches the records and files together, and each hit's section gives the text to answer from.
- **Agent:** answers only from what fabrik returns to it in this session:
  - For what one of the business's words means, it reads the glossary before any file search. It calls `get_reference` with `part` `glossary`, as the `fabrik:reference` skill's section 1 says. The glossary is a table in fabrik, not a file, and file search never finds it. A definition comes from the term's row there, matched on its name or one of its other names, in any case. The agent names the glossary as its source.
  - For what fabrik's records and documents say, it searches them as the `fabrik:actor` skill's "Search results" describes. It calls `search` with the question as `query`, and `scope` for one scope. Each hit is a record or a file, as its `found_as` says, and the reply gives each hit's section. If the hits do not answer it, it searches again in other words.
  - A search across every scope returns two lists. `reference_hits` holds the top hits in the reference scope's files, ranked apart from everything else. `hits` holds the top hits from every other scope. The agent reads `reference_hits` first. A search across every scope leaves each person's sessions scope out. The agent searches one only when the person asks about an earlier session, as section 17 says. Kinetik's guides are in the Guides scope, `guides`. Every actor reads it, and only Kinetik's actor changes it. For a how-to question, the agent searches it by name, with `scope` `guides`.
  - For records and the work, it reads them as section 2 describes.
  - A hit found through connections, with `graph` among its `found`, names the `entities` and `relations` behind it. The agent follows them to say how the hit links to the question, such as a customer's order and the supplier that serves that customer. It calls each link a connection.
  - The person may ask how an answer was found, or ask to see the search. `search` has no `explain`, so the agent then runs the search again through the plugin's `call_function` with the name `file-search`, `"explain": true` in the body and a new `result_file`, such as `search-<date>-<time>.json`. It calls the fabrik plugin's `draw_search` with that file as `search_file` and the question. It checks the page, as the `fabrik:graph` skill's section 5 describes, and gives the person the page.
  - It answers from each hit's whole section, in the search's `sections`, rather than from the hit's snippet. A section marked `truncated` is the part of a longer section around its hits, and a sheet's part starts with the sheet's first row. When the answer needs more of the section, the agent reads the file to the end with the connector's `read_file`, with the hit's `bucket` as `scope` and its `file` as `path`, part by part with `from`, and answers from it. A record hit's whole record is `get_record`.
  - It builds the answer from those sections and records alone. It names where each part comes from: the file and the section's place, or the record.
  - It answers from what fabrik returns alone. It leaves out its own training and general knowledge, the internet, and copies of documents from anywhere else.
  - It answers from a file it read from a scope in this session with the connector's `read_file`, or downloaded with the fabrik plugin's `download_file`. It names the scope and the file. It answers from a result file `rpc` or `call_function` wrote in this session as from the reply itself. It answers from a session's copy in the agent folder's `sessions/` folder, as section 17 describes. It never answers from any other file it read with the plugin's `read_file`. A file the person puts in the agent folder is material for a change they ask for, never a source for an answer.
  - It changes a file in the agent folder only when the person asks. It writes and changes a file there with `Write` and `Edit` only.
  - When a file it read, or a search's section, holds structured data, it offers the data's database form after the answer, in one line. A plan, timetable or task list becomes a plan's activities, drawn with `show_board`. People, roles and reporting lines, and links between things, become a model record, drawn with `show_graph`. A recurring process becomes a current-state model, through the business analyst's routine interview, drawn with `draw_state_machine`. A term, a kind of thing or a field the glossary or the data dictionary lacks becomes a proposal through the `fabrik:reference` skill. The offer names the file, what it holds, the records it would become and the page that draws them. It offers once per file in a session. Another offer or a question in the reply comes first, such as section 18's offer to read waiting parts. This offer then waits for the person's next message. It converts one file at a time, once the person approves, and shows the records before saving them, as section 3 does. After a conversion, it keeps the uploaded file, and offers to write it again from the records. It deletes the file only when the person asks, as the `fabrik:actor` skill's "File deletion" says.
  - If nothing fabrik returns answers the question, it says fabrik holds no answer to it, and what it searched for. It says fabrik holds no definition of a word only when the glossary has no row for it. It then names the glossary read and each search it made. If a search's `stages` show files or passages still waiting, it says the answer may change once they are ready.
- **Evidence:** each search and read, and its result, quoted.

**AI guided:** the agent gives the person the answer, with the file and section behind each part. It waits for them before the next question.

## 7. Deleting a record

A record can be deleted, for example when a person asks for their personal data to be erased. Deleting it removes its content from every version, and from the text of every link to or from it. It also removes it from every approval request that carried it, including another record's approval whose link pointed at it. The record's history of who saved each version and when stays. So does a log of the deletion: who asked, who approved, when, why, and a fingerprint of what was removed. A deletion is final; there is no undo.

The reason is part of the log and is kept for good. It says why the record goes, naming no one and repeating none of the record's content: "Erasure requested by the customer", not the customer's name.

An administrator may approve their own deletion. While fabrik has a single administrator, no other person could approve it, and the approval still records the exact deletion, once, as its own step.

In a private scope, its owner approves each deletion in place of an administrator, as section 20 describes.

- **Responsible:** the actor who deletes, and the human administrator who approves. In a private scope, its owner approves.
- **Person:** names the record and says why it should go. An administrator, who must be a person, approves the exact deletion. In a private scope, its owner approves it.
- **Agent:**
  1. Calls `fabrik_preview_deletion` with `p_record_id`. The answer shows the record's title, and how many versions, links and approvals would be emptied. It shows the `dependents`, the records whose latest version links to it, and the `request` to approve. The dependents may include records the person cannot read; the agent gives their number, and the ids of those the person can read.
  2. Shows the person all of that, in plain words, and says that the deletion cannot be undone. Waits for their agreement and their reason.
  3. Puts the reason into the request's `reason`, changing nothing else.
  4. Asks for the approval. If the person is an administrator, the agent, working for them, calls `fabrik_approve_change` with the request, as section 5 describes, naming the person as `p_executor_id`. Otherwise the person asks an administrator, whose own agent approves it. In a private scope, the owner's agent approves it in the same way, and a person who is not the owner asks the owner.
  5. Calls `fabrik_delete_record` with the request, unchanged, as `p_request`, and the approval's `authorisation_id`. The answer is the deletion's log entry: how many versions, links and approvals were emptied, and the `content_sha256`.
- **Evidence:** the preview, the approval, and the deletion's log entry.

Records that link to a deleted record keep their links, which now point to a deleted record. Only the link's note and locator are emptied. A linking record's own content, such as its summary or description, stays. If it repeats what was deleted, that record needs its own deletion or a new version. An approval not yet used whose request carried the record is emptied too, and the save it approved can no longer be made. A save that links to a deleted record is refused, and needs a new request without that link.

Files are separate: deleting a record, even an evidence record, leaves its files, and deleting a file is its own action, as "Files" describes.

**AI guided:** the agent shows the person the preview, the approval and the deletion, each before it is made. It waits for their approval at each.

## 8. The audit log

fabrik keeps a log of what happened in it:
- each save, deletion and move of a record;
- each grant or approval given, and each grant revoked;
- each change to an actor;
- each change to a scope's name or description, and each deletion of a scope;
- each upload, replacement, move and deletion of a file in a scope;
- each sign-in, sign-out and expired session;
- each change fabrik refused for want of permission;
- each change to an access template;
- each time a person's sessions are made private, as `sessions_made_private`, or ordinary again, as `sessions_made_ordinary`.

An administrator sees every event outside a private scope, including each deletion of a scope, and in a private scope their own. Anyone else sees:
- the saves and deletions of records they may read, and the moves of records they may read in either scope;
- the grants and approvals given to them, and changes to their own actor;
- the file events, the changes to a scope's name or description, and the changes to their own sessions' privacy, in scopes where they may read;
- the changes fabrik refused them;
- each change to an access template.

A private scope's owner also sees each change fabrik refused in it.

- **Responsible:** the actor.
- **Person:** asks what happened in fabrik over a period.
- **Agent:**
  1. Turns the period into a start and an end, in UK time unless the person names another time zone, and calls `fabrik_get_audit` with `p_from` and `p_to`. It passes the answer's `next_cursor` back as `p_cursor`, while the answer has one. If there are more than a few pages, it says how many events it has so far and asks before reading on.
  2. Reports the events in time order. Each has its time, who did it, what they did, and to which record, file or person, in the scope it names. `actor_name` is who did it. For a deletion, it also names who approved it and the reason.
     A file event's `attributed_by` says how its actor is known:
     - `sign_in`: the person signed in to the change.
     - `storage_owner`: Storage made the change, and recorded no one signed in. The actor named is the file's owner, as Storage has it, who may be someone other than the one who made this change. The agent says "the file's owner, per Storage", never that they made it. With no actor named, the owner is not a fabrik actor; the agent says so.
     - `none` with the `login` `supabase_storage_admin`: Storage made the change, and the person was not recorded; the agent says so.
     - `none` with any other `login`: the change came from outside fabrik, such as the Supabase dashboard; the agent says so.

     A `signed_in`, `signed_out` or `session_expired` event names the person or agent as `actor_name`, with the session's `user_agent` and `ip`. `session_expired` is a session Supabase removed after it timed out, with no one signing out.

     A `change_refused` event is a change fabrik refused and undid. `actor_name` is who was refused, `function` the function called, `kind` and `record_id` the record where the call named one, and `problem` fabrik's message. Its scope is given only to someone who may see the scope.

     An `access_template_changed` event names the template as its subject, with `old_grants` and `new_grants`. A `scope_handed_on` event names the new owner, with `old_owner_name` and `new_owner_name`.
  3. For a record's full history, calls `fabrik_get_history` with the event's `record_id`, as section 2 describes.
- **Evidence:** each call's result, quoted.

**AI guided:** the agent gives the person the events, and waits for them before reading another page.

## 9. An activity's owner and a task's assignee

Every activity has one owner, the person accountable for it. The owner is an enabled person in fabrik who can read activities in the activity's scope.

A save names the owner in `owner_actor_id`, and fabrik writes the owner's name into `owner_label`. A save with no owner, or with an owner who is not such a person, is refused. A new activity made with `save_record` is owned by the person the actor answers to, unless `fields` names an owner. A blocker or deliverable made with `fabrik_add_blocker` or `fabrik_add_deliverable` is owned by its task's owner.

A task can also be assigned to one person: a person in fabrik who can read activities in its scope. The assignee is the person doing the task, and the owner the person accountable for it.

**Setting an owner.** Setting or changing an owner is a new version of the activity, as section 3 describes, with `owner_actor_id` set to the person's `actor_id`. It needs `edit`. Owning an activity gives the person no grant.

- **Responsible:** the actor, and the person accountable for them.
- **Person:** names the person who owns the activity.
- **Agent:**
  1. Calls `fabrik_find_people` with `p_scope_id`, the activity's scope, and `p_name`, the words of the name the person gave.
  2. When more than one fits, lists their names and asks the person which they mean. When none fits, says so, and that an administrator can add them to fabrik or give them read in the scope.
  3. Calls `fabrik_set_owner` with `p_preview` true and the person's name as `p_person`. Shows the save as section 3 describes, with the owner's name in place of their id, and the name of the owner it replaces.
  4. Saves only when the person agrees, with the preview's request, as section 3 describes.
- **Evidence:** the saved version, and the activity's history, where `owner_actor_id` is among the changed fields.

**Activities without a valid owner.** `fabrik_find_unowned` with `p_scope_id` lists the activities in the scope that the actor may read and that lack a valid owner. That is an activity whose latest version has no owner, or an owner who is no longer an enabled person who can read the scope. Each item carries `record_id`, `index`, `title`, `activity_kind`, `owner_actor_id` and `owner_label`, the name saved on it, as text.

- **Responsible:** the administrator, after any change to grants.
- **Person:** names the owner of each activity listed.
- **Agent:**
  1. Calls `fabrik_find_unowned` for each scope the actor may read that holds activities.
  2. For each activity listed, shows its index, title and the name saved in `owner_label`, and the person in `fabrik_find_people` whose name matches it, if one does.
  3. Asks the person who owns each, and sets each owner with `fabrik_set_owner`, as "Setting an owner" describes, only with the person's approval.
  4. Calls `fabrik_find_unowned` again, and reports what it still lists.
- **Evidence:** each call's result, quoted, and each saved version.

**Assigning a task.** Assigning, reassigning and removing an assignee is a new version of the task, as section 3 describes, with `assignee_actor_id` set to the person's `actor_id`, or null. It needs `edit`, or `create` for a new task. Being assigned a task gives the person no grant.

- **Responsible:** the actor, and the person accountable for them.
- **Person:** names the person the task is for.
- **Agent:**
  1. Calls `fabrik_find_people` with `p_scope_id`, the task's scope, and `p_name`, the words of the name the person gave. It lists the people a task in that scope can be assigned to, `{"actor_id", "display_name"}`, and none when the actor cannot read the scope.
  2. When more than one fits, lists their names and asks the person which they mean. When none fits, says so, and that an administrator can give that person read in the scope.
  3. Calls `fabrik_assign` with `p_preview` true and the person's name as `p_person`, and shows the save as section 3 describes, with the assignee's name, never their id. A reassignment also names the person the task moves from.
  4. Saves only when the person agrees, with the preview's request, as section 3 describes.
- **Evidence:** the saved version, and the task's history, where `assignee_actor_id` is among the changed fields.

**The tasks assigned to the actor.** `fabrik_get_assigned` lists the tasks assigned to the actor that they may read, at their latest version, soonest finish first. It leaves out completed and cancelled tasks unless `p_include_closed` is true. Each item carries `record_id`, `scope_id`, `scope_name`, `title`, `version_id`, `version_number`, `index`, `state`, `description`, `completion_requirements`, `baseline_finish_at`, `forecast_finish_at`, `overdue_seconds`, `blockers`, `parent` (`{"record_id", "title"}` or null) and `unfinished_dependencies`, a count. Paging passes the answer's `cutoff` as `p_cutoff` and its `next_cursor` as `p_cursor`, while the answer has one.

- **Responsible:** the actor.
- **Person:** asks what is theirs to do.
- **Agent:** calls `fabrik_get_assigned`, and reads a task the person picks with `get_record`.
- **Evidence:** each call's result, quoted.

**AI guided:** the agent shows the person each assignment before saving it, and waits for their approval.

## 10. Who has signed in

`fabrik_get_sign_ins` lists each person and agent with a fabrik login, latest activity first. It needs an administrator. Anyone else is refused with `Administrator required`.

Each item carries `actor_id`, `actor_name`, `actor_kind`, `authority_class`, `enabled`, `email`, `login_created_at`, `last_sign_in_at`, `last_active_at`, `open_sessions` and `latest_session` (`{"signed_in_at", "user_agent", "ip"}` or null). `last_sign_in_at` changes only when the person signs in again. `last_active_at` is the latest time a session was renewed, which happens about once an hour while it is in use.

- **Responsible:** an administrator.
- **Person:** asks who has used fabrik, or when someone last used it.
- **Agent:**
  1. Calls `fabrik_get_sign_ins` with no arguments: `{"function": "fabrik_get_sign_ins", "schema": "fabrik", "args": {}}`.
  2. Shows each actor's name, kind, last activity and last sign-in in UK time, and their open sessions. An actor with no sign-in is shown as never signed in.
  3. For sign-ins and sign-outs over a period, reads the audit log, as section 8 describes.
- **Evidence:** the call's result, quoted.

**AI guided:** the agent gives the person each actor's sign-ins, and waits for them before the next step.

## 11. Task functions

Each task function makes one change to a record and saves it as section 3 describes. The connector has a tool for some: `get_record` for `fabrik_show_record`, `save_record` for `fabrik_add_record` and `fabrik_change_record`, `link_records` for `fabrik_link` and `fabrik_link_many`, and `unlink_records` for `fabrik_unlink`. The agent calls the others as functions.

- A record is named by its record id, or by its exact title in any case, among the records the actor may read. A title names the one record not deleted with `delete_record` that has it, and a record deleted that way only when no record not deleted has it. A title that fits more than one is refused, with each one's title, scope, last save and id, and `deleted` beside each deleted one.
- A scope is named by its id, its code or its name.
- A record keeps its other fields and its links, unless the function changes them.
- The grant is the actor's live grant that covers the change, soonest expiry first. A person who is an administrator needs none.
- `preview` true, or `p_preview` true on a function, saves nothing, and returns `request`, `authorisation_id` and `actions`: the exact request and grant the save would use. Without it, the function saves, and returns the saved version.
- An actor whose every save needs a person's approval gets the preview, and is refused the save. An administrator approves the preview's request, as section 5 describes.

| Function | Arguments | The change |
|---|---|---|
| `get_record` | `record` | None. It reads the latest version, its scope's name, and each link with the title and index of its target's latest version. |
| `save_record`, to add | `scope`, `kind`, `title`, `reason`, `fields`, `parent` | A new record. A field not given is empty, and a new task's `task_type` is `work`. `parent` names its plan. |
| `save_record`, to change | `record`, `reason`, `fields`, `title` | The fields given, and the title when one is given. |
| `fabrik_set_state` | `p_record`, `p_state`, `p_reason`, `p_note` | An activity's state, as section 4 sets out. `p_note` is the completion note. |
| `link_records` | `record`, `links`, `reason` | One or several links saved as one version, each to the target's latest version. `links` is a list of `{"target", "relation", "note", "locator"}`, at most 200. Each replaces the record's link of that relation to the same record, and a `parent` replaces the parent. A list that names one link twice is refused. |
| `unlink_records` | `record`, `target`, `relation`, `reason` | The record's link of that relation to the target, removed. |
| `fabrik_assign` | `p_record`, `p_person`, `p_reason` | A task's assignee, by words of their name, as section 9 describes. Null removes the assignee. |
| `fabrik_set_owner` | `p_record`, `p_person`, `p_reason` | An activity's owner, by words of their name, as section 9 describes. |
| `fabrik_add_blocker` | `p_task`, `p_title`, `p_requirements`, `p_reason` | A blocker under the task's plan, at the task's index with `-B` and the next number. `p_requirements` is what clears it. The task depends on it and lists it in `blockers`. |
| `fabrik_add_deliverable` | `p_task`, `p_title`, `p_requirements`, `p_reason` | A deliverable under the task's plan, at the task's index and the next letter. The task depends on it. |
| `fabrik_clear_blocker` | `p_blocker`, `p_note`, `p_evidence`, `p_reason` | The blocker started if pending or paused, then completed with the note and a `supports` link to the evidence record `p_evidence`, and taken out of each task's `blockers`. |

`fabrik_add_blocker`, `fabrik_add_deliverable` and `fabrik_clear_blocker` make their saves together, all or none. Their preview lists the saves, with no requests. An actor whose every save needs an approval makes each save with the single-save functions instead. The evidence that a blocker is cleared is saved first, as an evidence record.

- **Responsible:** the actor, and the person accountable for them.
- **Person:** names the record and the change, and approves the preview before the save is made.
- **Agent:** calls the tool or function with `preview` or `p_preview` true, and shows the person the change as section 3 describes. When the person agrees, it calls the tool again without `preview`. For a function with no tool, it calls `fabrik_save_version` with the preview's `request` and `authorisation_id`, unchanged. A function that makes several saves, it calls once without `p_preview`, after the person agrees.
- **Evidence:** the preview, and the saved version.

**AI guided:** the agent shows the person each preview before the save, and waits for their approval.

## 12. Moving records to another scope

A person who is an administrator can move a set of records from one scope to another. A private scope's owner moves records into and out of it, as section 20 describes. Each record keeps its id, its versions, its links and its history. Its scope changes, and the move is logged.

- Every record in a move is in the same scope.
- Every link to or from a record in the move is from or to another record in the move. Each link between a record in the move and a record outside it is named in `outside_links`, and the move is refused. Add it to the move, or save a version without the link.
- `refused` names each record that is deleted, holds a glossary term or a record kind of the data dictionary, or is named by a live grant or an unused approval. The move is then refused. An administrator revokes such a grant first, with `fabrik_revoke_authorisation`.
- `losing_access` lists each person and agent who can read a record in the old scope and cannot read it in the new one. `gaining_access` lists the reverse. Each entry names the records.
- The move is refused if anything in the preview has changed. Preview it again.
- Files stay in their scope. A record that names a file in the old scope keeps that name.

- **Responsible:** the person who is an administrator, or, in a private scope, its owner.
- **Person:** names the records, the scope to move them to, and the reason.
- **Agent:**
  1. Asks for the reason, then calls `fabrik_preview_move` with `p_records`, a list of titles or record ids, `p_to_scope` and `p_reason`.
  2. Shows the person the records, the two scopes, `outside_links`, `refused`, `losing_access` and `gaining_access`, in plain words. When `outside_links` or `refused` is not empty, says what to add, link or revoke, and previews again.
  3. Waits for the person's agreement.
  4. Calls `fabrik_move_records` with the preview, unchanged, as `p_request`. The answer names each record moved, the two scopes, the time and the reason.
- **Evidence:** the preview, and the move's answer. The audit log, section 8, lists each record moved as `record_moved`.

**AI guided:** the agent shows the person the preview before the move, and waits for their approval.

## 13. Adding a scope

A person who is an administrator can add a scope. The database makes its private bucket for files, and the audit log shows it as `scope_created`, with who added it, when and why.

- The code is lower case letters, digits and underscores, starting with a letter, at most 63 characters. It never changes.
- A code or name used by another scope as its name or its code is refused, in any case.
- A name, a description of what the scope covers and a reason are required.
- A scope can be made private, for the owner the administrator names, as section 20 describes.

- **Responsible:** the person who is an administrator.
- **Person:** gives the code, the name, what the scope covers and the reason.
- **Agent:** shows the person the code, name and description, and calls `fabrik_add_scope` once they agree. The answer names the scope's id and code, its name and description, who added it, when and why. No one holds a grant in the new scope until one is given.
- **Evidence:** the new scope in `list_scopes`, and its `scope_created` entry in `fabrik_get_audit`.

## 14. Renaming a scope

A person who is an administrator can change a scope's name, its description, or both. A private scope's owner changes its own. The scope keeps its id, its code and its files, and its records and grants stay with it. Each change is logged.

- The scope is named by its id, its code or its current name, in any case.
- A new name used by another scope as its name or its code is refused, in any case.
- A reason is required. A call that changes nothing is refused.

- **Responsible:** the person who is an administrator, or, in a private scope, its owner.
- **Person:** names the scope, the new name or description, and the reason.
- **Agent:**
  1. Asks for the reason, then shows the person the scope's current name and description, from `list_scopes`, beside the new ones.
  2. Waits for the person's agreement.
  3. Calls `fabrik_rename_scope` with `p_scope`, `p_display_name`, `p_description` where it changes, and `p_reason`. The answer names the scope's id and code, its old and new name and description, the time and the reason.
- **Evidence:** the answer. The audit log, section 8, lists each field changed as `scope_renamed`, with `field`, `old_value` and `new_value`.

**AI guided:** the agent shows the person the old and new name and description before the change, and waits for their approval.

## 15. A grant limited to a person's own records

A person who is an administrator can limit a grant to the holder's own records. The holder reads, creates, edits, starts and cancels only the records that the holder, or an agent working for the holder, created. A record created by anyone else is absent from the holder's lists, progress, audit log and assigned tasks, and a change to it is refused.

- A limited grant carries `read`, and any of `create`, `edit`, `start`, `hold`, `complete`, `reopen`, `cancel` and `decide`.
- A limited grant carries no `delete`, covers no single record, and gives no access to the scope's files.
- A link from a record to a record the holder cannot read is refused.
- A person can hold a limited grant and a grant without the limit in the same scope. Each grant applies by its own actions and its own reach.
- `fabrik_get_authorisations` shows `own_records` on each grant.

- **Responsible:** the person who is an administrator.
- **Person:** names the person or agent, the scope, the record kinds, the actions and the reason.
- **Agent:**
  1. Asks for the person, the scope, the record kinds, the actions and the reason. Shows the person the grant in plain words, naming the limit.
  2. Waits for the person's agreement.
  3. Calls `fabrik_grant_permission` with `p_own_records` true, and a new UUID as `p_issuance_request_id`. The answer shows `own_records` true.
- **Evidence:** the answer. The audit log, section 8, lists the grant as `grant_issued`, with `own_records`.

**AI guided:** the agent shows the person the grant before it is given, and waits for their approval.

## 16. Deleting an empty scope

A person who is an administrator can delete a scope that holds no record and no file. A private scope's owner deletes their own. The call deletes the scope's grants and its place for files with it. The log of its files, moves and renames stays.

- The scope is named by its id, its code or its name, in any case.
- A scope that holds a record is refused, including a scope whose records were all deleted. Move its records to another scope first, as section 12 describes.
- A scope that holds a file is refused. Delete its files first, as the Files section describes.
- The scopes `general`, `routines`, `reference`, `plugins`, `administration` and `guides` are refused.
- A reason is required.

- **Responsible:** the person who is an administrator, or, in a private scope, its owner.
- **Person:** names the scope and the reason.
- **Agent:**
  1. Asks for the reason, then shows the person the scope's name and description, and its grants from `fabrik_get_authorisations`.
  2. Waits for the person's agreement to delete the scope and those grants.
  3. Calls `fabrik_delete_scope` with `p_scope` and `p_reason`. The answer names the scope's id, code and name, the number of grants removed, the time and the reason.
- **Evidence:** the answer. The audit log, section 8, lists the deletion as `scope_deleted`, with the scope's id as `deleted_scope_id`, its `code`, and the `grants_removed`.

**AI guided:** the agent shows the person the scope and its grants before the deletion, and waits for their approval.

## 17. Earlier sessions

The fabrik plugin's hooks copy each session in the agent folder into its `sessions/` folder, as Markdown with what the person and the agent wrote. They upload each copy into the person's sessions scope. Its code is `sessions_` and their Auth user ID with its hyphens removed, such as `sessions_3f2a9c0e4b1d4e7a9f6c2b8d1e5a7c3f`. Its name is the person's name and "'s sessions". The person alone holds a grant there, with `read`, `create`, `edit` and `delete`.

An administrator reads every person's sessions, unless the business has had that person's sessions made private. A private sessions scope belongs to its person, as section 20 describes, and an administrator sees only its name and its owner. A person whose sessions are private makes them ordinary again, so administrators read them, with `fabrik_make_sessions_ordinary`. It needs fabrik's upgrade 0008.

- **Responsible:** the actor.
- **Person:** asks what was said or agreed in an earlier session. `list_scopes` gives their sessions scope's code. The code starts `sessions_`, and the scope's name is their own. `search` with `scope` set to that code searches the sessions, and each hit's section gives the text. They open the session's copy in `sessions/` in the agent folder to read it whole.
- **Agent:**
  1. Acts when the person refers to an earlier session, or asks what was said before. Finds the person's sessions scope. Calls `fabrik_get_actor` for their actor id, then `fabrik_get_authorisations` with that id as `p_executor_id`, and `list_scopes`. It is the scope whose code starts `sessions_` where a grant of theirs gives `create`.
  2. Calls `search` with the question as `query`, and the scope's code as `scope`. A search across every scope leaves sessions scopes out. So the agent names the sessions scope's code as `scope`, only when the person asks about an earlier session. Reads each hit's section, as section 6 describes.
  3. Reads a session's copy in `sessions/` with the plugin's `read_file` for its whole text, or for a session too new to be found by search.
  4. Answers with each session's title and date, and quotes what was said. A decision or a change found there is checked against the records, as section 2 describes, before it is given as standing.
  5. When a person whose sessions are private asks to make them ordinary, says that every administrator then reads them, and waits for their agreement and their reason. Calls `fabrik_make_sessions_ordinary` with the reason.
- **Evidence:** each search and read, and its result, quoted.

**AI guided:** the agent gives the person what was said, with the session's title and date. It waits for them before the next question.

## 18. Connections in a file's parts

fabrik keeps the things each file names, such as customers, orders and suppliers, and how they relate. Each thing is of a class in the business's glossary, and each relation is one of the glossary's relationships. A search follows those links. The agent calls this connections when it speaks to a person, never the graph or the graph reader.

Each new part of a file is read once, by one of two readers:

- **fabrik, once the business turns connections on.** An administrator turns them on by typing the business's own Anthropic API key on the connections card, as the `fabrik:connections` skill describes. fabrik then reads each new part usually within an hour and at most a day, with Claude Haiku 5.5, by the rules in section 19. It saves what Claude finds under its own application actor. It reads the parts of every scope's files except private scopes, sessions scopes, the Administration and Guides scopes, and the plugin scopes. A month's reads stop at a cost cap, and a part waits for the next month once the cap is reached. A part whose answer fails 3 times is marked failed, with its reason. A finding that fits no class or relationship in the glossary is set aside, and the part's other findings are saved.
- **The person's agent**, in the person's own Claude subscription, once they approve. It reads everywhere while connections are off. While they're on, it reads in the scopes fabrik leaves out. It reads a part only in a scope where the person may read, and saves it only where they may also create.

`fabrik_get_graph_reader` says which: `on`, and `scopes`, the scopes fabrik reads that the person may read. `waiting_for_classes` true means connections are on but fabrik reads no part, because the glossary has no class. A person corrects a part's entities and relations in a scope where they may read and create. A person's save of a part stands: a later answer from Claude for that part is set aside.

**Tags.** A glossary term can name one thing of a class, such as the topic Masks of the class `topic`. Its `instance_of` names the class, and its `broader` names the term of the same class it comes under, such as a topic for a subtopic. The `fabrik:reference` skill says how to save them. An entity of a class that has such terms is one of them, and fabrik saves each term it comes under with it.

A file is tagged with such a term when one of its parts holds the term's entity. fabrik tags each new part with the terms it names or is about as it reads it, by section 19. A part about none gets none. A person tags a file read before with `tag_file`, and `tagged_files` lists a term's files. A search finds a tagged file through its term's name.

A save with `p_replace` true replaces a part's tags too, so the agent gives the part's tags again in that save. To add a tag, or any entity or relation, to a part already read, the agent uses `fabrik_add_extraction` instead, which keeps what the part holds.

The agent names a part not yet read as "waiting to be read for connections". It names a part still waiting for its text or its vector as one fabrik is still preparing. It names a failed part as one fabrik could not read, with its reason.

- **Responsible:** fabrik, for each new part of a scope it reads while connections are on. The actor whose agent reads a part, or who corrects one.
- **Person:** uploads a file, or asks for a scope's waiting parts to be read. The agent reads each part by section 19, and saves it with `fabrik_save_extraction`, with `p_replace` true to correct a part.
- **Agent:**
  1. Calls `fabrik_get_graph_reader` once in a session, before its first step below.
  2. After each `upload_file` the person agreed to, in a scope fabrik reads, tells the person fabrik reads the file's parts for connections, usually within an hour and at most a day. Elsewhere, calls `fabrik_get_unextracted` with the file's scope as `p_scope`. While its `awaiting_text` is above 0, tells the person fabrik is still preparing the file, and calls it again at the person's next message. Once `awaiting_text` is 0, names the parts from `waiting` and offers to read them, such as "Your 3 files have 24 parts waiting to be read for connections. Shall I read them now?" Reads them only once the person approves.
  3. A file search's `stages.awaiting_extraction` above 0 shows parts waiting. When `stages.waiting_for_classes` is true, fabrik reads none of them: follows the `fabrik:connections` skill's "Connections on, with no class" instead. Otherwise, for a scope fabrik reads, says so in one line, once in a session, such as "17 parts in the General scope are waiting to be read for connections. fabrik reads them, usually within an hour." Elsewhere, says so in one line, with one offer. After a search in one scope, it names the scope, such as "The General scope has 17 parts waiting to be read for connections. Shall I read them now?" After a search across every scope, it gives the total and asks which scope to read. Offers once per scope in a session. `stages.failed_extraction` above 0 shows failed parts: names them from `failed_extraction_parts`, with each reason, and offers to read them. While connections are off, the `fabrik:connections` skill says when to offer to turn them on instead.
  4. Reads up to 20 parts once the person approves. Above 20, its own upload's included, the offer gives the count first, and asks before reading any. In a scope fabrik reads, reads each part in `failed_chunks`. Elsewhere, reads each part in `chunks` and `failed_chunks`.
  5. Takes the glossary's classes and relationships from the answer's `classes` and `relationships`, as section 19 describes. When `classes` is empty, tells the person the glossary has no classes yet, so nothing can be saved, and offers to propose classes through the `fabrik:reference` skill.
  6. For each part it reads, follows section 19, and saves the part with `fabrik_save_extraction`. Calls `fabrik_get_unextracted` again for the next page while parts wait and the person agreed to that many.
  7. Reports how many parts it saved, and the entities and relations each save gave.
  8. For each file it read that holds a plan, a table or a list, offers the file's database form, as section 6 says.
  9. Asked to correct a part's entities and relations, calls `read_file` with the file's `scope` and `path`, which gives each part with its `chunk_id`, reads the part's `text` by section 19, and saves it with `p_replace` true. A person with read and create in the scope replaces fabrik's own save. The actor who saved a part, or an administrator, replaces any other save.
  10. Asked to add an entity or a relation to a part already read, calls `fabrik_add_extraction`. It gives the part's `chunk_id` and the new entities and relations, in the shape section 19 gives. A relation may name an entity the part already holds. It needs read and create in the scope, and keeps the part's other entities and relations.
  11. Asked to tag files, such as with topics, calls `tag_file` with each file's `scope`, `path` and `terms`, as the glossary names them. fabrik adds the terms each comes under, and a tag the file has already adds nothing. A file whose first part is not read yet is refused: the agent tags it once the part is read. Given a list of files and their terms, it tags each file in turn. It reports how many it tagged, and each refusal with its reason.
  12. Asked which files are about a term, such as a topic, calls `tagged_files` with the term. With no term, it gives each such term and how many files it tags.
- **Evidence:** each call's result, quoted.

**AI guided:** the agent shows the person each part's entities and relations before it saves them, and waits for their approval.

## 19. Reading a part for its connections

fabrik gives Claude these rules to read each part of a file while connections are on. A person, or their agent, follows them to read or correct a part. They write down the things the part names, and how they relate. Section 18 says when a part is read.

These rules are adapted from EdgeQuake's entity extraction instructions, `edgequake/crates/edgequake-pipeline/src/prompts/entity_extraction.rs` and `prompts/parser/tuple_parser.rs`, Copyright 2024-2026 Raphaël MANSUY, under the Apache License 2.0. EdgeQuake ported them from LightRAG, Copyright (c) 2025 LightRAG Team, under the MIT License. The fabrik plugin's `NOTICE` file and `LICENSES` folder hold both notices and licences. The changes are these: the types and relation names come from the business's glossary, the output is the JSON that `fabrik_save_extraction` takes, and the limits are fabrik's.

- **Responsible:** fabrik, while connections are on, or the actor whose agent reads or corrects the part.
- **Person:** reads the part's text in the file `fabrik_get_unextracted` or `fabrik_get_file_parts` wrote, and writes its entities and relations by the rules below, as `entities.json` and `relations.json`.
- **Agent:** takes the classes and relationships from `fabrik_get_unextracted`, then reads each part by the rules below, and saves it as section 18 describes.
- **Evidence:** each save's result, quoted.

**AI guided:** the agent shows the person each part's entities and relations before it saves them, and waits for their approval.

**Types and relationships:**

- `fabrik_get_unextracted` lists the glossary's classes as `classes`, and its relationships as `relationships`, each `{"relationship", "from_class", "to_class"}`.
- An entity's type is exactly one of those classes, written as the glossary writes it, such as `customer`, `order` or `supplier`.
- A relation's name is exactly one of those relationships, such as `places`, from a `customer` to an `order`. It goes from an entity of its `from_class` to an entity of its `to_class`.
- There is no other type and no other relation name. A thing that fits no class is left out, and so is a relation that fits no relationship.
- When a part names something that matters and fits no class, or a relation that fits no relationship, a person's agent may propose a new class or relationship to the person, through the `fabrik:reference` skill. It is saved only when the person approves. The agent then reads the part again, with the new class or relationship. Until the person decides, the agent leaves that part unsaved.

**Terms of a class:**

- `fabrik_get_unextracted` lists the glossary's terms that each name one thing of a class as `instances`, each `{"term", "class", "broader", "definition"}`, such as the topic Masks. `broader` names the term of the same class it comes under, or is null.
- A class with listed terms takes no other entity. An entity of that class is one of its terms, named exactly as the list names it.
- Give a listed term when the part names it, or when the part is mainly about it. Leave out a term the part only touches in passing.
- A part that names none of a class's terms, and is about none of them, gives no entity of that class.
- fabrik adds the terms a given term comes under itself, so the answer needn't give them.

**Each part.** Read the part's `text` alone. Use nothing from other parts, other files or the agent's own knowledge.

**Entities:**

- Find each clearly named and meaningful thing in the text that is of one of the classes.
- Give each one:
   - `name`: its readable name as the text gives it, of 1 to 200 characters. Write a name in title case where the text's case carries no meaning. A code such as a postcode, a UPRN or a property reference keeps its exact form. Use the same name for the same thing every time.
   - `type`: one of the classes, of 1 to 100 characters.
   - `description`: what this part says of it, in one to three sentences, in the third person, of 1 to 2,000 characters. Use only what the text says. A thing the text names and says nothing more of takes one sentence on where it appears, such as "Oak Cottage is listed in the valuation sheet's table.".
- Use no internal identifier as a name: no UUID, no hash and no record id. Put such an identifier in the description when the text gives one.
- Give each thing once in a part. Two things in one part take two different names.

**Relations:**

- Find each direct, clearly stated relation between two of the entities in this part that is one of the relationships.
- Split a statement about three or more things into relations between pairs. "J. Smith and K. Smith own Oak Cottage" gives two relations: J. Smith to Oak Cottage, and K. Smith to Oak Cottage.
- Give each relation:
   - `source` and `target`: the names of two entities in this part, written exactly as in their entities. The source is of the relationship's `from_class`, and the target of its `to_class`.
   - `relationship`: one of the relationships listed, written as the glossary writes it.
   - `keywords`: optional, one to five short words or phrases for the relation, such as `freehold` or `sole agency`. fabrik keeps the relationship's name among them.
   - `description`: what the text says of the relation, in one or two sentences, in the third person, of 1 to 2,000 characters.
- A relation goes one way, from its source to its target. Give each pair once for each relationship.
- Give a relation only between two entities given in this part.

**Order and limits:**

- Give the entities first, then the relations. Put the things that take part in relations first, and the most important relations first.
- Give at most 100 entities and 200 relations for one part. Give fewer when the part names fewer.
- Write names, keywords and descriptions in English. Keep a proper name in its own language.

**Before the answer:**

- Two names that differ only in capitals or spacing are one name.
- Check each relation's `source` and `target` against the entity names. Each is the name of an entity in this part, written exactly as in its entity.
- Check that each relation's `source` and `target` are two different entities.
- Check that each name has one type.
- Check that each relation's source is of its relationship's `from_class`, and its target of its `to_class`.
- Correct each entity or relation that fails a check, or remove it.

**The save:**

Save the part with `fabrik_save_extraction`. In this example, the glossary has the classes `customer`, `order` and `supplier`, and the relationships `places`, from a customer to an order, and `supplies`, from a supplier to a customer:

```json
{"function": "fabrik_save_extraction", "schema": "fabrik", "args": {
  "p_chunk": "<the part's chunk_id>",
  "p_entities": [
    {"name": "J. Smith", "type": "customer", "description": "J. Smith ordered 40 oak panels."},
    {"name": "Order 1042", "type": "order", "description": "Order 1042 is for 40 oak panels for J. Smith."},
    {"name": "Harbour Timber", "type": "supplier", "description": "Harbour Timber supplies the oak panels for Order 1042."}
  ],
  "p_relations": [
    {"source": "J. Smith", "target": "Order 1042", "relationship": "places", "keywords": ["phone order"], "description": "J. Smith placed Order 1042 by phone."},
    {"source": "Harbour Timber", "target": "J. Smith", "relationship": "supplies", "keywords": ["trade account"], "description": "Harbour Timber supplies J. Smith on a trade account."}
  ]
}}
```

A part with nothing to save is saved with two empty lists, and counts as read.

fabrik refuses an entity whose type is not a class, and one of a class with listed terms that is none of them. It refuses a relation whose `relationship` is not in the glossary, and one whose ends' classes are not the relationship's `from_class` and `to_class`. It merges an entity with one already saved of the same name and type, in any case and spacing. It keeps each part's description beside the others.

## 20. Private scopes

A scope can be private. It belongs to its **owner**, the person an administrator made it for. Only a person who is an administrator adds a scope, private or not. Only the owner, and the people and agents the owner grants, read or change anything in it. A scope is private from when it is made, and stays private.

An administrator sees each private scope's name and its owner. Its records, files, search hits and audit events reach its owner and the people they grant.

- The owner holds a full grant in it from when it is made.
- The owner gives and ends every grant in it. The owner approves each change and each deletion in it that needs an approval, in place of an administrator.
- The owner renames it, and deletes it when it is empty. The owner moves records between it and another private scope they own. A move between it and a scope that is not private needs an owner who is also an administrator.
- The owner hands it to another person, who holds read in the whole scope first. Each grant the old owner gave there then ends, their own among them. The new owner holds a full grant, and gives the others again.
- A private scope whose owner leaves without handing it on stays closed for good.
- A Supabase organisation owner, or anyone with the database password, can still read the database itself.
- The codes `general`, `routines`, `reference` and `plugins`, and any code starting `plugins_` or `sessions_`, are kept for fabrik's own scopes, and none is private.

- **Responsible:** the person who is an administrator, for making it; the owner, for everything after.
- **Person:** asks an administrator for a private scope, naming it, a short code for it and what it holds.
- **Agent:**
  1. Working for a person who is not an administrator, says that an administrator adds the scope, and what to ask them for. Working for an administrator, asks for the owner, the name, a code, the description and the reason. Shows the person the scope, its owner, and that it is private, and waits for their agreement. Calls `fabrik_add_scope` with `p_private` true and `p_owner` naming the owner. The answer names the scope, its owner, and the owner's grant as `owner_grant_id`.
  2. To grant someone in it, finds the person, or an agent of the owner's own, with `fabrik_find_actors`, by words of their name. When more than one fits, asks which one. Shows the person the grant in plain words, and waits for their agreement. Calls `fabrik_grant_permission` with a new UUID as `p_issuance_request_id`. Ends a grant with `fabrik_revoke_authorisation`, after the person agrees. `fabrik_get_authorisations` with no person named lists the owner's own grants and every grant in their private scopes. With a person named, it lists that person's grants there.
  3. To approve a change or a deletion in it, works as section 5 or section 7 describes, with the owner in place of the administrator.
  4. To hand it on, shows the person who will own it, and that each grant they gave there ends, their own among them. Waits for their agreement, and calls `fabrik_hand_on_scope` with the reason. The answer names the old and new owner.
- **Evidence:** each answer. The audit log, section 8, lists a handing on as `scope_handed_on`.

`list_scopes` gives each scope's `is_private`, `owner_actor_id` and `owner_name`, in section 1's call too. An administrator sees each private scope with its name and owner, and a null `description`.

**AI guided:** the agent shows the person each change before it is made, and waits for their approval.

## 21. Access templates

An **access template** is a named set of grants, which fabrik holds. Each of its grants names a scope by its code, its record kinds, its actions and whether it is limited to the person's own records. fabrik starts with three. `administrator` is the client's administrator, with administrator authority and no grant. `basic` is a member of staff. `kinetik` is Kinetik's staff, and the one template that changes the `plugins` scope's files.

- Every signed-in actor reads the templates.
- Only a person who is an administrator gives a person a template, or changes one. Each change gives a reason, and the audit log, section 8, lists it as `access_template_changed`.
- A template names shared scopes only, never a private or sessions scope.
- In the SQL Editor, `bootstrap.sql` step 3f gives a person a template in one statement.

- **Responsible:** the person who is an administrator.
- **Person:** reads the templates, asks for a person to be given one, and asks for one to be changed or added.
- **Business analyst agent:**
  1. Calls `fabrik_get_access_templates`, and shows each template's grants in plain words. It names each scope, what the person may do there, and any limit to their own records.
  2. To give a person a template, shows the person and the template's grants, and waits for their agreement. Calls `fabrik_apply_access_template` with the person's actor id as `p_person` and the template's code as `p_template`. The answer lists each grant it `issued`, and `already_held` counts those the person held. A second call issues nothing more.
  3. To change a template, shows the old and new grants side by side, and waits for the person's agreement. Calls `fabrik_save_access_template` with the reason. The answer gives the `old` and `new` template.
- **Evidence:** each answer, and the `access_template_changed` entry in `fabrik_get_audit`.

**AI guided:** the agent shows the person each change before it is made, and waits for their approval.

## The routine in force

A routine is how a piece of the person's work runs, kept as model records in the scope the person chose for it. The `interview` skill saves the routine they confirm as `<routine>: current state`. The `design` skill saves a better one as `<routine>: proposed state`, and the person's choice as the decision `<routine>: design choice`.

A routine's **version in force** is the design the person selected. The routine's one `<routine>: design choice` decision selects it. Its `decision` text names a `proposed_target` model it links to with `supports`. That link's version is the one in force. A rejected or open choice names no linked design, so it selects nothing.

With no design selected, the version in force is the `<routine>: current state` the person confirmed. That is an `observed_current` model whose `source_status` starts `stated, confirmed by`, and whose `routine` node has `basis` `performed`. A routine the person does not do yet has no version in force until they select a design.

`list_records` matches each word of `title` anywhere in a record's title, so it also finds other routines whose names hold the same words. The agent keeps only the record whose title is exactly `<routine>: design choice` or `<routine>: current state`, ignoring case.

Before work a routine covers, the agent finds that routine and reads its version in force. It names the version it follows, and follows its steps. A step the routine assigns to the person stays theirs. When the person asks to work differently, the agent does as asked. It offers to record the change as a new version of the routine.

- **Responsible:** the agent, for the person who asked.
- **Person:** names the work or the routine. `list_records` finds the routine's records, and `get_record` reads them.
- **Agent:**
  1. Finds the routine. It calls `list_records` with `kind` `model` and `title` set to the words of the work, such as `invoicing`. Where no title fits, it calls `search` with the person's words, and keeps the model hits. When more than one routine fits, it asks which one.
  2. Finds the selection. It calls `list_records` with `kind` `decision` and `title` `<routine> design choice`, keeps the record titled exactly `<routine>: design choice`, and reads it with `get_record`. When two records have that title, it asks the person which one holds the choice.
  3. When the decision's `decision` text equals the `target_title` of one of its `supports` links whose `target_kind` is `model`, that link's `target_version_id` is the version in force. It reads the design with `get_record`. When the design's `version_id` is newer than the one selected, it tells the person and follows the selected version. It reads that version with `fabrik_get_history`, as section 2 says.
  4. With no selection, calls `list_records` with `kind` `model` and `title` `<routine> current state`, keeps the record titled exactly `<routine>: current state`, and reads it with `get_record`. It is in force when its `payload` has `model_kind` `observed_current`, a confirmed `source_status`, and a `routine` node whose `basis` is `performed`.
  5. With neither, says the routine has no version in force. When the routine is not written down, it offers the `interview` skill. When the routine's basis is `intended`, it offers the `design` skill.
  6. Names in one line the routine, the version it follows, and whether it is a selected design or the confirmed current state.
- **Evidence:** the version in force's `record_id` and `version_id`, and the decision that selected it where there is one.

**AI guided:** the agent names the version it found, and waits for the person's approval before the first step.

## Files

Each scope's files are in its own private bucket, named after the scope's code. The connector's `upload_file` uploads a file, given in the call itself, and its `read_file` reads a file's text. The fabrik plugin's `upload_file`, `list_files` and `download_file` upload a file from the agent folder, list a folder and download a file. The `fabrik:actor` skill's "Search results" and "File deletion" sections cover searching them and deleting one for good. Sections 18 and 19 cover the connections in their parts.

## Problems with records

fabrik's refusals are its rules at work, and the agent reports each one as it came, with its message:

- **`Invalid text field: <field>`:** the field is not text, or is over its limit. A `title` holds 500 characters, and a model node's `label` 500. An activity's `index` holds 20. An `owner_label`, and an external reference's `label`, hold 200. A `source_reference`, a link's `locator`, and an external reference's `reference` hold 2,000. A node's or edge's `id` and `type` hold 100. Every other text field holds 4,000. The agent shortens the field, or moves detail into a model's node attributes, and shows the person the change before saving again.
- **`source_reference: <rule>` or `external_references.reference: <rule>`:** the value breaks the rule named, from section 3. The agent removes the `?` part, the leading slash or the `..`. For another scheme, it asks the person for the `https://` link. It shows the person the change before saving again.
- **`Administrator required`:** the call is for administrators only, such as `fabrik_get_sign_ins`. The agent says that an administrator's own agent can answer it.
- **`Scope or record unavailable`, or a null record:** the actor has no read grant there, or the record does not exist.
- **`Supply the id of a grant or approval that covers this change`:** the save left out the authority's id. An actor that needs a person's approval for every save passes the approval's id, as section 5 describes. Any other actor passes its grant's, as section 3 describes.
- **`Authority unavailable` or `Action outside authority scope`:** the grant given does not cover this change: its scope, record kinds or actions, or it has expired or been revoked. A deletion also needs a grant that includes delete for the record's kind, unless the actor is an administrator.
- **`Exact human-issued approval required`:** every save by this actor needs an approval issued by a person, as section 5 describes. An administrator asks a person to approve it.
- **`Approval already used or does not match exact request`:** an approval covers one save of one exact request. The agent asks the administrator for a new approval of the request as it now stands.
- **`Completion requires requirements, note, no blockers and supporting evidence`:** the activity needs its completion requirements, a completion note, no open blockers, and a `supports` link to an evidence version. The agent says which of these is missing.
- **`Record deletion needs an approval` or `Record deletion needs a human administrator's approval`:** every deletion needs an approval of its exact request from an administrator who is a person, as section 7 describes.
- **`The records that link to this record have changed; preview the deletion again`:** another record has linked to it, or stopped, since the preview. The agent previews again and asks for a new approval.
- **`Deletion retry unavailable or different`:** the request's id was already used, by another actor or for another record. The agent previews again, which gives a new request.
- **`A deletion request has operation delete`:** the request is not the one the preview gave. The agent uses the preview's `request` with only its reason filled in.
- **`The record was deleted`:** the record has already been deleted; it can be read as deleted, but not saved to or deleted again.
- **`Link target unavailable`:** a link points at a version the actor cannot read, or at a record that has been deleted. The agent removes that link, or links to a version it can read.
- **`Assignee is not a person who can read this scope`:** the assignee is an agent or an application, is not enabled, or holds no grant to read activities in the task's scope. The agent finds the person again with `fabrik_find_people`, or tells the person that an administrator can give them read in the scope.
- **`Only a task has an assignee`:** a plan was given an assignee. A plan has an owner, as section 9 describes.
- **`Owner is not a person who can read this scope`:** the activity has no `owner_actor_id`. Or its owner is an agent or an application, is disabled, or holds no grant to read activities in its scope. The agent finds the person with `fabrik_find_people`, and sets them with `fabrik_set_owner`. Or it tells the person that an administrator can add them to fabrik, or give them read in the scope.
- **`invalid input syntax for type uuid`:** an `assignee_actor_id` or `owner_actor_id` is not an actor's id. The agent takes the id from `fabrik_find_people`.
- **`An activity index is one line`, `Only a task has a task type` or `Task types are work, deliverable and blocker`:** the index holds a line break, a plan was given a task type, or the task type is another word. The agent corrects it as the person agrees.
- **`More than one record has the title "<title>"`:** a task function's record fits more than one record. The person names it by one of the record ids listed. A record marked `deleted` there was deleted with `delete_record`; `restore_record` brings it back.
- **`<file> already exists. Name a new file; nothing is replaced.`:** the call named a `result_file` already in the agent folder, and was refused before anything was sent. The file holds an earlier answer. The agent names a new file, such as one carrying the date and time, and calls again.
- **`Record unavailable: no record you can read has the title "<title>"`:** no record the actor may read has that exact title. The agent finds it with `list_records` and words of the title, and names it by its record id.
- **`Scope unavailable: no scope has the id, code or name "<scope>"`:** the scope is named another way. `list_scopes` lists each scope's id, code and name.
- **`No grant of yours covers <actions> on <kind> records in <scope>. An administrator can grant it, or approve this exact change`:** the actor holds no grant for the change, as section 3's **Authority** describes. An administrator can grant it, or approve the preview's request.
- **`Every save by this actor needs a person's approval. Save the preview's request with an approval, as the fabrik:records skill's section 5 describes`:** the actor saves only with an approval. An administrator approves the preview's request, as section 5 describes.
- **`No person who can read <scope> has a name with "<words>". An administrator can give them read in the scope` or `More than one person fits "<words>": <names>`:** `fabrik_assign` or `fabrik_set_owner` found no person, or more than one. The person gives more of the name, or an administrator gives that person read in the scope.
- **`The record has no <relation> link to that record`:** `unlink_records` found no such link to remove.
- **`Name a task`, `Name a blocker` or `The task has deliverables a to z`:** a blocker or deliverable function was given another kind of record, or the task has no letter left.
- **`Give the blocker's requirements: what clears it`, `Give the completion note: how the blocker was cleared` or `Name the evidence that the blocker is cleared`:** `fabrik_add_blocker` or `fabrik_clear_blocker` was given no requirements, no note, or a record that is not evidence.
- **`The fields are a JSON object`:** `p_fields` is not an object of field names and values.
- **`This record was changed by another save. Read it again, then save again.`:** another save of the same record was kept since the agent read it. The agent reads the record again, shows the person what changed, and saves again once they agree.
- **`canceling statement due to statement timeout`:** the call ran past fabrik's time limit, and nothing was saved. The agent reports it to the person as it came, and tries once more only when the person asks.
- **`A period needs a start before its end` or `Invalid audit cursor`:** the audit log's period is reversed, or the cursor is not one it gave. The agent sets the period again, and passes back only the `next_cursor` it was given.
- **`Missing or unknown JSON fields`:** the request or payload lacks a key, or has an extra one. The agent compares it with section 3's keys and the kind's fields, and shows the person the change before saving again.
- **`The entity "<name>" has the type "<type>", which is not a class in the glossary. An entity's type is one of the classes fabrik_get_unextracted lists`:** an entity's type is not a glossary class. The agent uses one of the classes listed, or leaves the thing out, as section 19 describes.
- **`The relation from "<source>" to "<target>" names "<name>", which is not a relationship in the glossary. A relation names one of the relationships fabrik_get_unextracted lists`:** a relation's `relationship` is not a glossary relationship. The agent uses one of the relationships listed, or leaves the relation out.
- **`The relationship "<name>" goes from a <class> to a <class>, and "<source>" is a <class> and "<target>" a <class>`:** the relation's ends are the wrong way round, or of other classes. The agent swaps the source and target, or leaves the relation out.
- **`Chunk unavailable: no chunk with the id "<id>" in a scope you may read` or `Saving a chunk's entities and relations needs create permission in its scope`:** the actor may not read the part's scope, or may read it and not create there. An administrator can grant it.
- **`Only the actor who saved this chunk's entities and relations, or an administrator, may replace them: <name>`:** another actor saved the part. The agent tells the person who, and that they or an administrator can correct it.
- **`File search's graph is not set up yet: ask the administrator to run file-search.sql`:** the project's file search is not set up. The agent tells the person to ask their administrator.

## Problems with moves, scopes and grants

The agent reports each of these as it came, with its message:

- **`Only a person who is an administrator moves records`:** the actor is an agent, or a person who is not an administrator. The agent says that an administrator's own agent can move them.
- **`Every record in a move is in the same scope. These are in <scopes>`, or `The records are already in <scope>`:** the records named are in more than one scope, or in the scope named. The agent names one scope's records, or another scope.
- **`Give the reason for the move, as p_reason when previewing it`:** the preview was made without a reason. The agent asks for it and previews again.
- **`A record outside the move links to or from one in it. Add it to the move, or save a version without the link`, or `The preview refuses the move: <records and reasons>`:** the preview's `outside_links` or `refused` was not empty. The agent shows the person each one, as section 12 describes, and previews again once they are dealt with.
- **`The move has changed; preview it again`:** a record, a link or someone's access changed since the preview. The agent previews again, shows the person what is different, and moves only when they agree again.
- **`Only a person who is an administrator renames a scope`:** the actor is an agent, or a person who is not an administrator. The agent says that an administrator's own agent can rename it.
- **`Give the reason for the change, as p_reason`, or `Give the new name, as p_display_name, or the new description, as p_description`:** the call lacks a reason, or changes neither the name nor the description. The agent asks for what is missing and calls again.
- **`The scope <name> already has that name and description`:** the new name and description are the scope's own. The agent tells the person, and changes nothing.
- **`Only a person who is an administrator deletes a scope`:** the actor is an agent, or a person who is not an administrator. The agent says that an administrator's own agent can delete it.
- **`Give the reason for the deletion, as p_reason`:** the call lacks a reason. The agent asks for it and calls again.
- **`The scope <name> holds <n> records, <k> of them deleted; a scope is deleted only when it holds none`:** the scope holds records. The agent offers to move the live ones, as section 12 describes. A record that was deleted stays in the scope.
- **`The scope holds <n> files; delete them first`:** the scope's files are not all deleted. The agent lists the files, and deletes them only when the person agrees.
- **`The scope <name> is part of fabrik's setup and is not deleted`:** the scope is `general`, `routines`, `reference`, `plugins`, `administration` or `guides`. The agent says so.
- **`Another scope has the name or code "<name>": <scope> (code <code>)`:** another scope holds that name, or has it as its code, in any case. The agent shows the person that scope, and asks for another name.
- **`A scope's name is at most 200 characters`, or `A scope's description is at most 4000 characters`:** the new name or description is over its limit. The agent shortens it with the person, and calls again.
- **`A grant limited to own records covers no single record`:** the grant named a record with `p_record_id`. The agent leaves `p_record_id` null and calls again.
- **`A grant limited to own records does not carry delete`, or `A grant limited to own records carries read`:** the grant's actions hold `delete`, or lack `read`. The agent takes `delete` out, or puts `read` in, with the person, and calls again.
- **`Only a person who is an administrator adds a scope`:** the actor is an agent, or a person who is not an administrator. The agent says that an administrator's own agent can add it.
- **`The code <code> is kept for fabrik's own scopes`:** a private scope was asked for with one of fabrik's own codes. The agent asks for another code.
- **`No enabled person has a name with "<words>"`, or `More than one person fits "<words>": <names>`, from `fabrik_add_scope`:** the owner named was found nowhere, or more than once. The agent asks for more of the owner's name, and calls again.
- **`Only the scope's owner gives grants in a private scope`, `Only the scope's owner ends grants in a private scope`, `Only the scope's owner approves changes in a private scope`, `Only the scope's owner renames a private scope`, `Only the scope's owner deletes a private scope`, or `Only the scope's owner hands it on`:** the scope is private, and the actor is not its owner. The agent names the owner, from `list_scopes`, and says that the owner can do it.
- **`Record deletion in a private scope needs its owner's approval`:** the approval came from someone other than the scope's owner. The owner approves the deletion, as section 20 describes.
- **`Only the owner of a private scope moves records into or out of it, and only an administrator moves them elsewhere`:** the actor does not own a private scope of the two, or is not an administrator where one is not private. The agent says who can make the move.
- **`No other person who can read <scope> has a name with "<words>". Give them read in the scope first, with fabrik_grant_permission`:** the person to hand the scope to holds no read in the whole scope. The owner grants them read first, as section 20 describes.
- **`Only an administrator, or the owner of a private scope, finds people to grant`:** the actor owns no private scope and is not an administrator.
- **`Only a person who is an administrator applies an access template`, or `Only a person who is an administrator changes an access template`:** the actor is an agent, or a person who is not an administrator. The agent says that an administrator's own agent can do it.
- **`There is no access template <code>`:** the code names no template. The agent lists the templates with `fabrik_get_access_templates`, and asks which one.
- **`The <code> access template names scopes this fabrik lacks: <scopes>`:** a scope the template names is missing. An administrator adds it first, as section 13 describes.
- **`Only administrators work in the administration scope, and no template names it`:** a change named the Administration scope in a template. The agent leaves that grant out.
- **Any other message:** it names the field or rule that the request broke.

## Finish order

An activity's finish is its forecast finish, or its baseline finish where the forecast is null. Each activity finishes on or after each of its children. It also finishes on or after each deliverable it waits on through a `depends_on` link. So a task finishes on or after its deliverables, a sprint on or after its tasks, and a project on or after its sprints. A cancelled activity, and one with no finish, is left out. fabrik refuses a save that breaks this.

A change that moves a parent and its children later saves the parent first. A change that moves them earlier saves the children first. Each finish change carries its own reason.

## Problems with finish dates

- **`This finish cannot be saved: <activity> finishes <time>, before its <task, sprint, plan, blocker or deliverable> <index>, which finishes <time>.`:** the save leaves an activity finishing before a child, or before a deliverable it waits on, as "Finish order" describes. The message names each such pair. The agent shows the person each pair, and asks which finish moves. To move a parent and its children later, it saves the parent first. To move them earlier, it saves the children first. Each save carries its own reason.
