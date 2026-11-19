// What the tools ported from maxy-code's plugins share: the scope a save goes to when none is named, a new record's
// fields as fabrik needs them for its kind, with the maxy-code type in payload.type and the rest in payload.properties,
// the soft delete and its restore, and the upload that upload_file, ingest_document and mail_save_attachment run.
// A trashed record is one whose latest payload holds properties.trashed_at; fabrik's lookups leave it out.
import { decodeBase64 } from "jsr:@std/encoding@1.0.10/base64";
import { answer, type Ctx, refused, type Result, scopeOf } from "./tool.ts";

/** The scope a ported tool saves to when none is named: the one with the code general. */
export const GENERAL = "general";

/** The reason a save keeps when the person gives none: the tool that made it. */
export const reasonOf = (given: string | undefined, toolName: string) => given?.trim() ? given : `Saved with ${toolName}`;

type Kind = "activity" | "decision" | "evidence" | "model";

/** A new record's fields: the kind's own fields filled as fabrik needs them, text in the kind's main field, the type
 * in payload.type and anything else in payload.properties. fields given here win over the filled ones. */
export function newFields(kind: Kind, type: string, text: string, properties: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) {
  const filled: Record<string, unknown> =
    kind === "evidence" ? { summary: text, source_reference: null, source_date: null, standing: "stated", limitations: "" }
    : kind === "model" ? { model_kind: "observed_current", source_version: "fabrik connector", source_status: "saved", description: text,
      graph: { format_version: 1, nodes: [], edges: [] } }
    : kind === "activity" ? { description: text }
    : { question: text };
  return { ...filled, ...fields, type, properties };
}

/** One fabrik database function's answer as data, or its refusal as the tool's error. */
// deno-lint-ignore no-explicit-any
export async function data(ctx: Ctx, fn: string, args: Record<string, unknown> = {}): Promise<{ ok: true; data: any } | { ok: false; result: Result }> {
  const { data, error } = await ctx.fabrik.rpc(fn, args);
  if (error) return { ok: false, result: refused(error.message) };
  if (data && typeof data === "object" && data.refused === true) return { ok: false, result: refused(String(data.problem ?? "fabrik refused the change.")) };
  return { ok: true, data };
}

/** A record_id, as fabrik gives one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The record a name or id points to, among records of a type, or of any type when none is given, by the rule fabrik's
 * own lookup names a record by: an id passes through; a title names the one record not deleted (trashed) that has it,
 * or, when none not deleted has it, the one deleted record that has it. With deletedFirst, as restore_record wants, the
 * two are taken the other way round: the one deleted record first. Answers the record_id, or the refusal in plain
 * words: none has the title, or more than one could be meant, each named as fabrik names it, a deleted one marked. */
export async function named(ctx: Ctx, record: string, type?: string, deletedFirst = false): Promise<{ ok: true; id: string } | { ok: false; result: Result }> {
  const given = record.trim();
  if (UUID.test(given)) return { ok: true, id: given };
  const found = await data(ctx, "fabrik_find_by_name", { p_name: given, p_type: type ?? null, p_trashed: true });
  if (!found.ok) return found;
  // deno-lint-ignore no-explicit-any
  const hits: any[] = found.data ?? [];
  if (hits.length === 0) return { ok: false, result: refused(`Record unavailable: no ${type ?? "record"} you can read has the title "${given}"`) };
  const live = hits.filter((x) => x.deleted !== true), gone = hits.filter((x) => x.deleted === true);
  const [first, second] = deletedFirst ? [gone, live] : [live, gone];
  const one = first.length === 1 ? first[0] : first.length === 0 && second.length === 1 ? second[0] : null;
  if (one) return { ok: true, id: one.record_id };
  return { ok: false, result: refused(`More than one ${type ?? "record"} has the title "${given}": ` +
    hits.map((x) => `${x.title} (scope ${x.scope_id}, saved ${x.saved_at}${x.deleted ? ", deleted" : ""}, id ${x.record_id})`).join("; ")) };
}

/** The record a link is saved to or from, named by its id or title as fabrik names it, read at its latest version; a
 * deleted one is refused, since a link to it would not show. Answers the record_id and the record, or the refusal. */
