// Phone-number helpers for pairing, lifted from maxy-lite's channels/whatsapp/normalize.mjs.

/** A phone-like string as digits-only E.164, with no leading "+", or "" for anything that isn't a number. */
export function normalizeE164(value) {
  let candidate = String(value ?? "").trim().replace(/[\s\-().]/g, "").replace(/^whatsapp:/i, "");
  if (candidate.startsWith("+")) candidate = candidate.slice(1);
  else if (candidate.startsWith("00")) candidate = candidate.slice(2);
  if (!/^\d+$/.test(candidate)) return "";
  return candidate;
}

/** A number for the log: the first two and last two digits, the rest starred. */
export function maskPhone(digits) {
  if (digits.length <= 4) return "*".repeat(digits.length);
  return digits.slice(0, 2) + "*".repeat(digits.length - 4) + digits.slice(-2);
}
