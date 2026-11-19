// The projects and tasks tools, ported from maxy-code's work and projects plugins onto fabrik's activity records:
// project_create, project_list, project_get, project_update, project_complete, task_create, task_update, task_list,
// task_get, task_complete and task_ready. A project is a fabrik plan of type Project and a task a fabrik task of type
// Task. A task made in a project has a parent link to it, as fabrik's boards and progress read it, and the project a has_task link to the
// task. A task that must finish before another starts has a blocks link to it. Anything maxy-code kept that fabrik's
// activity fields do not hold, such as a task's priority, is in payload.properties.
import { z } from "npm:zod@4.3.6";
import { answer, type Ctx, refused, type Result, type Tool, tool } from "./tool.ts";
import { data, GENERAL, isTrashed, linkable, newFields, reasonOf } from "./ported.ts";

const RECORD = "named by its record_id, or by its exact title in any case among the records the person may read: " +
  "the one not deleted that has the title, or a deleted one only when none not deleted has it; " +
  "a title more than one record could be meant by is refused, with each one's title, scope, last save and id, a deleted one marked.";
const SCOPE = "The scope to save in, by its scope_id, code or name, from list_scopes.";
const reasonFor = (name: string) => z.string().min(1).optional().describe(`Why this is saved, in the person's words. It is kept with the version. "Saved with ${name}" when left out.`);
const properties = z.record(z.string(), z.unknown());
const OPEN_STATES = ["pending", "in_progress", "paused"];
const STATES = ["pending", "in_progress", "paused", "completed", "cancelled"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const DUE = "When it is due: a date and time with its time zone, such as 2026-12-01T17:00:00Z. fabrik keeps it as the forecast finish.";
const FINISH_ORDER = "fabrik refuses a due date that falls before the due date of a task in the project, or a task's due date after its project's, " +
  "naming both, so a project's due date is moved first.";

/** An activity in a list: what a person reads of it. */
// deno-lint-ignore no-explicit-any
const item = (x: { record_id: string; title: string; scope_id?: string; payload: any }) => ({
  record_id: x.record_id, title: x.title, type: x.payload?.type ?? null, state: x.payload?.state ?? null,
  due: x.payload?.forecast_finish_at ?? null, priority: x.payload?.properties?.priority ?? null, ...(x.scope_id ? { scope_id: x.scope_id } : {}),
});

/** Every activity the person may read, as fabrik_get_progress gives them page by page, or the refusal. */
// deno-lint-ignore no-explicit-any
async function activities(ctx: Ctx): Promise<any[] | Result> {
  // deno-lint-ignore no-explicit-any
  const all: any[] = [];
  let cutoff: number | null = null, observed: string | null = null, cursor: string | null = null;
  do {
    const page = await data(ctx, "fabrik_get_progress", { p_cutoff: cutoff, p_observed_at: observed, p_cursor: cursor, p_limit: 100, p_scope_id: null });
    if (!page.ok) return page.result;
    all.push(...(page.data?.items ?? []));
    cutoff = page.data?.cutoff ?? null; observed = page.data?.observed_at ?? null; cursor = page.data?.next_cursor ?? null;
  } while (cursor);
  return all;
}

/** The record named, read at its latest version, if it is an activity of the kind given and not deleted; else why not. */
// deno-lint-ignore no-explicit-any
async function activity(ctx: Ctx, record: string, kind: "plan" | "task"): Promise<{ ok: true; data: any } | { ok: false; result: Result }> {
  const shown = await data(ctx, "fabrik_show_record", { p_record: record });
  if (!shown.ok) return shown;
  if (shown.data.kind !== "activity" || shown.data.payload?.activity_kind !== kind) {
    const is = shown.data.kind === "activity" ? (shown.data.payload?.activity_kind === "plan" ? "a project" : "a task")
      : `${shown.data.kind === "evidence" ? "an" : "a"} ${shown.data.kind} record`;
    return { ok: false, result: refused(`"${shown.data.title}" is not ${kind === "plan" ? "a project" : "a task"}: it is ${is}.`) };
  }
  if (isTrashed(shown.data.payload)) return { ok: false, result: refused(`"${shown.data.title}" is deleted. restore_record brings it back.`) };
  return shown;
}

/** A project's tasks: those it links by has_task, and those with a parent link to it, each once. */
// deno-lint-ignore no-explicit-any
async function tasksOf(ctx: Ctx, project: string): Promise<{ ok: true; data: any[] } | { ok: false; result: Result }> {
  const linked = await data(ctx, "fabrik_linked", { p_record: project, p_relations: ["has_task", "parent"], p_direction: "both" });
  if (!linked.ok) return linked;
  const seen = new Set<string>();
  // deno-lint-ignore no-explicit-any
  const tasks = (linked.data as any[]).filter((x) => x.kind === "activity" && x.payload?.activity_kind === "task"
    && ((x.relation === "has_task" && x.direction === "out") || (x.relation === "parent" && x.direction === "in"))
    && !seen.has(x.record_id) && seen.add(x.record_id));
  return { ok: true, data: tasks.sort((a, b) => a.title.localeCompare(b.title)) };
}

/** A task as task_get gives it: the record, its projects, the tasks that block it and those it blocks. */
async function taskView(ctx: Ctx, task: string): Promise<Result> {
  const shown = await activity(ctx, task, "task");
  if (!shown.ok) return shown.result;
  const linked = await data(ctx, "fabrik_linked", { p_record: shown.data.record_id, p_relations: ["blocks", "has_task", "parent"], p_direction: "both" });
  if (!linked.ok) return linked.result;
  // deno-lint-ignore no-explicit-any
  const of = (relation: string, direction: string) => (linked.data as any[]).filter((x) => x.relation === relation && x.direction === direction);
  // A has_task link also comes from a person or a business that has the task, as maxy-code kept it: only a plan's make it a project's.
  const plans = of("has_task", "in").filter((x) => x.kind === "activity" && x.payload?.activity_kind === "plan");
  const projects = new Map([...plans, ...of("parent", "out")].map((x) => [x.record_id, { record_id: x.record_id, title: x.title }]));
  return answer({ task: shown.data, projects: [...projects.values()], blocked_by: of("blocks", "in").map(item), blocks: of("blocks", "out").map(item) });
}

/** A project as project_get gives it: the record and its tasks. */
async function projectView(ctx: Ctx, project: string): Promise<Result> {
  const shown = await activity(ctx, project, "plan");
  if (!shown.ok) return shown.result;
  const tasks = await tasksOf(ctx, shown.data.record_id);
  if (!tasks.ok) return tasks.result;
  return answer({ project: shown.data, tasks: tasks.data.map(item) });
}

/** The tasks named for blocked_by or blocks, each as its record_id, found before anything is saved; a deleted one, or
 * one that cannot be read, is refused, naming it. */
async function linkableAll(ctx: Ctx, records: string[]): Promise<{ ok: true; ids: string[] } | { ok: false; result: Result }> {
  const ids: string[] = [];
  for (const r of records) {
    const one = await linkable(ctx, r);
    if (!one.ok) return { ok: false, result: refused(`The blocks link with "${r}" cannot be made, and nothing was saved: ${one.result.content[0].text}`) };
    ids.push(one.id);
  }
  return { ok: true, ids };
}

/** Links each blocker to the task by blocks, one save of each blocker; a refusal names the blocker. */
async function addBlockers(ctx: Ctx, task: string, blockers: string[], reason: string): Promise<Result | null> {
  for (const blocker of blockers) {
    const linked = await data(ctx, "fabrik_link_many", { p_record: blocker, p_links: [{ target: task, relation: "blocks" }], p_reason: reason });
    if (!linked.ok) return refused(`The blocks link from "${blocker}" was not saved: ${linked.result.content[0].text}`);
  }
  return null;
}

/** The activity fields a project or task tool changes, from its input, as fabrik names them. */
const fieldsOf = (a: { description?: string; due?: string | null; deliverables?: string; state?: string }) => ({
  ...(a.description !== undefined ? { description: a.description } : {}),
  ...(a.due !== undefined ? { forecast_finish_at: a.due } : {}),
  ...(a.deliverables !== undefined ? { completion_requirements: a.deliverables } : {}),
  ...(a.state !== undefined ? { state: a.state } : {}),
});

const deliverables = z.string().max(4000).optional().describe("What must exist for it to be completed, in plain words. fabrik completes nothing without them.");

// ---- Projects ----

const projectCreate = tool({
  name: "project_create",
  description: "Start a project in fabrik, as the signed-in person: a plan record of type Project, pending, owned by the person, in General unless scope names another. " +
    "Tasks are added to it with task_create, naming it as project. Answers project, the saved record (record_id, title, payload with state, description, " +
    "forecast_finish_at as the due date, completion_requirements as the deliverables, and properties), and tasks, empty. project_get reads it later.",
  input: z.object({
    title: z.string().min(1).max(500).describe("The project's name, such as Website refresh."),
    description: z.string().max(4000).optional().describe("What the project is for and what is in it."),
    due: z.string().min(1).optional().describe(DUE),
    deliverables,
    properties: properties.optional().describe("Anything else to keep about the project, as names and values, such as {\"client\": \"Acme\"}."),
    scope: z.string().min(1).optional().describe(SCOPE + " General when left out."),
    reason: reasonFor("project_create"),
  }),
  run: async (ctx, a) => {
    const saved = await data(ctx, "fabrik_add_record", {
      p_scope: a.scope ?? GENERAL, p_kind: "activity", p_title: a.title, p_reason: reasonOf(a.reason, "project_create"),
      p_fields: newFields("activity", "Project", a.description ?? "", a.properties ?? {}, { activity_kind: "plan", ...fieldsOf(a) }),
    });
    return saved.ok ? answer({ project: saved.data, tasks: [] }) : saved.result;
  },
});

const projectList = tool({
  name: "project_list",
  description: "List the projects in fabrik the signed-in person may read: every plan, typed Project or made in fabrik as a plan, deleted ones left out. " +
    "Open ones only (pending, in progress or paused) unless state or closed says otherwise. Each item gives record_id, title, type, state, due and scope_id, " +
    "by title. project_get reads one with its tasks.",
  input: z.object({
    state: z.enum(STATES).optional().describe("Only projects in this state."),
    closed: z.boolean().optional().describe("true to list completed and cancelled projects too."),
  }),
  run: async (ctx, a) => {
    const all = await activities(ctx);
    if (!Array.isArray(all)) return all;
    const items = all.filter((x) => x.payload?.activity_kind === "plan" && !isTrashed(x.payload)
      && (a.state ? x.payload?.state === a.state : a.closed || OPEN_STATES.includes(x.payload?.state)))
      .map(item).sort((x, y) => x.title.localeCompare(y.title));
    return answer({ items });
  },
});

const projectGet = tool({
  name: "project_get",
  description: "Read one fabrik project with its tasks. Answers project, the record at its latest version (record_id, scope_id, title, version_number, saved_at, " +
    "payload with state, description, forecast_finish_at as the due date, completion_requirements as the deliverables, and properties, and links), " +
    "and tasks, each with record_id, title, type, state, due and priority, by title, whatever their state. task_ready gives the ones ready to start.",
  input: z.object({ project: z.string().min(1).describe("The project, " + RECORD) }),
  run: (ctx, a) => projectView(ctx, a.project),
});

const projectUpdate = tool({
  name: "project_update",
  description: "Change a fabrik project, as a new version, as the signed-in person: its title, description, due date, deliverables, state and properties. " +
    "A property given a value sets it, given null removes it, and one not given is kept. A state moves only pending to in_progress or cancelled, " +
    "in_progress to paused or cancelled, and paused to in_progress or cancelled; project_complete completes it. " + FINISH_ORDER + " Answers as project_get.",
  input: z.object({
    project: z.string().min(1).describe("The project, " + RECORD),
    title: z.string().min(1).max(500).optional().describe("Its new name."),
    description: z.string().max(4000).optional().describe("Its new description."),
    due: z.string().min(1).nullable().optional().describe(DUE + " null to clear it."),
    deliverables,
    state: z.enum(["pending", "in_progress", "paused", "cancelled"]).optional().describe("Its new state."),
    properties: properties.optional().describe("The properties to set, each name with its value, or with null to remove it."),
    reason: reasonFor("project_update"),
  }),
  run: async (ctx, a) => {
    const fields = fieldsOf(a);
    if (a.title === undefined && a.properties === undefined && Object.keys(fields).length === 0) {
      return refused("Nothing to change: give title, description, due, deliverables, state or properties.");
    }
    const shown = await activity(ctx, a.project, "plan");
    if (!shown.ok) return shown.result;
    const saved = await data(ctx, "fabrik_change_properties", { p_record: shown.data.record_id, p_reason: reasonOf(a.reason, "project_update"),
      p_properties: a.properties ?? {}, p_fields: fields, p_title: a.title ?? null });
    return saved.ok ? projectView(ctx, shown.data.record_id) : saved.result;
  },
});

// ---- Tasks ----

const blockers = (what: string) => z.array(z.string().min(1)).min(1).max(50).optional().describe(what + " Each is " + RECORD +
  " A deleted task is refused before anything is saved.");

const taskCreate = tool({
  name: "task_create",
  description: "Add a task in fabrik, as the signed-in person: a task record of type Task, pending, owned by the person. With project, it is saved in the project's " +
    "scope as part of it, so project_get, task_list and the project's board show it; without, in General unless scope names another. blocked_by names tasks " +
    "that must finish before this one can start, and blocks the tasks that wait on this one; each must be in the same scope. " + FINISH_ORDER + " " +
    "Answers as task_get: task, the saved record; projects; blocked_by and blocks, each task's record_id, title, type, state, due and priority.",
  input: z.object({
    title: z.string().min(1).max(500).describe("The task's title, such as Draft copy."),
    description: z.string().max(4000).optional().describe("What the task is: its scope and what done looks like."),
    project: z.string().min(1).optional().describe("The project it is part of, " + RECORD),
    due: z.string().min(1).optional().describe(DUE),
    priority: z.enum(PRIORITIES).optional().describe("low, normal, high or urgent. Kept in properties."),
    deliverables,
    blocked_by: blockers("Tasks that must finish before this one can start."),
    blocks: blockers("Tasks that cannot start until this one finishes."),
    properties: properties.optional().describe("Anything else to keep about the task, as names and values."),
    scope: z.string().min(1).optional().describe(SCOPE + " The project's scope when project is given, else General."),
    reason: reasonFor("task_create"),
  }),
  run: async (ctx, a) => {
    const reason = reasonOf(a.reason, "task_create");
    const project = a.project ? await activity(ctx, a.project, "plan") : null;
    if (project && !project.ok) return project.result;
    const before = await linkableAll(ctx, a.blocked_by ?? []);
    if (!before.ok) return before.result;
    const after = await linkableAll(ctx, a.blocks ?? []);
    if (!after.ok) return after.result;
    const saved = await data(ctx, "fabrik_add_record", {
      p_scope: a.scope ?? project?.data.scope_id ?? GENERAL, p_kind: "activity", p_title: a.title, p_reason: reason,
      p_fields: newFields("activity", "Task", a.description ?? "", { ...(a.properties ?? {}), ...(a.priority ? { priority: a.priority } : {}) }, fieldsOf(a)),
      p_parent: project?.data.record_id ?? null,
    });
    if (!saved.ok) return saved.result;
    const id = saved.data.record_id as string;
    const partly = (r: Result) => refused(`The task "${a.title}" was saved, as record ${id}, but not all its links: ${r.content[0].text}`);
    if (project) {
      const held = await data(ctx, "fabrik_link_many", { p_record: project.data.record_id, p_links: [{ target: id, relation: "has_task" }], p_reason: reason });
      if (!held.ok) return partly(held.result);
    }
    const blocked = await addBlockers(ctx, id, before.ids, reason);
    if (blocked) return partly(blocked);
    if (after.ids.length) {
      const linked = await data(ctx, "fabrik_link_many", { p_record: id, p_links: after.ids.map((t) => ({ target: t, relation: "blocks" })), p_reason: reason });
      if (!linked.ok) return partly(linked.result);
    }
    return taskView(ctx, id);
  },
});

const taskUpdate = tool({
  name: "task_update",
  description: "Change a fabrik task, as a new version, as the signed-in person: its title, description, due date, priority, deliverables, state and properties, " +
    "and add tasks that block it. A property given a value sets it, given null removes it, and one not given is kept. A state moves only pending to " +
    "in_progress or cancelled, in_progress to paused or cancelled, and paused to in_progress or cancelled; task_complete completes it. " + FINISH_ORDER + " Answers as task_get.",
  input: z.object({
    task: z.string().min(1).describe("The task, " + RECORD),
    title: z.string().min(1).max(500).optional().describe("Its new title."),
    description: z.string().max(4000).optional().describe("Its new description."),
    due: z.string().min(1).nullable().optional().describe(DUE + " null to clear it."),
    priority: z.enum(PRIORITIES).optional().describe("low, normal, high or urgent."),
    deliverables,
    state: z.enum(["pending", "in_progress", "paused", "cancelled"]).optional().describe("Its new state."),
    properties: properties.optional().describe("The properties to set, each name with its value, or with null to remove it."),
    blocked_by: blockers("Tasks to add that must finish before this one can start."),
    reason: reasonFor("task_update"),
  }),
  run: async (ctx, a) => {
    const fields = fieldsOf(a);
    const props = { ...(a.properties ?? {}), ...(a.priority ? { priority: a.priority } : {}) };
    const changes = a.title !== undefined || Object.keys(props).length > 0 || Object.keys(fields).length > 0;
    if (!changes && !a.blocked_by) return refused("Nothing to change: give title, description, due, priority, deliverables, state, properties or blocked_by.");
    const shown = await activity(ctx, a.task, "task");
    if (!shown.ok) return shown.result;
    const before = await linkableAll(ctx, a.blocked_by ?? []);
    if (!before.ok) return before.result;
    const reason = reasonOf(a.reason, "task_update");
    if (changes) {
      const saved = await data(ctx, "fabrik_change_properties", { p_record: shown.data.record_id, p_reason: reason, p_properties: props, p_fields: fields, p_title: a.title ?? null });
      if (!saved.ok) return saved.result;
    }
    const blocked = await addBlockers(ctx, shown.data.record_id, before.ids, reason);
    if (blocked) return changes ? refused(`The task's change was saved, but not all its blockers: ${blocked.content[0].text}`) : blocked;
    return taskView(ctx, shown.data.record_id);
  },
});

const taskList = tool({
  name: "task_list",
  description: "List the tasks in fabrik the signed-in person may read, deleted ones left out, optionally of one project. Open ones only (pending, in progress or paused) " +
    "unless state or closed says otherwise. Each item gives record_id, title, type, state, due, priority and scope_id, soonest due first, then by title. " +
    "task_get reads one; task_ready gives those ready to start.",
  input: z.object({
    project: z.string().min(1).optional().describe("Only this project's tasks: the project, " + RECORD),
    state: z.enum(STATES).optional().describe("Only tasks in this state."),
    closed: z.boolean().optional().describe("true to list completed and cancelled tasks too."),
  }),
  run: async (ctx, a) => {
    let within: Set<string> | null = null;
    if (a.project) {
      const project = await activity(ctx, a.project, "plan");
      if (!project.ok) return project.result;
      const tasks = await tasksOf(ctx, project.data.record_id);
      if (!tasks.ok) return tasks.result;
      within = new Set(tasks.data.map((x) => x.record_id));
    }
    const all = await activities(ctx);
    if (!Array.isArray(all)) return all;
    const items = all.filter((x) => x.payload?.activity_kind === "task" && !isTrashed(x.payload) && (!within || within.has(x.record_id))
      && (a.state ? x.payload?.state === a.state : a.closed || OPEN_STATES.includes(x.payload?.state)))
      .map(item).sort((x, y) => (x.due ?? "￿").localeCompare(y.due ?? "￿") || x.title.localeCompare(y.title));
    return answer({ items });
  },
});

const taskGet = tool({
  name: "task_get",
  description: "Read one fabrik task with what blocks it and what it blocks. Answers task, the record at its latest version (record_id, scope_id, title, version_number, " +
    "saved_at, payload with state, description, forecast_finish_at as the due date, completion_requirements as the deliverables, completion_note and properties, " +
    "and links); projects, each project it is part of, record_id and title; blocked_by, the tasks that must finish before it can start, and blocks, the tasks " +
    "waiting on it, each with record_id, title, type, state, due and priority. A blocker that is completed or cancelled no longer holds it up.",
  input: z.object({ task: z.string().min(1).describe("The task, " + RECORD) }),
  run: (ctx, a) => taskView(ctx, a.task),
});

const taskReady = tool({
  name: "task_ready",
  description: "List the fabrik tasks ready to start, optionally of one project: open tasks (pending, in progress or paused) the signed-in person may read, " +
    "deleted ones left out, that no open task blocks. Use it for what can be done next. Each item gives record_id, title, type, state, due and priority, " +
    "soonest due first, then by title; an empty list when nothing is ready. A blocking task the person cannot read does not count, so a task " +
    "it blocks may be listed. task_get says what blocks a task that is not listed.",
  input: z.object({ project: z.string().min(1).optional().describe("Only this project's tasks: the project, " + RECORD) }),
  run: async (ctx, a) => {
    let project: string | null = null;
    if (a.project) {
      const shown = await activity(ctx, a.project, "plan");
      if (!shown.ok) return shown.result;
      project = shown.data.record_id;
    }
    const ready = await data(ctx, "fabrik_ready_tasks", { p_project: project });
    // deno-lint-ignore no-explicit-any
    return ready.ok ? answer({ items: (ready.data as any[]).map(item) }) : ready.result;
  },
});

// ---- Completing ----

/** The completion note kept when the person gives none. */
const NOTE = "Marked complete by the person.";

/** Completes a project or a task within fabrik's completion rule, which needs the activity in progress, its deliverables
 * and a completion note written, no blockers, and a supports link to evidence. A task that an open task still blocks is
 * refused first, naming those tasks. Then, each only where needed: the activity moved to in progress with its deliverables
 * written (those given, else its description, else its title); the note saved as a Note evidence record in its scope when
 * no evidence is named; the evidence linked by supports; and the completion with the note. Answers the record as
 * task_get or project_get does, with evidence, and for a task, unblocked, the tasks now ready that it held up, and for a
 * project, open_tasks, its tasks not yet completed or cancelled. */
async function complete(ctx: Ctx, a: { record: string; note?: string; evidence?: string[]; deliverables?: string; reason?: string },
  kind: "plan" | "task", toolName: string): Promise<Result> {
  const shown = await activity(ctx, a.record, kind);
  if (!shown.ok) return shown.result;
  const rec = shown.data, id = rec.record_id as string, p = rec.payload, title = rec.title as string;
  const what = kind === "plan" ? "project" : "task";
  if (p.state === "completed") return refused(`The ${what} "${title}" is already completed.`);
  if (p.state === "cancelled") return refused(`The ${what} "${title}" is cancelled, and a cancelled ${what} stays cancelled.`);
  if (kind === "task") {
    const blocking = await data(ctx, "fabrik_linked", { p_record: id, p_relations: ["blocks"], p_direction: "in" });
    if (!blocking.ok) return blocking.result;
    // deno-lint-ignore no-explicit-any
    const open = (blocking.data as any[]).filter((x) => OPEN_STATES.includes(x.payload?.state)).map((x) => `"${x.title}"`);
    if (open.length) return refused(`"${title}" cannot be completed yet: ${open.join(", ")} must finish first. Complete ${open.length > 1 ? "them" : "it"} with task_complete, or cancel ${open.length > 1 ? "them" : "it"} with task_update.`);
  }
  // deno-lint-ignore no-explicit-any
  if ((p.blockers ?? []).length) return refused(`"${title}" cannot be completed while it lists blockers: ${(p.blockers as any[]).map((b) => `"${b.description}"`).join(", ")}. Clear each first.`);
  // Each evidence record named is checked before anything is saved, so a wrong one changes nothing.
  const named: string[] = [];
  for (const e of a.evidence ?? []) {
    const ev = await data(ctx, "fabrik_show_record", { p_record: e });
    if (!ev.ok) return refused(`"${title}" was not completed, and nothing was saved: the evidence "${e}" cannot be read: ${ev.result.content[0].text}`);
    const problem = ev.data.kind !== "evidence" ? `is ${ev.data.kind === "activity" ? "an" : "a"} ${ev.data.kind} record, not an evidence record`
      : ev.data.scope_id !== rec.scope_id ? `is in ${ev.data.scope_name}, not in the ${what}'s scope, ${rec.scope_name}`
      : isTrashed(ev.data.payload) ? "is deleted; restore_record brings it back" : null;
    if (problem) return refused(`"${title}" was not completed, and nothing was saved: the evidence "${ev.data.title}" ${problem}.`);
    named.push(ev.data.record_id);
  }
  const reason = reasonOf(a.reason, toolName), note = a.note?.trim() ? a.note : NOTE;
  const done: string[] = [];
  const failed = (r: Result) => refused(`"${title}" was not completed: ${r.content[0].text}${done.length ? ` Saved before that: ${done.join("; ")}.` : ""}`);
  // In progress, with its deliverables written.
  const fields: Record<string, unknown> = {};
  if (p.state !== "in_progress") fields.state = "in_progress";
  if (a.deliverables?.trim()) fields.completion_requirements = a.deliverables;
  else if (!String(p.completion_requirements ?? "").trim()) fields.completion_requirements = String(p.description ?? "").trim() || title;
  if (Object.keys(fields).length) {
    const started = await data(ctx, "fabrik_change_properties", { p_record: id, p_reason: reason, p_properties: {}, p_fields: fields });
    if (!started.ok) return failed(started.result);
    done.push(fields.state ? "the move to in progress" : "the deliverables");
  }
  // The evidence: the records named, else the note itself.
  let evidence = named;
  if (!evidence.length) {
    const saved = await data(ctx, "fabrik_add_record", { p_scope: rec.scope_id, p_kind: "evidence", p_title: `${title}: completed`, p_reason: reason,
      p_fields: newFields("evidence", "Note", note, {}, { source_reference: `Completion of ${title}` }) });
    if (!saved.ok) return failed(saved.result);
    evidence = [saved.data.record_id];
    done.push(`the note, as evidence record ${saved.data.record_id}`);
  }
  const linked = await data(ctx, "fabrik_link_many", { p_record: id, p_links: evidence.map((e) => ({ target: e, relation: "supports" })), p_reason: reason });
  if (!linked.ok) return failed(linked.result);
  const completed = await data(ctx, "fabrik_set_state", { p_record: id, p_state: "completed", p_reason: reason, p_note: note });
  if (!completed.ok) return failed(completed.result);
  // The completion is saved: a read after it that fails is said beside it, never as the tool's error, so the agent does
  // not try the completion again.
  const unread = (r: Result) => answer({ completed: true, record_id: id, title, state: "completed", evidence: evidence,
    note: `The ${what} "${title}" is completed, but reading it back failed: ${r.content[0].text} ${kind === "plan" ? "project_get" : "task_get"} reads it.` });
  const view = kind === "plan" ? await projectView(ctx, id) : await taskView(ctx, id);
  if (view.isError) return unread(view);
  const body = view.structuredContent as Record<string, unknown>;
  const ev = await data(ctx, "fabrik_linked", { p_record: id, p_relations: ["supports"], p_direction: "out" });
  if (!ev.ok) return unread(ev.result);
  // deno-lint-ignore no-explicit-any
  const evidenceOut = (ev.data as any[]).map((x) => ({ record_id: x.record_id, title: x.title, type: x.type }));
  if (kind === "plan") {
    // deno-lint-ignore no-explicit-any
    return answer({ ...body, evidence: evidenceOut, open_tasks: (body.tasks as any[]).filter((t) => OPEN_STATES.includes(t.state)) });
  }
  const ready = await data(ctx, "fabrik_ready_tasks", {});
  if (!ready.ok) return unread(ready.result);
  // deno-lint-ignore no-explicit-any
  const waiting = new Set((body.blocks as any[]).map((t) => t.record_id));
  // deno-lint-ignore no-explicit-any
  return answer({ ...body, evidence: evidenceOut, unblocked: (ready.data as any[]).filter((t) => waiting.has(t.record_id)).map(item) });
}

const completeInput = (what: string) => ({
  note: z.string().max(4000).optional().describe(`How the ${what} was done, in the person's words. "${NOTE}" when left out.`),
  evidence: z.array(z.string().min(1)).min(1).max(20).optional().describe(`Evidence records in the ${what}'s scope that show it done, such as a document or a note saved with remember or ingest_document; ` +
    "any other kind of record, one in another scope, or a deleted one is refused before anything is saved. Each is " + RECORD +
    " When left out, the note is saved as a Note evidence record and used."),
  deliverables: z.string().min(1).max(4000).optional().describe(`What had to exist for the ${what} to be done. Needed by fabrik; when the ${what} has none and none is given, its description is used, or its title.`),
});

const taskComplete = tool({
  name: "task_complete",
  description: "Mark a fabrik task done, as the signed-in person; \"mark it done\" is enough. fabrik completes a task only when it is in progress, has its deliverables " +
    "and a completion note written, lists no blockers, and has evidence linked by supports, so this tool does each step that is missing: it moves a pending or " +
    "paused task to in progress, writes its deliverables when it has none (those given, else its description, else its title), saves the note as a Note " +
    "evidence record when no evidence is named, links the evidence, and completes the task with the note. It refuses a task that another open task still " +
    "blocks, naming those tasks, and one already completed or cancelled. A refusal says what was saved before it. Answers as task_get, with evidence, the " +
    "records linked as evidence, and unblocked, the tasks it held up that are now ready to start.",
  input: z.object({
    task: z.string().min(1).describe("The task, " + RECORD),
    ...completeInput("task"),
    reason: reasonFor("task_complete"),
  }),
  run: (ctx, a) => complete(ctx, { ...a, record: a.task }, "task", "task_complete"),
});

const projectComplete = tool({
  name: "project_complete",
  description: "Mark a fabrik project done, as the signed-in person; \"mark it done\" is enough. fabrik completes a project only when it is in progress, has its " +
    "deliverables and a completion note written, lists no blockers, and has evidence linked by supports, so this tool does each step that is missing: it moves " +
    "a pending or paused project to in progress, writes its deliverables when it has none (those given, else its description, else its title), saves the note as " +
    "a Note evidence record when no evidence is named, links the evidence, and completes the project with the note. Its tasks are left as they are: fabrik does " +
    "not require them done, so open_tasks lists those still open, for the person to complete with task_complete or cancel with task_update. It refuses a " +
    "project already completed or cancelled. A refusal says what was saved before it. Answers as project_get, with evidence and open_tasks.",
  input: z.object({
    project: z.string().min(1).describe("The project, " + RECORD),
    ...completeInput("project"),
    reason: reasonFor("project_complete"),
  }),
  run: (ctx, a) => complete(ctx, { ...a, record: a.project }, "plan", "project_complete"),
});

/** The projects and tasks tools, in the order Claude lists them. */
export const WORK_TOOLS: Tool[] = [
  projectCreate, projectList, projectGet, projectUpdate, projectComplete, taskCreate, taskUpdate, taskList, taskGet, taskComplete, taskReady,
];