// deno-lint-ignore no-explicit-any
export async function linkable(ctx: Ctx, record: string): Promise<{ ok: true; id: string; record: any } | { ok: false; result: Result }> {
  const shown = await data(ctx, "fabrik_show_record", { p_record: record });
  if (!shown.ok) return shown;
  if (isTrashed(shown.data.payload)) {
    return { ok: false, result: refused(`"${shown.data.title}" is deleted, so it cannot be linked. restore_record brings it back first.`) };
  }
  return { ok: true, id: shown.data.record_id, record: shown.data };
}

/** Whether a record's payload marks it trashed. */
// deno-lint-ignore no-explicit-any
export const isTrashed = (payload: any) => payload?.properties?.trashed_at != null;

/** Trashes a record, or brings it back, as a new version through fabrik_change_properties. Refuses to trash a record
 * already trashed, or to restore one that is not, naming it. A title names the record as named() does; to restore,
 * the deleted record with the title is taken first, even when one not deleted has it too. A restore that leaves two
 * records not deleted with one title says so, naming the other, since the title alone then names neither. */
export async function setTrashed(ctx: Ctx, record: string, trash: boolean, reason: string): Promise<Result> {
  const id = await named(ctx, record, undefined, !trash);
  if (!id.ok) return id.result;
  const shown = await data(ctx, "fabrik_show_record", { p_record: id.id });
  if (!shown.ok) return shown.result;
  const title = shown.data.title;
  if (trash && isTrashed(shown.data.payload)) return refused(`"${title}" is already deleted. restore_record brings it back.`);
  if (!trash && !isTrashed(shown.data.payload)) return refused(`"${title}" is not deleted, so there is nothing to restore.`);
  const properties = trash ? { trashed_at: new Date().toISOString(), trashed_reason: reason } : { trashed_at: null, trashed_reason: null };
  // Read, then written: a change saved by someone else between the two is not seen here, and fabrik saves on top of it.
  const saved = await data(ctx, "fabrik_change_properties", { p_record: shown.data.record_id, p_reason: reason, p_properties: properties });
  if (!saved.ok) return saved.result;
  if (trash) return answer(saved.data);
  const same = await data(ctx, "fabrik_find_by_name", { p_name: title, p_type: null, p_trashed: false });
  if (!same.ok) return same.result;
  // deno-lint-ignore no-explicit-any
  const others = (same.data as any[]).filter((x) => x.record_id !== shown.data.record_id);
  if (!others.length) return answer(saved.data);
  return answer({ ...saved.data, same_title: others.map(({ record_id, type, scope_id, saved_at }) => ({ record_id, type, scope_id, saved_at })),
    note: `"${title}" is back, and ${others.length === 1 ? "another record" : `${others.length} other records`} not deleted ` +
      `${others.length === 1 ? "has" : "have"} the same title, so the title alone now names neither: name each by its record_id, ` +
      "or give one a new title with update_record." });
}

/** The caller's own record of a type in General: one whose first version fabrik saved for the person the caller answers
 * to, so that each person has their own, such as their UserProfile. fabrik keeps who a version was saved for, and no
 * payload can set it. Answers General's scope and the record, newest save first, or null when there is none yet; or
 * why it cannot be read. */
export async function ownRecord(ctx: Ctx, type: string): Promise<{ scope: { scope_id: string; code: string; name: string };
  // deno-lint-ignore no-explicit-any
  record: any } | Result> {
  const scope = await scopeOf(ctx, GENERAL);
  if (typeof scope === "string") return refused(scope);
  const found = await data(ctx, "fabrik_find_typed", { p_type: type, p_match: {}, p_words: null, p_trashed: false, p_limit: 50, p_own: true });
  if (!found.ok) return found.result;
  // deno-lint-ignore no-explicit-any
  return { scope, record: (found.data.items as any[]).find((x) => x.scope_id === scope.scope_id) ?? null };
}

/** Whether someone else saved a person's own record last: fabrik first saved it for the person, but its latest version
 * for someone else (latest_own, from fabrik_find_typed, which no payload can set). What such a record holds may not be
 * the person's, so it is not used. */
