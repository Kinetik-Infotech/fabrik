// The memory tools, ported from maxy-code's memory plugin onto fabrik's records: remember, update_record,
// lookup_by_name, delete_record, restore_record, ingest_document, profile_get and profile_update. search and
// link_records are index.ts's own. A record keeps its maxy-code type in payload.type and the rest in
// payload.properties, as an imported one does. Deleting is a soft delete, which restore_record undoes.
import { z } from "npm:zod@4.3.6";
import { answer, refused, type Tool, tool } from "./tool.ts";
import { changedByOther, data, GENERAL, linkable, newFields, ownProperties, ownRecord, reasonOf, setTrashed, uploadFile } from "./ported.ts";

const RECORD = "A record is named by its record_id, or by its exact title in any case among the records the person may read: " +
  "the one not deleted that has the title, or a deleted one only when none not deleted has it; " +
  "a title more than one record could be meant by is refused, with each one's title, scope, last save and id, a deleted one marked.";
const SCOPE = "The scope to save in, by its scope_id, code or name, from list_scopes. General when left out.";
const reasonFor = (name: string) => z.string().min(1).optional().describe(`Why this is saved, in the person's words. It is kept with the version. "Saved with ${name}" when left out.`);
const properties = z.record(z.string(), z.unknown());

// ---- Saving and changing records ----

const remember = tool({
  name: "remember",
  description: "Save something the person wants kept in fabrik, as a new record, as the signed-in person. By default it is a note: " +
    "an evidence record of type Note whose summary is text. type names what it is, such as Note, Decision, Idea or Person, and kind its fabrik kind " +
    "(evidence when left out; text becomes a model's description, an activity's description or a decision's question). properties keeps anything else " +
    "about it, such as an email or a date. links joins it to records already saved, each by its target record and a relation, such as mentions or authored; " +
    "a deleted target is refused before anything is saved. " +
    "Answers the saved version: record_id, version_id, title and payload, and with links, each linked record's record_id, title, type, relation and note. " +
    "search and lookup_by_name find it afterwards; update_record changes it. " +
    "Use it for a note or a fact; for a project, a task or a contact use project_create, task_create or contact_create, and for fabrik's own kinds and fields save_record.",
  input: z.object({
    title: z.string().min(1).max(500).describe("The record's title: a short name for it, such as Call with Ann about the lease."),
    text: z.string().min(1).max(4000).describe("What to keep, in plain words, up to 4000 characters."),
    type: z.string().min(1).max(100).optional().describe("What the record is, such as Note, Idea or Person. Note when left out."),
    kind: z.enum(["evidence", "model", "activity", "decision"]).optional().describe("The fabrik kind. evidence when left out."),
    properties: properties.optional().describe("Anything else to keep about it, as names and values, such as {\"email\": \"ann@example.com\"}."),
    scope: z.string().min(1).optional().describe(SCOPE),
    reason: reasonFor("remember"),
    links: z.array(z.object({
      target: z.string().min(1).describe("The record to link to. " + RECORD),
      relation: z.string().min(1).describe("The link's relation, such as mentions, authored, supports or describes; get_reference with part relations lists them."),
      note: z.string().optional().describe("A note on the link."),
    })).min(1).max(200).optional().describe("Links from the new record to records already saved."),
  }),
  run: async (ctx, a) => {
    const kind = a.kind ?? "evidence", reason = reasonOf(a.reason, "remember");
    // Each target is found before the record is saved, so a wrong or deleted one leaves nothing half done.
    const links = [];
    for (const l of a.links ?? []) {
      const target = await linkable(ctx, l.target);
      if (!target.ok) return refused(`Nothing was saved: the link to "${l.target}" cannot be made: ${target.result.content[0].text}`);
      links.push({ ...l, target: target.id });
    }
    const saved = await data(ctx, "fabrik_add_record", {
      p_scope: a.scope ?? GENERAL, p_kind: kind, p_title: a.title, p_reason: reason,
      p_fields: newFields(kind, a.type ?? "Note", a.text, a.properties ?? {}),
    });
    if (!saved.ok) return saved.result;
    if (!a.links) return answer(saved.data);
    const linked = await data(ctx, "fabrik_link_many", { p_record: saved.data.record_id, p_links: links, p_reason: reason });
    if (!linked.ok) {
      return refused(`The record "${a.title}" was saved, as record ${saved.data.record_id}, but its links were not: ${linked.result.content[0].text}`);
    }
    // The links as saved, each with its target's record_id, title and type, read back from fabrik.
    const made = await data(ctx, "fabrik_linked", { p_record: saved.data.record_id, p_relations: [...new Set(a.links.map((l) => l.relation))], p_direction: "out" });
    // The record and its links are saved: a read-back that fails is said beside them, so the agent does not save them again.
    if (!made.ok) return answer({ ...linked.data, note: `"${a.title}" and its links are saved, but reading the links back failed: ${made.result.content[0].text}` });
    // deno-lint-ignore no-explicit-any
    return answer({ ...linked.data, links: (made.data as any[]).map(({ record_id, title, type, relation, note }) => ({ record_id, title, type, relation, note })) });
  },
});

