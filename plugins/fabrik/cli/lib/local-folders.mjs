// The folders on this computer where the person turned fabrik's local connector on: ~/.config/fabrik/local-folders.json,
// which fabrik sign-in --folder <folder> --local and owner setup write. The relay serves a folder only when it is on this
// list and its actor file says "connector": "local". The list is kept outside every folder, so a folder someone else
// made, such as a cloned repository holding an actor file, can't turn the relay on by itself.
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const listPath = (home = homedir()) => join(home, ".config", "fabrik", "local-folders.json");

/** The listed folders' real paths. An unreadable or broken list, or one another user can write, lists none. */
export function localFolders(home = homedir()) {
  const path = listPath(home);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) return [];
    if (process.platform !== "win32" && ((stat.mode & 0o022) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))) return [];
    const value = JSON.parse(readFileSync(path, "utf-8"));
    return value?.version === 1 && Array.isArray(value.folders) ? value.folders.filter(f => typeof f === "string" && f) : [];
  } catch {
    return [];
  }
}

const real = folder => { try { return realpathSync.native(folder); } catch { return null; } };

/** Whether the folder is on the list, compared by its real path. */
export function isLocalFolder(folder, home = homedir()) {
  const root = real(folder);
  return root !== null && localFolders(home).includes(root);
}

/** Adds the folder's real path to the list, through a private temporary file renamed into place. */
export function addLocalFolder(folder, home = homedir()) {
  const root = realpathSync.native(folder);
  const folders = localFolders(home);
  if (folders.includes(root)) return listPath(home);
  const dir = join(home, ".config", "fabrik");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = listPath(home);
  const temporary = join(dir, `.${process.pid}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ version: 1, folders: [...folders, root] }, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try { renameSync(temporary, target); chmodSync(target, 0o600); }
  catch (err) { rmSync(temporary, { force: true }); throw err; }
  return target;
}
