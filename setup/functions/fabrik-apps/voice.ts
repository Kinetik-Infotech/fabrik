// The voice tools, ported from maxy-code's voice-mirror plugin onto fabrik's records: voice_tag_content,
// voice_distil_profile, voice_get_conditioning and voice_record_feedback. A piece of the person's own writing is a
// record of a writing type whose properties hold maxy-code's authorshipMode, authorshipTaggedAt and format. The person's
// voice is their one VoiceProfile model record in General, found as ownRecord finds it: its properties hold styleCard,
// generatedAt, corpusSize, feedbackEntries, and feedback, the person's corrections to drafts, newest first.
// The connector calls no model: as in maxy-code since its Task 424, the agent reads the samples and writes the style card
// itself, and voice_distil_profile saves what it wrote. A person's samples are the records fabrik saved for them first,
// so one person's writing, profile and corrections never reach another person's tools.
import { z } from "npm:zod@4.3.6";
import { answer, type Ctx, refused, type Result, type Tool, tool } from "./tool.ts";
import { changedByOther, data, GENERAL, isTrashed, named, newFields, ownProperties, ownRecord, reasonOf } from "./ported.ts";

const TYPE = "VoiceProfile";
/** The record types that hold writing: the ported tools' Note and Document, and the types the maxy import saves
 * maxy-code's writing as. */
const WRITING = ["Note", "Document", "KnowledgeDocument", "Message", "SocialPost", "Section"];
/** maxy-code's formats, the broad two first. */
const FORMATS = ["formal", "informal", "text", "email", "social-post", "article", "marketing-copy", "note"] as const;
/** maxy-code's authorship modes, and the two whose writing carries the person's voice. */
const MODES = ["human-only", "human-led-agent-assisted", "agent-led-human-reviewed", "agent-only", "unknown"] as const;
const VOICED = ["human-only", "human-led-agent-assisted"];
/** The most tagged records of one type and mode that one corpus lookup reads, the newest. The stand-in's check of the
 * corpus lookup imports it, so its fixture always matches it. */
export const CORPUS_LIMIT = 100;
/** The longest pasted text voice_tag_content saves: an evidence record's summary, as fabrik limits it. */
const TEXT_LIMIT = 4000;
/** How much sample text voice_distil_profile gives, as maxy-code's sample cap. */
const SAMPLE_CHARS = 120_000;
/** The samples voice_get_conditioning gives, and their text, for short and long writing, as maxy-code's K and token budget at
 * 4 characters a token. */
const CONDITIONING = { short: { k: 5, chars: 64_000 }, long: { k: 15, chars: 384_000 } };
/** The corrections a profile keeps, newest first, as the 50 maxy-code's distil read; and each one's texts at most this long. */
const FEEDBACK_KEPT = 50;
const FEEDBACK_TEXT = 2000;

const reasonFor = (name: string) => z.string().min(1).optional().describe(`Why this is saved, in the person's words. It is kept with the version. "Saved with ${name}" when left out.`);
const format = z.enum(FORMATS);

type Sample = { record_id: string; title: string; type: string; format: string | null; authorshipMode: string; saved_at: string; text: string };
type Feedback = { intent: string; format: string | null; originalText: string; editedText: string; occurredAt: string; skill?: string; brief?: string };

// deno-lint-ignore no-explicit-any
const textOf = (payload: any): string => String(payload?.properties?.body ?? payload?.summary ?? payload?.description ?? "").trim();
// deno-lint-ignore no-explicit-any
const feedbackOf = (profile: any): Feedback[] => Array.isArray(profile?.payload?.properties?.feedback) ? profile.payload.properties.feedback : [];

/** What a profile someone else saved last gives in place of its card and corrections. */
const FOREIGN = "Your VoiceProfile was last changed by someone else, so its style card and corrections are left out. " +
  "voice_distil_profile saves a new card as yours, and voice_record_feedback starts the corrections again.";
/** The person's profile as they last saved it: its card and corrections are used only when fabrik saved its latest
 * version for them (latest_own, which no payload can set), so text someone else wrote into it never becomes their
 * instruction. foreign is true for a profile someone else changed last. */
// deno-lint-ignore no-explicit-any
const trusted = (record: any) => ({ record, foreign: changedByOther(record),
  // deno-lint-ignore no-explicit-any
  props: (record && !changedByOther(record) ? record.payload?.properties ?? {} : {}) as Record<string, any> });