const updateRecord = tool({
  name: "update_record",
  description: "Change a fabrik record, as a new version, as the signed-in person: its title, its fields, and its properties. " +
    "properties are merged into the ones it has: a name given a value sets it, a name given null removes it, and a name not given is kept. " +
    "fields are the record's own fields, as save_record lists them for its kind, such as an evidence record's summary or a task's state, " +
    "and type what the record is, such as Note. Its links are kept. Earlier versions stay in its history. Answers the saved version.",
  input: z.object({
    record: z.string().min(1).describe("The record to change. " + RECORD),
    title: z.string().min(1).max(500).optional().describe("Its new title."),
    type: z.string().min(1).max(100).optional().describe("Its new type, such as Note or Idea."),
    fields: properties.optional().describe("The record's own fields to change, such as {\"summary\": \"...\"}."),
    properties: properties.optional().describe("The properties to set, each name with its value, or with null to remove it."),
    reason: reasonFor("update_record"),
  }),
  run: (ctx, a) => {
    if (a.title === undefined && a.type === undefined && a.fields === undefined && a.properties === undefined) {
      return Promise.resolve(refused("Nothing to change: give title, type, fields or properties."));
    }
    return data(ctx, "fabrik_change_properties", {
      p_record: a.record, p_reason: reasonOf(a.reason, "update_record"), p_properties: a.properties ?? {},
      p_fields: { ...(a.fields ?? {}), ...(a.type ? { type: a.type } : {}) }, p_title: a.title ?? null,
    }).then((r) => r.ok ? answer(r.data) : r.result);
  },
});

// ---- Finding, deleting and restoring ----

const lookupByName = tool({
  name: "lookup_by_name",
  description: "Find fabrik records by their exact title, in any case, among the records the signed-in person may read. A name match is exact, " +
    "not ranked, so use it when search does not give a record the person names, or when they ask for one by its name. Deleted records are left out. " +
    "Answers items, newest save first, at most 50, each with record_id, kind, type, title, scope_id and saved_at; an empty list when none has that title. " +
    "get_record reads one. Use search to find records by what they say.",
  input: z.object({
    name: z.string().min(1).describe("The exact title to find, in any case, such as Acme Ltd."),
    type: z.string().min(1).optional().describe("Only records of this type, such as Person or Note."),
  }),
  run: async (ctx, a) => {
    const found = await data(ctx, "fabrik_find_by_name", { p_name: a.name, p_type: a.type ?? null });
    return found.ok ? answer({ items: found.data ?? [] }) : found.result;
  },
});

const deleteRecord = tool({
  name: "delete_record",
  description: "Delete a fabrik record, as the signed-in person, so that lookup_by_name and the lists of the ported tools leave it out. " +
    "It is saved as a new version marked deleted, with the time and the reason, and restore_record brings it back. " +
    "A record already deleted is refused. Answers the saved version.",
  input: z.object({
    record: z.string().min(1).describe("The record to delete. " + RECORD),
    reason: reasonFor("delete_record"),
  }),
  run: (ctx, a) => setTrashed(ctx, a.record, true, reasonOf(a.reason, "delete_record")),
});

