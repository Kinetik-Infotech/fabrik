// The contact tools, ported from maxy-code's contacts plugin onto fabrik's records: contact_create, contact_lookup,
// contact_update, contact_list, contact_delete, contact_export, group_create and group_manage. A contact is an evidence
// record of type Person (or Organization), its title the name, its details in payload.properties under maxy-code's own
// names (givenName, familyName, name, email, telephone, telegramUserId, jobTitle, source, status), as the maxy import
// saves them. A group is a model record of type Group; a member is a person with a member_of link to it. Deleting a
// contact is a soft delete, as delete_record's. contact_export reads what links to the person: a note that mentions them,
// or something they authored.
import { z } from "npm:zod@4.3.6";
import { answer, refused, type Result, type Tool, tool } from "./tool.ts";
import { data, GENERAL, isTrashed, named, newFields, reasonOf, setTrashed } from "./ported.ts";

const PERSON = "Person";
const ORGANIZATION = "Organization";
const GROUP = "Group";
const CONTACT_TYPES = [PERSON, ORGANIZATION];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTACT = "A contact is named by its record_id, its exact name in any case, its email address, or its telephone number; " +
  "a name more than one contact has is refused, with each one's name, scope, last save and id.";
const reasonFor = (name: string) => z.string().min(1).optional().describe(`Why this is saved, in the person's words. It is kept with the version. "Saved with ${name}" when left out.`);

// deno-lint-ignore no-explicit-any
type Item = any;

/** The properties the contact tools keep, under maxy-code's names. */
const DETAILS = ["givenName", "familyName", "name", "email", "telephone", "telegramUserId", "jobTitle", "source", "status"] as const;

/** A contact's title: its name, else its given and family names, else its email, telephone or Telegram id. */
function titleOf(p: Record<string, unknown>): string {
  const name = String(p.name ?? "").trim() || [p.givenName, p.familyName].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ");
  return name || String(p.email ?? "").trim() || String(p.telephone ?? "").trim() || (p.telegramUserId != null ? `Telegram ${p.telegramUserId}` : "");
}

/** The summary a new contact gets, which fabrik's evidence needs: its name and what it is. */
const summaryOf = (title: string, type: string) => `${title}, ${type === PERSON ? "a person" : "an organization"} in the contacts.`;

/** One contact as the tools show it. */
function shown(x: Item) {
  const p = x.payload?.properties ?? {};
  const { trashed_at: _t, trashed_reason: _r, ...properties } = p;
  return { record_id: x.record_id, name: x.title, type: x.payload?.type, scope_id: x.scope_id, saved_at: x.saved_at, properties };
}

/** The contacts of both types whose properties hold match and whose name holds every word, newest save first. */
async function find(ctx: Parameters<typeof data>[0], match: Record<string, unknown>, words: string | null, limit: number): Promise<{ ok: true; items: Item[]; more: boolean } | { ok: false; result: Result }> {
  const items: Item[] = [];
  let more = false;
  for (const type of CONTACT_TYPES) {
    const found = await data(ctx, "fabrik_find_typed", { p_type: type, p_match: { properties: match }, p_words: words, p_trashed: false, p_limit: limit, p_own: false });
    if (!found.ok) return found;
    items.push(...found.data.items);
    more = more || found.data.more;
  }
  items.sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)));
  return { ok: true, items: items.slice(0, limit), more: more || items.length > limit };
}

/** A detail as two contacts compare it: an email in any case with no outer spaces, a telephone by its digits and +. */
const comparable = (key: string, v: unknown) => v == null ? null
  : key === "email" ? String(v).trim().toLowerCase() : key === "telephone" ? String(v).replace(/[^0-9+]/g, "") : v;

/** As find, but an email or telephone in by is matched as comparable gives it, through fabrik_find_contacts, and the
 * rest of by, and the words, among those. */