// deno-lint-ignore no-explicit-any
export const changedByOther = (record: any) => record != null && record.latest_own !== true;

/** The properties a save over a person's own record sets: props alone. Over one someone else saved last, every property
 * it holds that props does not set is removed, so nothing they wrote stays in it once the person saves it again. */
// deno-lint-ignore no-explicit-any
export function ownProperties(record: any, props: Record<string, unknown>): Record<string, unknown> {
  if (!changedByOther(record)) return props;
  return { ...Object.fromEntries(Object.keys(record.payload?.properties ?? {}).map((k) => [k, null])), ...props };
}

// ---- Files ----

/** The most bytes upload_file takes, as the fabrik command's upload_file. */
export const UPLOAD_LIMIT = 6 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".csv": "text/csv", ".json": "application/json", ".txt": "text/plain", ".md": "text/markdown", ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
/** A path inside a bucket, each part encoded, or null for one that is empty, absolute or climbs out. */
export function objectPath(path: string): string | null {
  if (path.length > 1024 || path.startsWith("/")) return null;
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.map(encodeURIComponent).join("/");
}

/** What a file upload is given. */
export type Upload = { scope: string; path: string; content: string; encoding?: "text" | "base64"; content_type?: string; overwrite?: boolean };

/** The refusal of a path objectPath does not take. */
export const notAPath = (path: string) =>
  `Not a path inside a scope: ${path}. Give a path such as notes.md or reports/q3.pdf, with no leading /, and no . or .. parts.`;

/** Uploads one file into a scope's bucket, as the person: answers { scope, scope_name, path, size, content_type }, or
 * the refusal in plain words. */
export async function uploadFile(ctx: Ctx, a: Upload): Promise<Result> {
  if (!objectPath(a.path)) return refused(notAPath(a.path));
  let bytes: Uint8Array<ArrayBuffer>;
  if (a.encoding === "base64") {
    // std's decoder fills the bytes in one pass: atob and a per-character copy took 25 times as long on 6 MB.
    try { bytes = decodeBase64(a.content.replace(/\s+/g, "")) as Uint8Array<ArrayBuffer>; }
    catch { return refused("The content is not valid base64."); }
  } else bytes = new TextEncoder().encode(a.content);
  if (bytes.length > UPLOAD_LIMIT) return refused(`The file is ${bytes.length} bytes, over the ${UPLOAD_LIMIT}-byte limit.`);
  const found = await scopeOf(ctx, a.scope);
  if (typeof found === "string") return refused(found);
  const ext = /\.[^./]+$/.exec(a.path)?.[0].toLowerCase() ?? "";
  return await putFile(ctx, found, a.path, bytes, a.content_type ?? CONTENT_TYPES[ext] ?? "application/octet-stream", a.overwrite);
}

/** Puts bytes at a path in a scope's bucket, as the person, so Storage's rules decide whether they may: answers
 * { scope, scope_name, path, size, content_type }, or the refusal in plain words. A file already at the path is kept,
 * and the upload refused, unless overwrite is true. */
export async function putFile(ctx: Ctx, scope: { code: string; name: string }, path: string, bytes: Uint8Array<ArrayBuffer>, type: string,
  overwrite = false): Promise<Result> {
  const encoded = objectPath(path);
  if (!encoded) return refused(notAPath(path));
  const res = await ctx.project(`/storage/v1/object/${scope.code}/${encoded}`, {
    method: "POST", headers: { "Content-Type": type, "x-upsert": overwrite ? "true" : "false" }, body: bytes,
  });
  // deno-lint-ignore no-explicit-any
  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    const said = String(body?.message ?? body?.error ?? `Storage answered ${res.status}`);
    if (/already exists/i.test(said)) return refused(`${said}: ${path} is already in ${scope.name}. Pass overwrite true to replace it.`);
    return refused(`Storage refused the upload to ${scope.name}: ${said}`);
  }
  return answer({ scope: scope.code, scope_name: scope.name, path, size: bytes.length, content_type: type });
}