const restoreRecord = tool({
  name: "restore_record",
  description: "Bring back a fabrik record that delete_record deleted, as a new version, as the signed-in person; lookup_by_name finds it again. " +
    "A record that is not deleted is refused. Answers the saved version; when a record not deleted has the same title, also same_title, " +
    "each such record's record_id, type, scope_id and saved_at, and note, saying the title alone now names neither.",
  input: z.object({
    record: z.string().min(1).describe("The deleted record, by its record_id, or by its exact title in any case: the one deleted record " +
      "with the title, even when one not deleted has it too; a title more than one deleted record has is refused, with each one's id."),
    reason: reasonFor("restore_record"),
  }),
  run: (ctx, a) => setTrashed(ctx, a.record, false, reasonOf(a.reason, "restore_record")),
});

// ---- Documents ----

/** How much of a document's text is its summary when none is given. */
const SUMMARY_LENGTH = 1000;

const ingestDocument = tool({
  name: "ingest_document",
  description: "Keep a document in fabrik: upload the file into a scope's files and save an evidence record of type Document about it, as the signed-in person. " +
    "The record's summary is summary, or the start of the text; its properties give the file's bucket, path, content_type and size. " +
    "File search reads the text of PDF, .xlsx, .docx, Markdown and plain text files soon after, so search then finds both the record and the file, and read_file reads the file. " +
    "Answers record, the saved version, and file: scope, scope_name, path, size and content_type. " +
    "The person needs create permission in the scope, and edit permission to replace a file.",
  input: z.object({
    path: z.string().min(1).max(1024).describe("Where the file goes in the scope, such as contracts/lease.pdf. No leading /, and no . or .. parts."),
    content: z.string().describe("The file's content: its text, or with encoding base64, its bytes in base64."),
    encoding: z.enum(["text", "base64"]).optional().describe("text (UTF-8) when left out, or base64 for a binary file such as a PDF."),
    content_type: z.string().min(1).optional().describe("The file's type, such as application/pdf. Taken from the path's extension when left out."),
    overwrite: z.boolean().optional().describe("true to replace a file already at that path."),
    title: z.string().min(1).max(500).optional().describe("The record's title. The file's name when left out."),
    summary: z.string().min(1).max(4000).optional().describe("What the document is, in a few sentences. Needed for a file sent in base64; the start of the text otherwise."),
    type: z.string().min(1).max(100).optional().describe("What the document is, such as Contract or Invoice. Document when left out."),
    properties: properties.optional().describe("Anything else to keep about the document."),
    scope: z.string().min(1).optional().describe(SCOPE),
    reason: reasonFor("ingest_document"),
  }),
  run: async (ctx, a) => {
    const text = a.encoding === "base64" ? null : a.content.trim();
    const summary = a.summary ?? (text ? text.slice(0, SUMMARY_LENGTH) : null);
    if (!summary) return refused("Give summary: the file is sent in base64, or has no text, so it has no start to take one from.");
    const uploaded = await uploadFile(ctx, { ...a, scope: a.scope ?? GENERAL });
    if (uploaded.isError) return uploaded;
    const file = uploaded.structuredContent as { scope: string; scope_name: string; path: string; size: number; content_type: string };
    const saved = await data(ctx, "fabrik_add_record", {
      p_scope: file.scope, p_kind: "evidence", p_title: a.title ?? a.path.split("/").pop(), p_reason: reasonOf(a.reason, "ingest_document"),
      p_fields: newFields("evidence", a.type ?? "Document", summary,
        { ...(a.properties ?? {}), bucket: file.scope, path: file.path, content_type: file.content_type, size: file.size },
        { source_reference: `File ${file.path} in the ${file.scope_name} scope` }),
    });
    if (!saved.ok) return refused(`The file ${file.path} was uploaded to ${file.scope_name}, but its record was not saved: ${saved.result.content[0].text}`);
    return answer({ record: saved.data, file });
  },
});

// ---- The person's profile ----

const PROFILE = "UserProfile";
const PREFERENCE_CATEGORIES = ["communication", "scheduling", "decision", "workflow", "content", "interaction"] as const;
/** What profile_get answers for a profile someone else saved last. */
const PROFILE_FOREIGN = "Your profile was last changed by someone else, so it is left out. profile_update saves it again as yours, with only what you give it.";

