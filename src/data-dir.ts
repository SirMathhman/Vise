import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The single runtime data directory holding every per-project store
 * (`.vise/profiles/`, `.vise/notes/`, `.vise/sessions/`). Computed once so
 * every edge I/O call site references the same value. The dot name also
 * excludes `.vise/` from the startup directory tree (dotfiles are skipped by
 * `fs-tree.ts`).
 */
export const dataDir = dataDirFor(process.cwd());

/**
 * The generated "project" directory of sessions that have no working
 * directory. It only holds their stores (`.vise/`) and hooks; the model never
 * sees it as a place it can work in.
 */
export const noFolderRoot = join(homedir(), ".vise", "no-folder");

/** The data directory of a session rooted at `root` (the web server hosts sessions with different roots). */
export function dataDirFor(root: string): string {
  return join(root, ".vise");
}
