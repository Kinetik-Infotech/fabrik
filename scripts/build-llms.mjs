// Writes fabrik.tech's llms.txt and llms-full.txt, the files a language model reads to learn what fabrik is, in the
// format llmstxt.org describes. llms.txt is a summary with a link to each guide; llms-full.txt holds the README and
// every guide in full. Both are built from README.md and docs/guides/, so run this after either changes:
//
//   node scripts/build-llms.mjs          writes site/llms.txt and site/llms-full.txt
//   node scripts/build-llms.mjs --check  exits 1 when either file is out of date
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "https://github.com/Kinetik-Infotech/fabrik";
const RAW = "https://raw.githubusercontent.com/Kinetik-Infotech/fabrik/main";

/** Each guide's file name, title and first sentence, in order. */
export function guides(root = ROOT) {
  const folder = join(root, "docs", "guides");
  return readdirSync(folder).filter(f => /^\d+-.+\.md$/.test(f)).sort().map(file => {
    const text = readFileSync(join(folder, file), "utf8");
    const title = (text.match(/^# (.+)$/m) ?? [, file])[1].trim();
    const para = text.split(/\n\s*\n/).map(p => p.trim()).find(p => p && !p.startsWith("#") && !p.startsWith("<")) ?? "";
    const first = (para.replace(/\s+/g, " ").match(/^.+?[.!?](\s|$)/) ?? [para])[0].trim();
    return { file, title, first, text };
  });
}

/** Links in the README and guides, relative to the repository, made absolute so they work from fabrik.tech. */
const absolute = (md, base) => md.replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_, path) => {
  return `](${REPO}/blob/main/${base}${path.replace(/^\.\//, "")})`;
});

export function build(root = ROOT) {
  const list = guides(root);
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const llms = `# fabrik

> fabrik is a free, open-source Claude plugin that runs your life or business as other AI assistants do, while every record and file stays in a Supabase project you own. Claude does the work through fabrik's connector, in every Claude app.

fabrik is made by Kinetik Infotech Ltd, under the MIT licence. Its website is https://fabrik.tech and its code is ${REPO}.

Key facts:

- fabrik stores records, files, their history and a search index in the owner's own Supabase project. Kinetik Infotech Ltd has no access to it.
- Claude works with fabrik through a connector the owner's project hosts, and through the fabrik plugin in Claude Code.
- It remembers people, meetings and decisions. It searches files by keyword, by meaning, and by the people and companies they name.
- It drafts email and posts in the owner's voice, plans projects and tasks, and designs the owner's routines and follows them.
- It puts websites live on the owner's own Cloudflare account, under their own web address.
- It gives a website chat agents in the owner's brand. They answer visitors from files the owner writes, and the owner keeps each conversation.
- With Claude in Chrome, Claude works in the owner's own browser, on the sites they're signed in to. It asks before it buys, pays or sends anything.
- It acts only when the owner asks. Nothing runs while the owner is away.
- fabrik is free. It needs a Claude plan, and free Supabase and Cloudflare accounts.
- It needs the Claude desktop app on a Mac with macOS 15 or later, Windows 10 version 1809 or later, or Linux.
- Setup takes about fifteen minutes: https://claude.ai/artifact/FYM5oNpqMeacSiUpA2JjNR

## Guides

${list.map(g => `- [${g.title}](${RAW}/docs/guides/${g.file}): ${g.first}`).join("\n")}

## Website

- [fabrik.tech](https://fabrik.tech/): what fabrik does, a day with it, and how it works. It compares fabrik with Instinct, Muse, Dots and Claude Duet.
- [Privacy](https://fabrik.tech/privacy/): what the website and its chat keep.
- [The full text](https://fabrik.tech/llms-full.txt): the README and every guide in one file.

## Plugins

- [fabrik](${REPO}/tree/main/plugins/fabrik): the knowledge base's tools and skills. They cover records, files and search, boards, graphs and printed PDFs, projects and the glossary. They also cover imports from LinkedIn, Notion, Obsidian, Substack and X, and website chat agents.
- [cloudflare](${REPO}/tree/main/plugins/cloudflare): deploys a folder as a website on Cloudflare Pages, with its form handlers, adds the owner's domain and manages its DNS records.
- [humanizer](${REPO}/tree/main/plugins/humanizer): writing rules and checks, so what Claude writes reads as a person wrote it.

## Optional

- [README](${RAW}/README.md): the project's overview, with setup and updating.
- [Code](${REPO}): the plugins, the setup for the Supabase project, its hosted functions and the tests.
`;
  const full = `# fabrik: the full text

> The README and every guide for fabrik, a free, open-source Claude plugin that keeps a person's or a business's knowledge in a Supabase project they own. The summary is https://fabrik.tech/llms.txt.

${absolute(readme.replace(/^<img[^>]*>\s*/, ""), "")}
${list.map(g => `\n---\n\nSource: ${RAW}/docs/guides/${g.file}\n\n${absolute(g.text.replace(/^<img[^>]*>\s*/, "").trim(), "docs/guides/")}\n`).join("")}`;
  return { "site/llms.txt": llms, "site/llms-full.txt": full };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = build();
  if (process.argv.includes("--check")) {
    const stale = Object.entries(files).filter(([path, text]) => {
      try { return readFileSync(join(ROOT, path), "utf8") !== text; } catch { return true; }
    }).map(([path]) => path);
    if (stale.length) { console.error(`Out of date: ${stale.join(", ")}. Run: node scripts/build-llms.mjs`); process.exit(1); }
    console.log("llms.txt and llms-full.txt are up to date.");
  } else {
    for (const [path, text] of Object.entries(files)) writeFileSync(join(ROOT, path), text);
    console.log(`Wrote ${Object.keys(files).join(" and ")}.`);
  }
}