/** The person's own writing: records of a writing type that fabrik first saved for them, tagged human-only or
 * human-led-agent-assisted, of the format when one is given, not deleted, newest save first, with text. */
async function corpus(ctx: Ctx, only?: string): Promise<{ samples: Sample[]; capped: boolean } | Result> {
  // One call for each type and voiced mode, so the database picks out the tagged records: the person's untagged writing,
  // however much there is, never pushes a tagged piece past the limit.
  const found = await Promise.all(WRITING.flatMap((type) => VOICED.map((mode) => data(ctx, "fabrik_find_typed", {
    p_type: type, p_match: { properties: { authorshipMode: mode, ...(only ? { format: only } : {}) } }, p_words: null,
    p_trashed: false, p_limit: CORPUS_LIMIT, p_own: true,
  }))));
  const out: Sample[] = [];
  let capped = false;
  for (const f of found) {
    if (!f.ok) return f.result;
    capped ||= f.data.more === true;
    for (const x of f.data.items) {
      const text = textOf(x.payload);
      // A piece someone else changed last is not the person's writing any more.
      if (!text || x.latest_own !== true) continue;
      out.push({ record_id: x.record_id, title: x.title, type: x.payload.type, format: x.payload.properties?.format ?? null,
        authorshipMode: x.payload.properties.authorshipMode, saved_at: x.saved_at, text });
    }
  }
  return { samples: out.sort((a, b) => b.saved_at.localeCompare(a.saved_at)), capped };
}

/** Samples within a number of characters, each cut to what is left. */
function within(samples: Sample[], chars: number, most = Infinity): Sample[] {
  const out: Sample[] = [];
  let left = chars;
  for (const s of samples) {
    if (left <= 0 || out.length >= most) break;
    const text = s.text.slice(0, left);
    out.push({ ...s, text });
    left -= text.length;
  }
  return out;
}

/** Who a record is the caller's by: "own" when fabrik saved its first and its latest version for them, "changed" when
 * the first only, "other" when not the first. It is looked for among the caller's own records of its type. */
// deno-lint-ignore no-explicit-any
async function ownership(ctx: Ctx, shown: any): Promise<"own" | "changed" | "other" | Result> {
  const found = await data(ctx, "fabrik_find_typed", { p_type: shown.payload.type, p_match: {}, p_words: null, p_trashed: false, p_limit: 1, p_own: true, p_records: [shown.record_id] });
  if (!found.ok) return found.result;
  // deno-lint-ignore no-explicit-any
  const hit = (found.data.items as any[]).find((x) => x.record_id === shown.record_id);
  return !hit ? "other" : hit.latest_own === true ? "own" : "changed";
}

