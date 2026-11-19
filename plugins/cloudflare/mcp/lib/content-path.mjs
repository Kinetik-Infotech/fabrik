import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

const inside = (root, candidate) => candidate === root || candidate.startsWith(root + sep);

function contentRoot(env = process.env) {
  const configured = env.CLOUDFLARE_CONTENT_ROOT;
  if (!configured) throw new Error("CLOUDFLARE_CONTENT_ROOT is required for local file access.");
  if (!isAbsolute(configured)) throw new Error("CLOUDFLARE_CONTENT_ROOT must be an absolute path.");
  if (!existsSync(configured)) throw new Error(`CLOUDFLARE_CONTENT_ROOT does not exist: ${configured}`);
  const stated = lstatSync(configured);
  if (stated.isSymbolicLink()) throw new Error("CLOUDFLARE_CONTENT_ROOT must not be a symlink.");
  if (!stated.isDirectory()) throw new Error("CLOUDFLARE_CONTENT_ROOT must be a directory.");
  return { stated: resolve(configured), actual: realpathSync(configured) };
}

export function confinedPath(candidate, { write = false, env = process.env } = {}) {
  const root = contentRoot(env);
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    throw new Error("Local file paths must be absolute.");
  }
  const lexical = resolve(candidate);
  if (!inside(root.stated, lexical)) throw new Error(`Path is outside CLOUDFLARE_CONTENT_ROOT: ${candidate}`);

  if (existsSync(lexical)) {
    const actual = realpathSync(lexical);
    if (!inside(root.actual, actual)) throw new Error(`Path escapes CLOUDFLARE_CONTENT_ROOT through a symlink: ${candidate}`);
    return actual;
  }
  if (!write) throw new Error(`Path does not exist: ${candidate}`);

  let parent = dirname(lexical);
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) throw new Error(`No existing parent for path: ${candidate}`);
    parent = next;
  }
  const actualParent = realpathSync(parent);
  if (!inside(root.actual, actualParent)) throw new Error(`Path escapes CLOUDFLARE_CONTENT_ROOT through a symlink: ${candidate}`);
  return lexical;
}

export function recheckConfinedPath(candidate, env = process.env) {
  return confinedPath(candidate, { env });
}
