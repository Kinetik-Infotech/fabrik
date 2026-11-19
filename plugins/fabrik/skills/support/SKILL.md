---
name: support
description: Use when a person asks how to do something in fabrik, or says something is broken. It answers a how-to question from fabrik's guides first. For a problem, it writes down what the person did, what they got and when. It saves that as a task assigned to the person, and drafts a GitHub issue they file themselves. It runs in one of three modes: human only, AI guided or human directed.
---

# Support

Support answers the person's question from fabrik's guides. When something went wrong, it writes the problem down and keeps it as a task in the person's own records. It then drafts an issue for fabrik's GitHub repository. Only the person files the issue. No one else has access to their fabrik.

This skill sets the order, the wording and the checks. It uses the `fabrik:records` and `fabrik:writing` skills. Every save follows the `fabrik:records` skill's section 3. The agent shows the person what it will save, and saves only what they agree to. The agent asks each question as the card rules' "Asking a question" says.

## Choose the mode

The person chooses the mode.

- **Human only:** the person follows the Person lines below, without the agent. They read the guides, and file the issue themselves.
- **AI guided:** the person asks the agent to guide them. Before each step, the agent says what the step does and shows the Person line. It stops for the person's approval at the end of each stage.
- **Human directed:** the person tells the agent what to do. The agent follows its lines for each step the person directs.

Each step below gives a **Person** line and an **Agent** line.

With the agent, the person's own instruction replaces a rule of this skill, such as the wording of the issue. The agent names the rule once and does as told. A refusal from fabrik or a tool still stands. The agent gives it to the person with what they can do instead.

## 1. Answer from the guides

A how-to question is answered from fabrik's guides, before anything else.

- **Person:** reads the guide for their question in the `docs/guides` folder of fabrik's repository, or asks the agent.
- **Agent:** calls the connector's `guide` tool with `about` set to the person's question, in their words. It answers from the guide it gives, and names the guide. When `guide` gives `topics` alone, no guide answers the question: the agent says so, and gives the closest topics.
- A question the guides answer ends here. A problem goes on to section 2.

**AI guided:** the agent gives the person the answer and its guide, and waits for them.

## 2. Write down the problem

1. **Ask what the person did.** The steps they took, in order: what they typed, in which Claude app, and in which folder.
   - **Person:** writes it down in their own words.
   - **Agent:** asks one question per reply, and writes down each answer in the person's words. A problem in this session is already in front of the agent: it gives the person its own account, and asks them to correct it.
2. **Ask what the person got.** The message, the answer or the page, quoted as it came, and what they expected instead.
   - **Person:** copies each message as it came, never retyped.
   - **Agent:** quotes each message from the person, or from this session's tool results, unchanged.
   - Leave out any password, key, token or one-time code, and any other person's details. Write "[password left out]" or "[token left out]" in its place.
3. **Ask when and where.** The date and time, the computer and its system, and whether it happens every time.
   - **Person:** adds them.
   - **Agent:** asks for them, and adds them.

The description holds three parts, in this order: "What I did:", "What I got:" and "When:".

**AI guided:** the agent gives the person the description, and waits for their approval of its wording.

## 3. Save the task

The problem is one task in General, assigned to the person, so they can follow it with their other tasks.

- `title`: "Support:", the problem in a few words and today's date, such as "Support: my upload failed, 17 November 2026". The date keeps two problems described the same way apart.
- `activity_kind`: `task`.
- `description`: the three parts from section 2.
- `completion_requirements`: "The cause is known, the fix is in place, and I have checked it works."
- `assignee_actor_id`: the person's own `actor_id`, from `fabrik_get_actor`.

1. **Preview the task.**
   - **Person:** reads the task the agent shows, and presses Yes or No.
   - **Agent:** calls `save_record` with `scope` `General`, `kind` `activity`, the title, a `reason` of "A problem written down for support", those `fields` and `preview` true. It shows the person the scope, the title, the description and the person it is assigned to, by name.
2. **Save it once the person agrees.**
   - **Agent:** calls `save_record` again without `preview`.
   - **Evidence:** the saved version's `record_id` and `version_number`.

**AI guided:** the agent gives the person the saved task's title, and waits for their approval before section 4.

## 4. Draft the GitHub issue

fabrik's issues are at https://github.com/Kinetik-Infotech/fabrik/issues. The person files the issue from their own GitHub account, or discards it.

1. **Write the draft.**
   - **Agent:** writes the issue as a Markdown file in the session's folder, named `support-issue.md`. Its first line is the title: the task's title without "Support:" and the date. The body holds the three parts from section 2, the person's system, and fabrik's version where the person knows it. It holds no password, key, token, email address or project reference.
   - **Agent:** checks the draft once more for anything section 2 leaves out, and gives the person its path.
2. **The person files or discards it.**
   - **Person:** reads the draft. To file it, opens https://github.com/Kinetik-Infotech/fabrik/issues/new, pastes the title and the body, and chooses **Create**. To discard it, deletes the file.
   - **Agent:** never files the issue, and never opens it in a browser for the person. Once the person says they filed it, it offers to add the issue's link to the task's `description`, as a new version.

**AI guided:** the agent gives the person the draft's path, and waits for them before closing.

## 5. When the person changes something

- **More detail, later:** add it to the task's `description` in a new version, with `save_record` and `record` set to the task's `record_id`.
- **The problem went away:** add that to the task's `description`. Once the person agrees, mark the task completed, as the `fabrik:records` skill's section 4 describes.
- **A second problem:** save it as its own task.
