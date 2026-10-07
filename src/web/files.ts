import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

/**
 * Read-only file explorer backend for the web UI. Paths are relative to the
 * explorer root (the process working directory) and can never escape it.
 */

/** Largest file the viewer will return; bigger ones are reported as too large. */
const MAX_FILE_BYTES = 256 * 1024;

export interface DirEntry {
  name: string;
  dir: boolean;
}

export type ExplorerResult<T> =
  { ok: true; value: T } | { ok: false; error: string; status: number };

/**
 * Resolve `rel` under `root`, or null when it would leave the root. Symlinks
 * and junctions are resolved first, so a link pointing outside is refused;
 * a missing target is also null, so existence outside the root never leaks.
 */
function confine(root: string, rel: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const abs = realpathSync(resolve(realRoot, rel));
    const back = relative(realRoot, abs);
    if (back === ".." || back.startsWith(`..${sep}`) || resolve(back) === back)
      return null;
    return abs;
  } catch {
    return null;
  }
}

/** List a directory: directories first, then files, each alphabetical. */
export function listDir(
  root: string,
  rel: string,
): ExplorerResult<{ root: string; entries: DirEntry[] }> {
  const abs = confine(root, rel);
  if (abs === null)
    return { ok: false, error: "path outside root or missing", status: 400 };
  try {
    const entries = readdirSync(abs, { withFileTypes: true })
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort(
        (a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name),
      );
    return { ok: true, value: { root, entries } };
  } catch {
    return { ok: false, error: "cannot read directory", status: 404 };
  }
}

/** Read a text file; refuses oversize and binary (NUL-containing) files. */
export function readTextFile(
  root: string,
  rel: string,
): ExplorerResult<string> {
  const abs = confine(root, rel);
  if (abs === null)
    return { ok: false, error: "path outside root or missing", status: 400 };
  try {
    const stat = statSync(abs);
    if (!stat.isFile()) return { ok: false, error: "not a file", status: 400 };
    if (stat.size > MAX_FILE_BYTES)
      return { ok: false, error: "file too large to view", status: 413 };
    const buf = readFileSync(abs);
    if (buf.includes(0))
      return { ok: false, error: "binary file", status: 415 };
    return { ok: true, value: buf.toString("utf8") };
  } catch {
    return { ok: false, error: "cannot read file", status: 404 };
  }
}