const profileGet = tool({
  name: "profile_get",
  description: "Read the signed-in person's profile in fabrik: who they are and how they like to work, kept in their own UserProfile record in General. " +
    "Answers profile, null when none is saved yet, else record_id, title, saved_at and properties: givenName, familyName, role, expertise, timezone, " +
    "locale, email and telephone where known, and preferences, each under category.key with its category, key, value, source (explicit or behavioural) " +
    "and observedAt. profile_update sets them. A profile someone else changed last is not used: profile is null and note says so.",
  input: z.object({}),
  run: async (ctx) => {
    const found = await ownRecord(ctx, PROFILE);
    if ("content" in found) return found;
    const p = found.record;
    if (changedByOther(p)) return answer({ profile: null, note: PROFILE_FOREIGN });
    return answer({ profile: p ? { record_id: p.record_id, title: p.title, saved_at: p.saved_at, properties: p.payload?.properties ?? {} } : null });
  },
});

const text = z.string().nullable().optional();
const profileUpdate = tool({
  name: "profile_update",
  description: "Set the signed-in person's profile in fabrik: fields about them, and preferences about how they like to work. It is their own UserProfile record " +
    "in General, made by their first call. A field given a value sets it, given null removes it, and one not given is kept. A preference is kept " +
    "under its category and key; the same category and key again replaces its value, and a value of null removes it. Use it when the person says " +
    "how they like something done, or tells you about themselves. Over a profile someone else changed last, only what is given now is kept. " +
    "Answers the saved version; profile_get reads the profile.",
  input: z.object({
    fields: z.object({
      givenName: text, familyName: text, role: text, expertise: text, timezone: text, locale: text, email: text,
      telephone: text.describe("The person's phone number. telephone, not phone."),
    }).optional().describe("Fields about the person: givenName, familyName, role, expertise, timezone (such as Europe/London), locale (such as en-GB), email and telephone."),
    preferences: z.array(z.object({
      category: z.enum(PREFERENCE_CATEGORIES).describe("communication, scheduling, decision, workflow, content or interaction."),
      key: z.string().min(1).max(100).describe("What the preference is about, such as response_length or meeting_time."),
      value: z.string().min(1).nullable().describe("The preference, such as terse or never before 10am, or null to remove it."),
      source: z.enum(["explicit", "behavioural"]).optional().describe("explicit when the person said it, behavioural when it was seen in what they do. behavioural when left out."),
    })).max(50).optional().describe("Preferences to set or remove."),
    reason: reasonFor("profile_update"),
  }),
  run: async (ctx, a) => {
    if (!a.fields && !a.preferences) return refused("Nothing to change: give fields or preferences.");
    const found = await ownRecord(ctx, PROFILE);
    if ("content" in found) return found;
    const reason = reasonOf(a.reason, "profile_update");
    const props: Record<string, unknown> = { ...(a.fields ?? {}) };
    if (a.preferences) {
      const kept = { ...(changedByOther(found.record) ? {} : found.record?.payload?.properties?.preferences ?? {}) };
      const at = new Date().toISOString();
      for (const p of a.preferences) {
        const key = `${p.category}.${p.key}`;
        if (p.value === null) delete kept[key];
        else kept[key] = { category: p.category, key: p.key, value: p.value, source: p.source ?? "behavioural", observedAt: at };
      }
      props.preferences = kept;
    }
    // Read, then written: preferences saved by another call between the two are lost, since the whole set is saved.
    if (found.record) {
      const saved = await data(ctx, "fabrik_change_properties", { p_record: found.record.record_id, p_reason: reason, p_properties: ownProperties(found.record, props) });
      return saved.ok ? answer(saved.data) : saved.result;
    }
    const added = { ...Object.fromEntries(Object.entries(props).filter(([, v]) => v !== null && v !== undefined)) };
    const saved = await data(ctx, "fabrik_add_record", {
      p_scope: found.scope.scope_id, p_kind: "model", p_title: "Profile", p_reason: reason,
      p_fields: newFields("model", PROFILE, "Who the person is and how they like to work.", added),
    });
    return saved.ok ? answer(saved.data) : saved.result;
  },
});

/** The memory tools, in the order Claude lists them. */
export const MEMORY_TOOLS: Tool[] = [
  remember, updateRecord, lookupByName, deleteRecord, restoreRecord, ingestDocument, profileGet, profileUpdate,
];