const voiceTagContent = tool({
  name: "voice_tag_content",
  description: "Mark writing as the signed-in person's own, so that voice_distil_profile learns their voice from it. " +
    "records names records already saved, each by its record_id or exact title; text saves pasted writing of theirs as a new Note in fabrik, titled title. " +
    "Each is tagged with format and mode, kept in its properties as authorshipMode, authorshipTaggedAt and format. " +
    `Only writing counts: a record of type ${WRITING.join(", ")}, not deleted, with text, that fabrik saved for this person first and last. Any other record is skipped, with the reason. ` +
    "format is chosen by the person: formal for considered writing for someone else to read, informal for conversational writing; " +
    "text, email, social-post, article, marketing-copy or note only when they place it there. " +
    "mode is human-only (their own words, the default) or human-led-agent-assisted (theirs, lightly polished); agent-led-human-reviewed, agent-only and unknown are kept but never learned from. " +
    "Answers tagged, each record tagged with record_id, title and type, and skipped, each record not tagged with the reason. Call voice_distil_profile next.",
  input: z.object({
    records: z.array(z.string().min(1)).min(1).max(50).optional().describe("Records of the person's writing, each by record_id or exact title in any case."),
    text: z.string().min(1).max(TEXT_LIMIT).optional().describe(`Writing of the person's own, pasted, up to ${TEXT_LIMIT} characters, to save as a new Note.`),
    title: z.string().min(1).max(500).optional().describe("The new Note's title. Needed with text."),
    format: format.describe("formal, informal, text, email, social-post, article, marketing-copy or note."),
    mode: z.enum(MODES).optional().describe("Who wrote it: human-only when left out."),
    scope: z.string().min(1).optional().describe("The scope the new Note is saved in, by scope_id, code or name, from list_scopes. General when left out."),
    reason: reasonFor("voice_tag_content"),
  }),
  run: async (ctx, a) => {
    if (!a.records && a.text === undefined) return refused("Nothing to tag: give records, or text to save.");
    if (a.text !== undefined && !a.title) return refused("Give title with text: the new Note's title.");
    if (a.text !== undefined && !a.text.trim()) return refused("The text is blank: give the writing to save.");
    const reason = reasonOf(a.reason, "voice_tag_content");
    const stamp = { authorshipMode: a.mode ?? "human-only", authorshipTaggedAt: new Date().toISOString(), format: a.format };
    type Outcome = { tagged: { record_id: string; title: string; type: string } } | { skipped: { record: string; reason: string } };
    const skip = (record: string, reason: string): Outcome => ({ skipped: { record, reason } });
    const tagOne = async (given: string, id: string): Promise<Outcome> => {
      const shown = await data(ctx, "fabrik_show_record", { p_record: id });
      if (!shown.ok) return skip(given, shown.result.content[0].text);
      const { title, payload } = shown.data;
      if (isTrashed(payload)) return skip(given, `"${title}" is deleted. restore_record brings it back.`);
      const type = payload?.type;
      if (!WRITING.includes(type)) return skip(given, `"${title}" is ${type ? `a ${type}` : "a record with no type"}, not writing: only ${WRITING.join(", ")} records are.`);
      if (!textOf(payload)) return skip(given, `"${title}" has no text to learn from.`);
      const own = await ownership(ctx, shown.data);
      if (typeof own !== "string") return skip(given, own.content[0].text);
      if (own === "other") return skip(given, `"${title}" was first saved for someone else, so it is not this person's writing.`);
      if (own === "changed") return skip(given, `"${title}" was last changed by someone else, so it is not tagged as this person's writing.`);
      const saved = await data(ctx, "fabrik_change_properties", { p_record: id, p_reason: reason, p_properties: stamp });
      if (!saved.ok) return skip(given, saved.result.content[0].text);
      return { tagged: { record_id: saved.data.record_id, title: saved.data.title, type } };
    };
    // Each record is found first, so one named twice, by its title and by its id, is tagged once: two saves of it side
    // by side would refuse the second. Then each record on its own, side by side, in the order they were given.
    const ids = await Promise.all((a.records ?? []).map((given) => named(ctx, given)));
    const first = new Map<string, string>();
    const outcomes = await Promise.all((a.records ?? []).map((given, i) => {
      const id = ids[i];
      if (!id.ok) return skip(given, id.result.content[0].text);
      const seen = first.get(id.id);
      if (seen !== undefined) return skip(given, `"${given}" is the same record as "${seen}", which is tagged once.`);
      first.set(id.id, given);
      return tagOne(given, id.id);
    }));
    const tagged = outcomes.flatMap((o) => "tagged" in o ? [o.tagged] : []);
    const skipped = outcomes.flatMap((o) => "skipped" in o ? [o.skipped] : []);
    if (a.text !== undefined) {
      const saved = await data(ctx, "fabrik_add_record", {
        p_scope: a.scope ?? GENERAL, p_kind: "evidence", p_title: a.title, p_reason: reason, p_fields: newFields("evidence", "Note", a.text, stamp),
      });
      if (!saved.ok) return refused(`The text was not saved: ${saved.result.content[0].text}` + (tagged.length ? ` ${tagged.length} records were tagged.` : ""));
      tagged.push({ record_id: saved.data.record_id, title: saved.data.title, type: "Note" });
    }
    return answer({ tagged, skipped });
  },
});

