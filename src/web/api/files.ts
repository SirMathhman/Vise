import { config } from "../../config.ts";
import {
  readdirSync,
  watch,
  readFileSync,
  realpathSync,
  statSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, resolve, sep } from "node:path";

/**
 * Read-only file explorer backend for the web UI. Paths are relative to the
 * explorer root (the process working directory) and can never escape it.
 */

/** Largest file the viewer will return; bigger ones are reported as too large. */

export interface DirEntry {
  name: string;
  dir: boolean;
  ignored?: boolean;
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
    if (stat.size > config.maxFileBytes)
      return { ok: false, error: "file too large to view", status: 413 };
    const buf = readFileSync(abs);
    if (buf.includes(0))
      return { ok: false, error: "binary file", status: 415 };
    return { ok: true, value: buf.toString("utf8") };
  } catch {
    return { ok: false, error: "cannot read file", status: 404 };
  }
}

/** True when `root` contains a `.git` entry (directory or file). */
export function isGitRoot(root: string): boolean {
  return existsSync(join(root, ".git"));
}

/**
 * Annotate entries with `ignored: true` for those git has marked as ignored.
 * Returns the same array unchanged when the root is not a git repo or git
 * is unavailable.
 */
export function annotateIgnored(
  root: string,
  rel: string,
  entries: DirEntry[],
): DirEntry[] {
  if (!isGitRoot(root) || entries.length === 0) return entries;
  const paths = entries.map((e) => (rel ? rel + "/" + e.name : e.name));
  const stdin = paths.join("\n") + "\n";
  let stdout: string;
  try {
    const result = spawnSync(
      "git",
      ["check-ignore", "--stdin"],
      { input: stdin, cwd: root, encoding: "utf8" },
    );
    if (result.status !== 0) return entries;
    stdout = result.stdout;
  } catch {
    return entries;
  }
  const ignoredSet = new Set(
    stdout
      .split("\n")
      .filter((l) => l.length > 0),
  );
  return entries.map((e, i) =>
    ignoredSet.has(paths[i]!)
      ? { name: e.name, dir: e.dir, ignored: true }
      : { name: e.name, dir: e.dir },
  );
}

/** Path segments whose changes are noise for the explorer. */
const IGNORED = new Set([".git", "node_modules"]);

/**
 * Call `onChange` (debounced) whenever something under `root` changes, whoever
 * made the change — the agent's tools, a shell command, or the user. Returns
 * a function that stops watching. Platforms without recursive watch support
 * simply never fire.
 */
export function watchRoot(root: string, onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const watcher = watch(root, { recursive: true }, (_event, name) => {
      if (
        name &&
        String(name)
          .split(sep)
          .some((p) => IGNORED.has(p))
      )
        return;
      clearTimeout(timer);
      timer = setTimeout(onChange, 150);
    });
    return () => {
      clearTimeout(timer);
      watcher.close();
    };
  } catch {
    return () => {};
  }
}
