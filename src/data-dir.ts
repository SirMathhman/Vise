import { join } from "node:path";

/**
 * The single runtime data directory holding every per-project store
 * (`.vise/profiles/`, `.vise/notes/`, `.vise/sessions/`). Computed once so
 * every edge I/O call site references the same value. The dot name also
 * excludes `.vise/` from the startup directory tree (dotfiles are skipped by
 * `fs-tree.ts`).
 */
export const dataDir = dataDirFor(process.cwd());

/** The data directory of a session rooted at `root` (the web server hosts sessions with different roots). */
export function dataDirFor(root: string): string {
  return join(root, ".vise");
}
