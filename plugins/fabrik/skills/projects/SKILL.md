---
name: projects
description: Use when a person has work with several steps, dependencies or deliverables, such as a client job, a product launch or a renovation, or says "let's sprint on", "run a project on", "investigate why", "review the deliverables for" or "let's do a retro on". Runs it as a fabrik project with tasks, through the connector's project and task tools, from planning to completion and a retrospective.
---

# Projects

A project in fabrik is a plan record of type Project. Its tasks are task records of type Task, each part of it. A task that must finish before another can start blocks it. The connector's tools do every save, as the signed-in person:

| Tool | What it does |
|---|---|
| `project_create` | Starts a project, with its description, due date and deliverables. |
| `project_list` | Lists the open projects, or those in one state, or all with `closed`. |
| `project_get` | Reads a project with its tasks. |
| `project_update` | Changes a project's title, description, due date, deliverables, state or properties. |
| `project_complete` | Marks a project done, and lists its tasks still open. |
| `task_create` | Adds a task, in a project or alone, with what blocks it and what it blocks. |
| `task_update` | Changes a task, or adds tasks that block it. |
| `task_list` | Lists the open tasks, of one project or all. |
| `task_get` | Reads a task with what blocks it and what it blocks. |
| `task_complete` | Marks a task done, and lists the tasks it held up that are now ready. |
| `task_ready` | Lists the tasks ready to start: open, and blocked by no open task. |

`remember` keeps a note, a finding or a decision, `link_records` links it to the project or a task, and `search` finds what was kept before.

## When to run a project

When the person describes work with several steps, dependencies or deliverables, the agent asks: "Shall we run this as a project, or just as a task?"

These always start a project, with no question: "let's sprint on", "run a project on", "investigate why", "review the deliverables for" and "let's do a retro on".

## Starting a project

1. The agent asks what the project must deliver, for whom, and by when.
2. It searches with `search` for notes from earlier, similar work, and says what they teach.
3. It calls `project_create` with the title, the description, the due date and the deliverables.
4. It adds each piece of work with `task_create`, naming the project. A task that waits on another names it in `blocked_by`. A task's priority is low, normal, high or urgent.

A task's due date falls on or before its project's. fabrik refuses one that falls later, naming both, so the agent moves the project's due date first with `project_update`.

## Choosing the size

| Size | When | Steps |
|---|---|---|
| Quick | Simple work with one deliverable and no dependencies, such as sending an invoice | Scope, do the work, done |
| Standard | Several steps with some dependencies and a deliverable for a client | Plan, do the work, check it, debrief |
| Full | Several weeks, many dependencies, real risk, several people involved | Plan, test the premise, fix the order, do the work, check it, check it against the plan, debrief, review the deliverables, keep the lessons |

When the size is unclear, the agent suggests one and the person changes it. When a quick project turns out harder, the agent offers the standard steps.

### Plan

The agent writes down the deliverables, who they are for, the due date and the dependencies, as the project and its tasks. When more than one party has a stake, it lists them by how much power and interest each has, and saves the list with `remember`, linked to the project.

### Test the premise

For a full project, the agent asks what would make it fail if it failed six months from now. It ranks each risk by how likely and how harmful it is. It adds a task for each risk worth acting on, and keeps the rest with `remember`, linked to the project.

### Do the work

The agent works through `task_ready`. When more than one task is ready and the order is not settled, it ranks them with one method for the whole project:

- RICE: reach times impact times confidence, divided by effort.
- ICE: impact times confidence times ease.
- MoSCoW: must have, should have, could have, won't have this time.
- Kano: what is expected, what is better the more there is, and what delights.

It moves a task to in progress with `task_update` when it starts it. A problem found on the way becomes a new task that blocks the one it holds up.

### Check it

For each deliverable, the agent asks whether it is done, whether it meets what was agreed, and what is still outstanding. It names anything promised and not delivered, or delivered differently.

### Debrief and retrospective

The agent asks what went well, what did not, and what to do differently. It keeps each lesson with `remember`, linked to the project, so `search` finds it when similar work starts.

## Investigating a problem

When something has gone wrong in day-to-day work, the agent starts a project for it. Its first task is to gather the facts, its next to find the cause, and its last to put the fix in place. It keeps each finding with `remember`, linked to the project.

## Turning a meeting into tasks

From a meeting's notes or transcript, the agent keeps each decision with `remember`, and adds each action as a task with `task_create`, in the project when there is one.

## Recording why

Each tool that saves takes a `reason`, kept with the version in the record's history. The agent puts in it why the change was made, such as a change of scope or an issue found, in the person's words.

## Completing

`task_complete` and `project_complete` need nothing but the task or the project: "mark it done" is enough. fabrik completes work only when it is in progress, has its deliverables and a completion note written, lists no blockers, and has evidence linked to it. So the tool does each missing step:

- It moves the work to in progress.
- It writes the deliverables when there are none, from those the person gives, else the description, else the title.
- It keeps the person's note, or "Marked complete by the person.", as the completion note.
- When no evidence is named, it saves the note as a Note record and links it as the evidence.

When the person names a document or a note that shows the work done, the agent passes it as `evidence`.

`task_complete` refuses a task that an open task still blocks, and names those tasks. The agent completes or cancels them first. Its answer lists the tasks now ready.

`project_complete` leaves the project's tasks as they are, and lists those still open. The agent asks the person whether to complete or cancel each one.

## Checking where things stand

`project_list` gives the open projects, and `project_get` one project with each task's state and due date. The agent tells the person how many tasks are done, which are overdue, and what is blocked, such as: "The kitchen refit has 3 of 5 tasks done. Ordering the worktop is blocked by the survey." `show_board` draws a project as a board.
