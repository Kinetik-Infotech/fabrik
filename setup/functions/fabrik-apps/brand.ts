// The business's brand on fabrik's cards. brand-core.mjs, a copy of the fabrik plugin's cli/lib/brand.mjs that
// plugins/fabrik/cards/make-card.ts writes, reads the Brand record and keeps only the values a card may take. This file
// gives card_page that brand, read as the person, and keeps each person's last read, so a card opened again with the
// same version of the brand in force skips the record.
import * as core from "./brand-core.mjs";
import type { Ctx } from "./tool.ts";

type Font = { family: string; google: boolean; fallback: string[] };
export type Brand = {
  name: string;
  palette: { light: Record<string, string>; dark: Record<string, string> };
  fonts: { heading?: Font; body?: Font };
  logo: { src: string; alt: string } | null;
};

export const TOKENS: readonly string[] = core.TOKENS;
export const FONT_DOMAINS: string[] = core.FONT_DOMAINS;
export const brandOf = core.brandOf as (record: unknown) => Brand | null;
export const cardStyle = core.cardStyle as (brand: Brand) => { imports: string; css: string };
/** The brand's logo as the card's <img>, or nothing. */
export const logoHtml = (brand: Brand) => core.logoHtml(brand, "fk-logo") as string;

/** Each person's last read of the brand, by their account's id. Only the person's own reads go in their entry. */
const CACHE = new Map<string, Record<string, unknown>>();
const MAX_PEOPLE = 200;
function cacheOf(person: string | undefined): Record<string, unknown> | null {
  if (!person) return null;
  let entry = CACHE.get(person);
  if (!entry) {
    if (CACHE.size >= MAX_PEOPLE) CACHE.delete(CACHE.keys().next().value!);
    CACHE.set(person, entry = {});
  }
  return entry;
}

/** The Brand record in General, read as the person. With none, no grant to read General, a refusal, or no answer in
 * time, there is no brand, and the card keeps its plain look. */
export function readBrand(ctx: Ctx): Promise<Brand | null> {
  return core.readBrand(async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await ctx.fabrik.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data;
  }, { cache: cacheOf(ctx.person) }) as Promise<Brand | null>;
}