async function findBy(ctx: Parameters<typeof data>[0], by: Record<string, unknown>, words: string | null, limit: number): Promise<{ ok: true; items: Item[]; more: boolean } | { ok: false; result: Result }> {
  const key = (["email", "telephone"] as const).find((k) => by[k] != null);
  if (!key) return find(ctx, by, words, limit);
  const found = await data(ctx, "fabrik_find_contacts", { p_key: key, p_value: String(by[key]), p_limit: 500 });
  if (!found.ok) return found;
  const wanted = (words ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const items = (found.data.items as Item[]).filter((x) => Object.entries(by).every(([k, v]) => comparable(k, x.payload?.properties?.[k]) === comparable(k, v))
    && wanted.every((w) => String(x.title ?? "").toLowerCase().includes(w)));
  return { ok: true, items: items.slice(0, limit), more: found.data.more === true || items.length > limit };
}

/** The contact a name, record_id, email or telephone points to: the record_id, or the refusal in plain words. A record
 * that is not a contact, or is deleted, is refused too. */
async function contactOf(ctx: Parameters<typeof data>[0], given: string): Promise<{ ok: true; id: string; record: Item } | { ok: false; result: Result }> {
  const ref = given.trim();
  let id: string | null = null;
  if (UUID.test(ref)) id = ref;
  else {
    // By the rule named() keeps, over both types at once: the one contact not deleted with the name, or, when none
    // not deleted has it, the one deleted contact with it.
    const hits: Item[] = [];
    for (const type of CONTACT_TYPES) {
      const found = await data(ctx, "fabrik_find_by_name", { p_name: ref, p_type: type, p_trashed: true });
      if (!found.ok) return found;
      hits.push(...found.data);
    }
    const live = hits.filter((x) => x.deleted !== true);
    const one = live.length === 1 ? live[0] : live.length === 0 && hits.length === 1 ? hits[0] : null;
    if (one) id = one.record_id;
    else if (hits.length) {
      const types = [...new Set(hits.map((x) => x.type))];
      return { ok: false, result: refused(`More than one ${types.length === 1 ? types[0] : "contact"} has the title "${ref}": ` +
        hits.map((x) => `${x.title} (scope ${x.scope_id}, saved ${x.saved_at}${x.deleted ? ", deleted" : ""}, id ${x.record_id})`).join("; ")) };
    }
    if (id === null) {
      const by = ref.includes("@") ? { email: ref } : /^[+\d][\d\s()+-]*$/.test(ref) ? { telephone: ref } : null;
      const matched = by ? await findBy(ctx, by, null, 10) : null;
      if (matched && !matched.ok) return matched;
      if (matched?.ok && matched.items.length === 1) id = matched.items[0].record_id;
      else if (matched?.ok && matched.items.length > 1) {
        return { ok: false, result: refused(`More than one contact has "${ref}": ` + matched.items.map((x) => `${x.title} (scope ${x.scope_id}, saved ${x.saved_at}, id ${x.record_id})`).join("; ")) };
      }
    }
    if (id === null) return { ok: false, result: refused(`Record unavailable: no contact you can read has the name, email or telephone "${ref}"`) };
  }
  const record = await data(ctx, "fabrik_show_record", { p_record: id });
  if (!record.ok) return record;
  const r = record.data;
  if (!CONTACT_TYPES.includes(r.payload?.type)) return { ok: false, result: refused(`"${r.title}" is not a contact: contact_list lists the contacts.`) };
  if (isTrashed(r.payload)) return { ok: false, result: refused(`"${r.title}" is deleted. restore_record brings it back.`) };
  return { ok: true, id: r.record_id, record: r };
}

/** The groups a contact is a member of, by name, or why they cannot be read. */
async function groupsOf(ctx: Parameters<typeof data>[0], record: string): Promise<{ ok: true; items: { record_id: string; name: string }[] } | { ok: false; result: Result }> {
  const found = await data(ctx, "fabrik_linked", { p_record: record, p_relations: ["member_of"], p_direction: "out" });
  if (!found.ok) return found;
  // deno-lint-ignore no-explicit-any
  return { ok: true, items: (found.data as any[]).map((g) => ({ record_id: g.record_id, name: g.title })) };
}

/** What a linked record says of itself: its summary, its description or its question. */
const sayingOf = (payload: Item): string => String(payload?.summary ?? payload?.description ?? payload?.question ?? "");

const contactCreate = tool({
  name: "contact_create",
  description: "Save a contact in fabrik, as the signed-in person: a person, or an organization, someone the person deals with. " +
    "It is an evidence record of type Person (or Organization) titled with the name, its details in its properties: givenName, familyName, name, email, telephone, telegramUserId, jobTitle, source and status. " +
    "Any one identifying detail is enough: a name, an email, a telephone or a Telegram user id. " +
    "A contact that already has the email (in any case), telephone (by its digits) or Telegram user id given is not made again: that contact is answered, with created false and nothing saved. A deleted contact does not count. " +
    "To link a contact to a note or a group, use remember with links, link_records, or group_manage. " +
    "Answers created (true or false) and contact: record_id, name, type, scope_id, saved_at and properties.",
  input: z.object({
    givenName: z.string().trim().min(1).max(200).optional().describe("First name."),
    familyName: z.string().trim().min(1).max(200).optional().describe("Last name."),
    name: z.string().trim().min(1).max(500).optional().describe("The whole name, for an organization or a person known by one name. The title is this, or the given and family names together."),
    type: z.enum([PERSON, ORGANIZATION]).optional().describe("Person when left out."),
    email: z.string().trim().email().max(320).optional().describe("Email address. A second contact with the same one is not made."),
    telephone: z.string().trim().min(1).max(30).optional().describe("Telephone number. A second contact with the same one is not made."),
    telegramUserId: z.number().int().optional().describe("Numeric Telegram user id. A second contact with the same one is not made."),
    jobTitle: z.string().trim().min(1).max(200).optional().describe("Job title."),
    source: z.string().trim().min(1).max(500).optional().describe("Where this contact came from, such as a website or a meeting."),
    status: z.string().trim().min(1).max(100).optional().describe("Status, such as active, prospect, booked or archived."),
    scope: z.string().min(1).optional().describe("The scope to save in, by its scope_id, code or name, from list_scopes. General when left out."),
    reason: reasonFor("contact_create"),
  }),
  run: async (ctx, a) => {
    const properties: Record<string, unknown> = {};
    for (const k of DETAILS) if (a[k] !== undefined) properties[k] = a[k];
    const title = titleOf(properties);
    if (!title) return refused("Give at least one of a name, an email, a telephone or a Telegram user id. Nothing was saved.");
    const type = a.type ?? PERSON;
    for (const key of ["email", "telephone", "telegramUserId"] as const) {
      if (properties[key] === undefined) continue;
      const same = await findBy(ctx, { [key]: properties[key] }, null, 1);
      if (!same.ok) return same.result;
      if (same.items.length) return answer({ created: false, contact: shown(same.items[0]) });
    }
    const saved = await data(ctx, "fabrik_add_record", {
      p_scope: a.scope ?? GENERAL, p_kind: "evidence", p_title: title, p_reason: reasonOf(a.reason, "contact_create"),
      p_fields: newFields("evidence", type, summaryOf(title, type), properties),
    });
    return saved.ok ? answer({ created: true, contact: { record_id: saved.data.record_id, name: title, type, scope_id: saved.data.scope_id, saved_at: saved.data.recorded_at, properties } }) : saved.result;
  },
});

const contactLookup = tool({
  name: "contact_lookup",
  description: "Find contacts saved in fabrik that the signed-in person may read, by email, telephone, Telegram user id or name. " +
    "Each detail given must match: email in any case, telephone by its digits and leading +, telegramUserId exactly, name when every word of it is in the contact's name, in any case. " +
    "Give at least one. Deleted contacts are left out. " +
    "Answers items, newest save first, each with record_id, name, type, scope_id, saved_at, properties and groups (the groups it is in, each with record_id and name), and more, true when there are more than limit. " +
    "contact_export gives everything linked to one contact.",
  input: z.object({
    email: z.string().trim().min(1).optional().describe("Email address, in any case."),
    telephone: z.string().trim().min(1).optional().describe("Telephone number: its digits and leading + are compared, so spaces, brackets and dashes do not matter."),
    telegramUserId: z.number().int().optional().describe("Exact numeric Telegram user id."),
    name: z.string().trim().min(1).optional().describe("A name or part of one: each word must be in the contact's name."),
    limit: z.number().int().min(1).max(100).optional().describe("The most to give, 10 when left out."),
  }),
  run: async (ctx, a) => {
    if (a.email === undefined && a.telephone === undefined && a.telegramUserId === undefined && a.name === undefined) {
      return refused("Give an email, a telephone, a Telegram user id or a name. contact_list lists contacts without one.");
    }
    const match: Record<string, unknown> = {};
    for (const k of ["email", "telephone", "telegramUserId"] as const) if (a[k] !== undefined) match[k] = a[k];
    const found = await findBy(ctx, match, a.name ?? null, a.limit ?? 10);
    if (!found.ok) return found.result;
    const groups = await Promise.all(found.items.map((x) => groupsOf(ctx, x.record_id)));
    const items = [];
    for (const [i, x] of found.items.entries()) {
      const g = groups[i];
      if (!g.ok) return g.result;
      items.push({ ...shown(x), groups: g.items });
    }
    return answer({ items, more: found.more });
  },
});

const contactUpdate = tool({
  name: "contact_update",
  description: "Change a contact saved in fabrik, as a new version, as the signed-in person. " +
    "The details given are merged into the contact's properties: a detail given a value is set, one given null is removed, one not given is kept. " +
    "The title follows the name when name, givenName or familyName changes, or when the title was made from the details: it is name, else the given and family names, else the email or telephone. A title given otherwise, such as by an import, is kept. " +
    "An email, telephone or Telegram user id another contact already has is refused. Earlier versions stay in the contact's history. " +
    "Answers the saved version: record_id, version_id, title and payload.",
  input: z.object({
    contact: z.string().min(1).describe(CONTACT),
    givenName: z.string().trim().min(1).max(200).nullable().optional().describe("First name; null removes it."),
    familyName: z.string().trim().min(1).max(200).nullable().optional().describe("Last name; null removes it."),
    name: z.string().trim().min(1).max(500).nullable().optional().describe("The whole name; null removes it."),
    email: z.string().trim().email().max(320).nullable().optional().describe("Email address; null removes it."),
    telephone: z.string().trim().min(1).max(30).nullable().optional().describe("Telephone number; null removes it."),
    telegramUserId: z.number().int().nullable().optional().describe("Numeric Telegram user id; null removes it."),
    jobTitle: z.string().trim().min(1).max(200).nullable().optional().describe("Job title; null removes it."),
    source: z.string().trim().min(1).max(500).nullable().optional().describe("Where the contact came from; null removes it."),
    status: z.string().trim().min(1).max(100).nullable().optional().describe("Status, such as active, prospect, booked or archived; null removes it."),
    properties: z.record(z.string(), z.unknown()).optional().describe("Any other details to keep, merged in the same way."),
    reason: reasonFor("contact_update"),
  }),
  run: async (ctx, a) => {
    const one = await contactOf(ctx, a.contact);
    if (!one.ok) return one.result;
    const changes: Record<string, unknown> = { ...(a.properties ?? {}) };
    for (const k of DETAILS) if (a[k] !== undefined) changes[k] = a[k];
    if (Object.keys(changes).length === 0) return refused("Nothing to change: give a detail to set, or null to remove one.");
    for (const key of ["email", "telephone", "telegramUserId"]) {
      if (changes[key] == null) continue;
      const same = await findBy(ctx, { [key]: changes[key] }, null, 5);
      if (!same.ok) return same.result;
      const other = same.items.find((x) => x.record_id !== one.id);
      if (other) return refused(`${other.title} (id ${other.record_id}) already has the ${key} ${changes[key]}. Nothing was changed.`);
    }
    const merged = { ...(one.record.payload?.properties ?? {}), ...changes };
    for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
    if (!titleOf(merged)) return refused("A contact keeps at least one of a name, an email, a telephone or a Telegram user id. Nothing was changed.");
    // The title follows the details only when a name changes, or when it was made from them: a title the person or an
    // import gave otherwise is kept.
    const naming = ["name", "givenName", "familyName"].some((k) => k in changes);
    const title = naming || one.record.title === titleOf(one.record.payload?.properties ?? {}) ? titleOf(merged) : one.record.title;
    // The summary the tool wrote follows a new name; one the person has written since is kept.
    const type = String(one.record.payload?.type);
    const renamed = title !== one.record.title && one.record.payload?.summary === summaryOf(one.record.title, type);
    const saved = await data(ctx, "fabrik_change_properties", {
      p_record: one.id, p_reason: reasonOf(a.reason, "contact_update"), p_properties: changes, p_title: title,
      p_fields: renamed ? { summary: summaryOf(title, type) } : {},
    });
    return saved.ok ? answer(saved.data) : saved.result;
  },
});

const contactList = tool({
  name: "contact_list",
  description: "List the contacts saved in fabrik that the signed-in person may read, leaving out deleted ones. " +
    "Each filter given must match: words, which must all be in the contact's name in any case, status and source exactly, and group, a group's name or record_id, to list only its members. " +
    "Answers items, newest save first, each with record_id, name, type, saved_at and properties (and scope_id, except for a group's members), and more, true when there are more than limit. " +
    "contact_lookup finds a contact by email or telephone; contact_export gives everything linked to one.",
  input: z.object({
    words: z.string().trim().min(1).optional().describe("Words in the contact's name."),
    group: z.string().min(1).optional().describe("A group's name or record_id, from group_create; only its members are listed."),
    status: z.string().trim().min(1).optional().describe("Exact status, such as prospect."),
    source: z.string().trim().min(1).optional().describe("Exact source."),
    limit: z.number().int().min(1).max(200).optional().describe("The most to list, 50 when left out."),
  }),
  run: async (ctx, a) => {
    const limit = a.limit ?? 50;
    const match: Record<string, unknown> = {};
    if (a.status !== undefined) match.status = a.status;
    if (a.source !== undefined) match.source = a.source;
    if (a.group === undefined) {
      const found = await find(ctx, match, a.words ?? null, limit);
      return found.ok ? answer({ items: found.items.map(shown), more: found.more }) : found.result;
    }
    const group = await named(ctx, a.group, GROUP);
    if (!group.ok) return group.result;
    const shownGroup = await data(ctx, "fabrik_show_record", { p_record: group.id });
    if (!shownGroup.ok) return shownGroup.result;
    if (shownGroup.data.payload?.type !== GROUP) return refused(`"${shownGroup.data.title}" is not a group.`);
    if (isTrashed(shownGroup.data.payload)) return refused(`"${shownGroup.data.title}" is deleted. restore_record brings it back.`);
    const members = await data(ctx, "fabrik_linked", { p_record: group.id, p_relations: ["member_of"], p_direction: "in" });
    if (!members.ok) return members.result;
    const words = (a.words ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    // deno-lint-ignore no-explicit-any
    const rows = (members.data as any[]).filter((m) => CONTACT_TYPES.includes(m.type)
      && words.every((w) => String(m.title ?? "").toLowerCase().includes(w))
      && Object.entries(match).every(([k, val]) => m.payload?.properties?.[k] === val));
    return answer({ items: rows.slice(0, limit).map((m) => shown(m)), more: rows.length > limit });
  },
});

const contactDelete = tool({
  name: "contact_delete",
  description: "Delete a contact saved in fabrik, as the signed-in person, so that lookups and lists leave it out. " +
    "It is saved as a new version marked deleted, with the time and the reason, its links and history kept, and restore_record brings it back. " +
    "A new contact may then be made with the same email, telephone or name. A record that is not a contact, or one already deleted, is refused. Answers the saved version.",
  input: z.object({
    contact: z.string().min(1).describe(CONTACT),
    reason: reasonFor("contact_delete"),
  }),
  run: async (ctx, a) => {
    const one = await contactOf(ctx, a.contact);
    if (!one.ok) return one.result;
    return await setTrashed(ctx, one.id, true, reasonOf(a.reason, "contact_delete"));
  },
});

const contactExport = tool({
  name: "contact_export",
  description: "Everything fabrik holds on one contact that the signed-in person may read, to hand over or to review: the contact itself, the groups it belongs to, " +
    "the records that mention it (a note saved with remember linking mentions to it, for one), and the records it authored. Deleted records are left out. " +
    "Answers contact (record_id, name, type, scope_id, saved_at, properties), groups (record_id, name), mentioned_in and authored, each item with record_id, title, kind, type, summary " +
    "(the record's summary, description or question), relation and note, and counts. " +
    "Mail and files are not in fabrik's records, so they are not here: not_included says so.",
  input: z.object({ contact: z.string().min(1).describe(CONTACT) }),
  run: async (ctx, a) => {
    const one = await contactOf(ctx, a.contact);
    if (!one.ok) return one.result;
    const rows = async (relation: string, direction: "in" | "out") => {
      const found = await data(ctx, "fabrik_linked", { p_record: one.id, p_relations: [relation], p_direction: direction });
      if (!found.ok) return found;
      return { ok: true as const, items: (found.data as Item[]).map((x) => ({
        record_id: x.record_id, title: x.title, kind: x.kind, type: x.type ?? null, summary: sayingOf(x.payload), relation: x.relation, note: x.note ?? null })) };
    };
    const found = await groupsOf(ctx, one.id);
    if (!found.ok) return found.result;
    const groups = found.items;
    const mentioned = await rows("mentions", "in");
    if (!mentioned.ok) return mentioned.result;
    const authored = await rows("authored", "out");
    if (!authored.ok) return authored.result;
    return answer({
      contact: shown(one.record), groups, mentioned_in: mentioned.items, authored: authored.items,
      counts: { groups: groups.length, mentioned_in: mentioned.items.length, authored: authored.items.length },
      not_included: ["Mail and files are not in fabrik's records, so this export does not reach them."],
    });
  },
});

const groupCreate = tool({
  name: "group_create",
  description: "Make a group of contacts in fabrik, as the signed-in person, such as a viewing party or a board. " +
    "It is a model record of type Group; each member is a contact with a member_of link to it. " +
    "A group whose name another group not deleted has is refused. Members named here are added at once; group_manage adds and removes them later. " +
    "Answers the saved group: record_id, version_id, title and payload, with members (each record_id and name).",
  input: z.object({
    name: z.string().trim().min(1).max(500).describe("The group's name, which is its title, such as Property viewing, 42 Oak Street."),
    description: z.string().trim().min(1).max(4000).optional().describe("What the group is for, in plain words."),
    members: z.array(z.string().min(1)).max(100).optional().describe("Contacts to start with, each named as contact_lookup names one: record_id, name, email or telephone."),
    scope: z.string().min(1).optional().describe("The scope to save in, by its scope_id, code or name, from list_scopes. General when left out."),
    reason: reasonFor("group_create"),
  }),
  run: async (ctx, a) => {
    const reason = reasonOf(a.reason, "group_create");
    const same = await data(ctx, "fabrik_find_by_name", { p_name: a.name, p_type: GROUP });
    if (!same.ok) return same.result;
    if ((same.data as unknown[]).length) return refused(`A group named "${a.name}" already exists. group_manage adds members to it. Nothing was saved.`);
    // Every member is found before the group is made, so a name that is wrong leaves nothing half done.
    const ids: { record_id: string; name: string }[] = [];
    for (const m of a.members ?? []) {
      const one = await contactOf(ctx, m);
      if (!one.ok) return refused(`${(one.result.content[0] as { text: string }).text} Nothing was saved.`);
      if (!ids.some((x) => x.record_id === one.id)) ids.push({ record_id: one.id, name: one.record.title });
    }
    const saved = await data(ctx, "fabrik_add_record", {
      p_scope: a.scope ?? GENERAL, p_kind: "model", p_title: a.name, p_reason: reason,
      p_fields: newFields("model", GROUP, a.description ?? `${a.name}, a group of contacts.`),
    });
    if (!saved.ok) return saved.result;
    for (const m of ids) {
      const linked = await data(ctx, "fabrik_link_many", { p_record: m.record_id, p_links: [{ target: saved.data.record_id, relation: "member_of" }], p_reason: reason });
      if (!linked.ok) return refused(`The group "${a.name}" was made (id ${saved.data.record_id}), but ${m.name} could not be added: ${(linked.result.content[0] as { text: string }).text}`);
    }
    return answer({ ...saved.data, members: ids });
  },
});

const groupManage = tool({
  name: "group_manage",
  description: "Add a contact to a group, or remove one, in fabrik, as the signed-in person. " +
    "A member is a contact with a member_of link to the group record; adding saves a new version of the contact, removing saves another without the link. " +
    "Adding a contact already in the group, or removing one that is not, is refused. " +
    "Answers the saved version of the contact (record_id, version_id, title and payload). " +
    "group_create makes a group; contact_list with group lists its members.",
  input: z.object({
    group: z.string().min(1).describe("The group, by its record_id or its exact name in any case, among groups not deleted."),
    action: z.enum(["add", "remove"]).describe("add a contact, or remove one."),
    contact: z.string().min(1).optional().describe("The contact, named as contact_lookup names one (record_id, name, email or telephone)."),
    reason: reasonFor("group_manage"),
  }),
  run: async (ctx, a) => {
    const group = await named(ctx, a.group, GROUP);
    if (!group.ok) return group.result;
    const shownGroup = await data(ctx, "fabrik_show_record", { p_record: group.id });
    if (!shownGroup.ok) return shownGroup.result;
    if (shownGroup.data.payload?.type !== GROUP) return refused(`"${shownGroup.data.title}" is not a group.`);
    if (isTrashed(shownGroup.data.payload)) return refused(`"${shownGroup.data.title}" is deleted. restore_record brings it back.`);
    const groupName = shownGroup.data.title;
    const members = await data(ctx, "fabrik_linked", { p_record: group.id, p_relations: ["member_of"], p_direction: "in" });
    if (!members.ok) return members.result;
    // deno-lint-ignore no-explicit-any
    const current = (members.data as any[]).map((m) => ({ record_id: m.record_id }));
    if (a.contact === undefined) return refused(`action ${a.action} needs contact, named by record_id, name, email or telephone.`);
    const one = await contactOf(ctx, a.contact);
    if (!one.ok) return one.result;
    const isMember = current.some((m) => m.record_id === one.id);
    const reason = reasonOf(a.reason, "group_manage");
    if (a.action === "add") {
      if (isMember) return refused(`${one.record.title} is already in "${groupName}".`);
      const linked = await data(ctx, "fabrik_link_many", { p_record: one.id, p_links: [{ target: group.id, relation: "member_of" }], p_reason: reason });
      return linked.ok ? answer(linked.data) : linked.result;
    }
    if (!isMember) return refused(`${one.record.title} is not in "${groupName}".`);
    const unlinked = await data(ctx, "fabrik_unlink", { p_record: one.id, p_target: group.id, p_relation: "member_of", p_reason: reason });
    return unlinked.ok ? answer(unlinked.data) : unlinked.result;
  },
});

/** The contact tools, in the order Claude lists them. */
export const CONTACT_TOOLS: Tool[] = [contactCreate, contactLookup, contactUpdate, contactList, contactDelete, contactExport, groupCreate, groupManage];
