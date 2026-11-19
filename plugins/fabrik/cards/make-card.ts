// Writes setup/functions/fabrik-apps/card.ts, the copy of the card pages in this folder that the fabrik-apps connector
// serves: kit.html, the style and code every card shares, and records.html, board.html and graph.html, each a card's
// own style, markup and code. It also writes brand-core.mjs there, the copy of the plugin's cli/lib/brand.mjs that the
// connector's brand.ts reads the brand with. Run it after any of them changes, and deploy fabrik-apps again:
//   deno run --allow-read --allow-write plugins/fabrik/cards/make-card.ts
// The stand-in's fabrik-apps step compares card.ts and brand-core.mjs with what this would write.
const HERE = new URL("./", import.meta.url);
export const CARD_TS = new URL("../../../setup/functions/fabrik-apps/card.ts", import.meta.url);
export const BRAND_CORE = new URL("../../../setup/functions/fabrik-apps/brand-core.mjs", import.meta.url);
const BRAND = new URL("../cli/lib/brand.mjs", import.meta.url);

/** brand-core.mjs as it is made from the plugin's cli/lib/brand.mjs. */
export function madeBrand(): string {
  return `// Made by plugins/fabrik/cards/make-card.ts from plugins/fabrik/cli/lib/brand.mjs. Run make-card.ts again; do not edit.\n${Deno.readTextFileSync(BRAND)}`;
}

/** card.ts as it is made from the card pages in this folder, each by its file's name. */
export function made(): string {
  const names = [...Deno.readDirSync(HERE)].map((e) => e.name).filter((n) => n.endsWith(".html")).sort();
  const cards = names.map((n) => `  ${JSON.stringify(n.replace(/\.html$/, ""))}: ${JSON.stringify(Deno.readTextFileSync(new URL(n, HERE)))},`);
  return `// Made by plugins/fabrik/cards/make-card.ts from ${names.join(", ")} in that folder. Run make-card.ts again; do not edit.
export const CARDS: Record<string, string> = {
${cards.join("\n")}
};
`;
}

if (import.meta.main) {
  Deno.writeTextFileSync(CARD_TS, made());
  Deno.writeTextFileSync(BRAND_CORE, madeBrand());
  console.log(`${CARD_TS.pathname} and ${BRAND_CORE.pathname} written`);
}