const voiceDistilProfile = tool({
  name: "voice_distil_profile",
  description: "Learn the signed-in person's writing voice and keep it as their own VoiceProfile record in General. It runs in two calls. " +
    "First, with no style_card: it reads their own writing, the records voice_tag_content tagged human-only or human-led-agent-assisted, and answers " +
    `profile (record_id, styleCard, generatedAt and corpusSize of the one saved now, or null), corpusSize (how many pieces of their writing there are, counting at most the newest ${CORPUS_LIMIT} of each type and mode), ` +
    "capped (true when a type and mode had more than that, so corpusSize counts fewer than there are), " +
    `samples (the newest pieces, up to ${SAMPLE_CHARS} characters in all, each with record_id, title, type, format, authorshipMode, saved_at and text) ` +
    "and feedback (their corrections to earlier drafts, newest first, each with intent, format and occurredAt). " +
    "Read them and write a style card: how they write, such as sentence length, vocabulary, openings and sign-offs, punctuation, tone and what they avoid, " +
    "with the corrections folded in, as short YAML or plain lines, per format where they differ. " +
    "Then call again with style_card, which saves it as a new version of their VoiceProfile, made by the first save, and answers the saved version. " +
    "format narrows the samples only: the card saved is the person's one profile, for every format, and its corpusSize counts all their writing. " +
    "voice_get_conditioning gives it back when writing for them. When someone else changed the profile last, note says so, and its card and corrections are left out and not kept.",
  input: z.object({
    style_card: z.string().min(1).max(20000).optional().describe("The style card you wrote from the samples and feedback. Leave out to get the samples."),
    format: format.optional().describe("Only samples of this format. Every format when left out. It does not change what a style_card is saved as."),
    reason: reasonFor("voice_distil_profile"),
  }),
  run: async (ctx, a) => {
    // A card is the person's one profile, for every format, so saving one counts all their writing.
    const [read, found] = await Promise.all([corpus(ctx, a.style_card ? undefined : a.format), ownRecord(ctx, TYPE)]);
    if ("content" in read) return read;
    const { samples, capped } = read;
    if ("content" in found) return found;
    const { record: p, foreign, props: kept } = trusted(found.record);
    const feedback = feedbackOf({ payload: { properties: kept } });
    if (!a.style_card) {
      return answer({
        profile: p ? { record_id: p.record_id, styleCard: kept.styleCard ?? null, generatedAt: kept.generatedAt ?? null, corpusSize: kept.corpusSize ?? null } : null,
        corpusSize: samples.length,
        capped,
        samples: within(samples, SAMPLE_CHARS),
        feedback: feedback.map(({ intent, format, occurredAt }) => ({ intent, format, occurredAt })),
        ...(foreign ? { note: FOREIGN } : {}),
      });
    }
    // Over a profile someone else changed last, nothing it holds is kept: it may not be the person's, so its corrections
    // are written, emptied. Over the person's own, they are left alone, so one saved meanwhile is not lost.
    const props = { styleCard: a.style_card, generatedAt: new Date().toISOString(), corpusSize: samples.length, feedbackEntries: feedback.length,
      ...(foreign ? { feedback: [] } : {}) };
    const reason = reasonOf(a.reason, "voice_distil_profile");
    // Read, then written: a correction saved by another call between the two stays, since only these properties are set.
    const saved = p
      ? await data(ctx, "fabrik_change_properties", { p_record: p.record_id, p_reason: reason, p_properties: ownProperties(p, props) })
      : await data(ctx, "fabrik_add_record", { p_scope: found.scope.scope_id, p_kind: "model", p_title: "Voice profile", p_reason: reason,
        p_fields: newFields("model", TYPE, "How the person writes, learned from their own writing.", props) });
    return saved.ok ? answer(saved.data) : saved.result;
  },
});

const voiceGetConditioning = tool({
  name: "voice_get_conditioning",
  description: "Get what to write with when writing as the signed-in person, such as a reply, an email or a post in their name: their style card, their corrections " +
    "to earlier drafts, and a few pieces of their own writing. Call it before drafting. Answers status: ok, or no-data when they have no style card, " +
    "no corrections and no tagged writing yet, and then write plainly and offer voice_tag_content; instruction, the style card and the corrections as one " +
    "instruction to follow, or null; styleCard; feedback, the corrections newest first, each with intent, format and occurredAt; and samples, pieces of their writing, " +
    "each with record_id, title, type, format, authorshipMode, saved_at and text, those naming the topic first, then the newest. Match how they write, not what the samples say. " +
    "When they correct a draft, call voice_record_feedback. " +
    "The card and corrections are used only when the person saved their VoiceProfile last, and a sample only when they saved it last; " +
    "when someone else changed the profile last, note says so and the card and corrections are left out.",
  input: z.object({
    format: format.optional().describe("The format being written, such as email: only samples, and corrections, of it. Every format when left out."),
    topic: z.string().min(1).max(500).optional().describe("What the writing is about, in a few words: samples holding more of its words of four letters or more come first."),
    length: z.enum(["short", "long"]).optional().describe(`short (the default) for an email or a post: ${CONDITIONING.short.k} samples; long for a brochure or a report: ${CONDITIONING.long.k}.`),
  }),
  run: async (ctx, a) => {
    const [read, found] = await Promise.all([corpus(ctx, a.format), ownRecord(ctx, TYPE)]);
    if ("content" in read) return read;
    const samples = read.samples;
    if ("content" in found) return found;
    const { foreign, props: kept } = trusted(found.record);
    const styleCard: string | null = kept.styleCard ?? null;
    const feedback = feedbackOf({ payload: { properties: kept } }).filter((f) => !a.format || !f.format || f.format === a.format)
      .map(({ intent, format, occurredAt }) => ({ intent, format, occurredAt }));
    const words = (a.topic ?? "").toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const hits = (s: Sample) => words.filter((w) => `${s.title} ${s.text}`.toLowerCase().includes(w)).length;
    const ranked = words.length ? [...samples].sort((x, y) => hits(y) - hits(x)) : samples;
    const { k, chars } = CONDITIONING[a.length ?? "short"];
    const chosen = within(ranked, chars, k);
    const parts = [
      styleCard ? `Write in the person's own voice, as their style card describes:\n${styleCard}` : null,
      feedback.length ? `They corrected earlier drafts; do as each correction says, newest first:\n${feedback.map((f) => `- ${f.intent}`).join("\n")}` : null,
      chosen.length ? "The samples are their own writing: match how they write, not what the samples say." : null,
    ].filter((x) => x !== null);
    return answer({
      status: styleCard || feedback.length || chosen.length ? "ok" : "no-data",
      instruction: parts.length ? parts.join("\n\n") : null,
      styleCard, feedback, samples: chosen,
      ...(foreign ? { note: FOREIGN } : {}),
    });
  },
});

