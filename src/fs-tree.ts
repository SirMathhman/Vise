import { config } from "./config.ts";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";


/**
 * Build a capped initial directory structure as a multi-line string for
 * injection into the conversation at startup.
 *
 * Rules:
 * - Hidden entries (dotfiles/dotdirs) are excluded.
 * - Directories are listed before files; each group is alphabetically sorted.
 * - Directories are shown with a trailing `/`.
 * - Traversal stops when either `MAX_DEPTH` levels below the root is reached
 *   or `MAX_ENTRIES` total entries (files + directories) have been emitted,
 *   whichever happens first. When truncated, a `(truncated)` marker is
 *   appended.
 * - Unreadable directories are silently skipped.
 *
 * Edge module: performs `node:fs` I/O. The core and session never import
 * this module; `index.ts` calls it once at startup and passes the result to
 * the `Session` constructor.
 */
export function buildInitialTree(dir: string): string {
  const lines: string[] = [];
  let entries = 0;
  let truncated = false;

  function walk(current: string, depth: number): void {
    // `depth` is the number of directory levels below root whose children
    // we are about to enumerate. When depth reaches MAX_DEPTH, the children
    // would be at MAX_DEPTH + 1 levels below root, which is beyond the cap.
    if (truncated || depth >= config.treeMaxDepth || entries >= config.treeMaxEntries) return;

    let items: string[];
    try {
      items = readdirSync(current);
    } catch {
      return;
    }

    const dirs: string[] = [];
    const files: string[] = [];
    for (const name of items) {
      if (name.startsWith(".")) continue;
      const full = join(current, name);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      (isDir ? dirs : files).push(name);
    }
    dirs.sort();
    files.sort();

    const indent = "  ".repeat(depth);
    for (const name of dirs) {
      if (entries >= config.treeMaxEntries) {
        truncated = true;
        return;
      }
      entries++;
      lines.push(`${indent}${name}/`);
      walk(join(current, name), depth + 1);
    }
    for (const name of files) {
      if (entries >= config.treeMaxEntries) {
        truncated = true;
        return;
      }
      entries++;
      lines.push(`${indent}${name}`);
    }
  }

  walk(dir, 0);
  if (truncated) {
    lines.push("(truncated)");
  }
  return lines.join("\n");
}
