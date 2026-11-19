// The stand-in's release checks, run by run.sh's versions step:
//
// - every upgrade in setup/upgrades and setup/file-search-upgrades has a .sig beside it that the upgrade key in
//   setup/functions/fabrik-upgrade/upgrade-key.ts verifies, over the file's exact bytes, so fabrik update can apply it;
// - a change under plugins/fabrik/ or setup/ since the branch left origin/main raises the fabrik plugin's version above
//   the one it left with, so a plugin update installs it. A repository with no origin/main has nothing to compare with.
//
// node test/stand-in/release.mjs <repository root>. Prints ok and FAIL lines, and exits 1 on a FAIL.
import { createPublicKey, verify } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.argv[2];
let failed = 0;
const say = (ok, what) => { console.log(`${ok ? "ok" : "FAIL"} - ${what}`); if (!ok) failed++; };

// The upgrade key, as fabrik-upgrade holds it: the raw Ed25519 public key in base64.
const raw = /UPGRADE_PUBLIC_KEY = "([A-Za-z0-9+/=]+)"/.exec(readFileSync(join(root, "setup/functions/fabrik-upgrade/upgrade-key.ts"), "utf8"))[1];
const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw, "base64").toString("base64url") }, format: "jwk" });
const bad = [];
let count = 0;
for (const folder of ["upgrades", "file-search-upgrades"]) {
  const dir = join(root, "setup", folder);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".sql")).sort()) {
    count++;
    const sig = join(dir, file.replace(/\.sql$/, ".sig"));
    if (!existsSync(sig)) { bad.push(`${folder}/${file} has no .sig`); continue; }
    const ok = verify(null, readFileSync(join(dir, file)), key, Buffer.from(readFileSync(sig, "utf8").trim(), "base64"));
    if (!ok) bad.push(`${folder}/${file}'s .sig doesn't match it`);
  }
}
say(bad.length === 0, bad.length ? `every upgrade is signed beside it: ${bad.join("; ")}. Sign with node scripts/sign-upgrade.mjs --beside` : `all ${count} upgrades have a .sig the upgrade key verifies`);

// The plugin's version against the one at the commit this branch grew from on origin/main, fetched first so a branch
// cut from a newer main isn't compared with an older one.
const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 20000 });
const PLUGIN = "plugins/fabrik/.claude-plugin/plugin.json";
const fetched = git("fetch", "-q", "origin", "main");
if (fetched.status !== 0) console.log(`ok - origin/main couldn't be fetched, so the version is compared with this computer's copy of it: ${(fetched.stderr || fetched.error?.message || "").trim()}`);
const base = git("merge-base", "HEAD", "origin/main").stdout.trim();
/** Whether version a is higher than version b, part by part. */
const higher = (a, b) => {
  const [x, y] = [a, b].map(v => String(v).split(".").map(Number));
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
if (!base) say(true, "no origin/main to compare the plugin's version with");
else {
  const changed = git("diff", "--name-only", base, "--", "plugins/fabrik", "setup").stdout.split("\n").filter(Boolean)
    .concat(git("ls-files", "--others", "--exclude-standard", "--", "plugins/fabrik", "setup").stdout.split("\n").filter(Boolean));
  const now = JSON.parse(readFileSync(join(root, PLUGIN), "utf8")).version;
  const before = JSON.parse(git("show", `${base}:${PLUGIN}`).stdout || "{}").version;
  say(!changed.length || higher(now, before), changed.length
    ? `${changed.length} file(s) under plugins/fabrik or setup changed since this branch left origin/main, and the plugin's version is ${now}, ${higher(now, before) ? `up from ${before}` : `not above ${before}: raise it`}`
    : "nothing under plugins/fabrik or setup changed since this branch left origin/main");
}
process.exit(failed ? 1 : 0);