const voiceRecordFeedback = tool({
  name: "voice_record_feedback",
  description: "Keep the signed-in person's correction of a draft written in their voice, so that voice_get_conditioning gives it with every later draft and " +
    "voice_distil_profile folds it into the next style card. Compare the draft with their edit and give intent, one sentence on what they changed and what it shows " +
    "about how they write, such as \"shorter, and dropped the apology\". It is kept in their own VoiceProfile record in General, made now if they have none, " +
    `newest first, the last ${FEEDBACK_KEPT} kept, with the two texts cut to ${FEEDBACK_TEXT} characters each. ` +
    "Answers record_id and version_id of the saved profile, intent, occurredAt, feedbackEntries (how many corrections it keeps) and hadProfile (whether it existed before).",
  input: z.object({
    original_text: z.string().min(1).describe("The draft as written."),
    edited_text: z.string().min(1).describe("The draft as the person changed it."),
    intent: z.string().min(1).max(500).describe("One sentence: what they changed, and what it shows about how they write."),
    format: format.optional().describe("The draft's format, such as email."),
    skill: z.string().min(1).max(200).optional().describe("The skill that wrote the draft, if any."),
    brief: z.string().min(1).max(2000).optional().describe("What the draft was asked for."),
    reason: reasonFor("voice_record_feedback"),
  }),
  run: async (ctx, a) => {
    const found = await ownRecord(ctx, TYPE);
    if ("content" in found) return found;
    const entry: Feedback = {
      intent: a.intent.trim(), format: a.format ?? null, originalText: a.original_text.slice(0, FEEDBACK_TEXT), editedText: a.edited_text.slice(0, FEEDBACK_TEXT),
      occurredAt: new Date().toISOString(), ...(a.skill ? { skill: a.skill } : {}), ...(a.brief ? { brief: a.brief } : {}),
    };
    // Over a profile someone else changed last, the corrections start again and its style card is removed: they may not be the person's.
    const feedback = [entry, ...feedbackOf({ payload: { properties: trusted(found.record).props } })].slice(0, FEEDBACK_KEPT);
    const reason = reasonOf(a.reason, "voice_record_feedback");
    // Read, then written: a correction saved by another call between the two is lost, since the whole list is saved.
    const saved = found.record
      ? await data(ctx, "fabrik_change_properties", { p_record: found.record.record_id, p_reason: reason, p_properties: ownProperties(found.record, { feedback }) })
      : await data(ctx, "fabrik_add_record", { p_scope: found.scope.scope_id, p_kind: "model", p_title: "Voice profile", p_reason: reason,
        p_fields: newFields("model", TYPE, "How the person writes, learned from their own writing.", { feedback }) });
    if (!saved.ok) return saved.result;
    return answer({ record_id: saved.data.record_id, version_id: saved.data.version_id, intent: entry.intent, occurredAt: entry.occurredAt,
      feedbackEntries: feedback.length, hadProfile: found.record !== null });
  },
});

/** The voice tools, in the order Claude lists them. */
export const VOICE_TOOLS: Tool[] = [voiceTagContent, voiceDistilProfile, voiceGetConditioning, voiceRecordFeedback];
