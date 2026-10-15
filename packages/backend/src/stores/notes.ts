import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Shared note-file I/O for the edge. Notes are the project's store of short
 * facts and how-to procedures. Each note is a single `.md` file, where the
 * filename (minus extension) is the note name and the first non-empty line is
 * its one-line summary (used for listing); the rest is the body.
 *
 * A note belongs to a category, which is just a subdirectory: `notes/<category>/<name>.md`.
 * Categories are free-form and exist only because a note uses them. Notes
 * directly under `notes/` are in the `default` category, so existing notes
 * need no migration. Names are unique per category.
 *
 * This module is edge I/O (invariant #2). It is shared by the model-facing
 * note tools (`tools.ts`) and the user-facing `/note` command's `NoteSource`
 * (`index.ts`), so the file layout and naming rules live in one place.
 */

/** The category of a note that names none (stored directly in `notes/`). */
export const DEFAULT_CATEGORY = "default";

/** The placeholder body for a newly initialized note. */
const NOTE_TEMPLATE = "TODO: describe this note\n\n# Body";

/**
 * Where a note is stored: with the project (its `.vise/notes/`) or globally
 * (`~/.vise/notes/`, shared by every project and by sessions with no folder).
 */
export type NoteScope = "project" | "global";

/** The two data directories a session's notes live under. */
export interface NoteStores {
  project: string;
  global: string;
}

/** The scope a value names, or undefined when it is not exactly `project` or `global`. */
export function scopeOf(value: unknown): NoteScope | undefined {
  return value === "project" || value === "global" ? value : undefined;
}

/** A single listed note: its name, category, scope and one-line summary. */
export interface NoteEntry {
  name: string;
  category: string;
  scope: NoteScope;
  summary: string;
}

/** Path of the notes directory under the base directory. */
function noteDir(base: string): string {
  return join(base, "notes");
}

/** Directory holding a category's notes (`default` is the notes directory itself). */
function categoryDir(base: string, category: string): string {
  return category === DEFAULT_CATEGORY ? noteDir(base) : join(noteDir(base), category);
}

/** Path of a single note file. */
function notePath(base: string, name: string, category: string): string {
  return join(categoryDir(base, category), `${name}.md`);
}

/**
 * Note, category and profile names must be a single path-safe segment (no
 * traversal). Profiles share the same naming rule, so this is exported for
 * reuse by `src/stores/profiles.ts`.
 */
export function validName(name: string): boolean {
  return name.length > 0 && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

/** The category a possibly-absent argument names: trimmed, `default` when empty. */
export function categoryOf(category: unknown): string {
  const text = typeof category === "string" ? category.trim() : "";
  return text === "" ? DEFAULT_CATEGORY : text;
}

/** First non-empty line of a note's body, or "" for an empty note. */
function summaryOf(body: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim();
}

/** The notes of one category, sorted by name. */
function listCategory(base: string, category: string, scope: NoteScope): NoteEntry[] {
  const dir = categoryDir(base, category);
  if (!existsSync(dir)) return [];
  const out: NoteEntry[] = [];
  const files = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  );
  for (const f of files) {
    // A stray directory named like a note must not break listing.
    if (!f.isFile() || !f.name.endsWith(".md")) continue;
    const body = readFileSync(join(dir, f.name), "utf8");
    out.push({
      name: f.name.slice(0, -3),
      category,
      scope,
      summary: summaryOf(body),
    });
  }
  return out;
}

/** Every category that holds notes: `default` first, then the subdirectories by name. */
function categoriesOf(base: string): string[] {
  const dir = noteDir(base);
  if (!existsSync(dir)) return [];
  const subdirs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== DEFAULT_CATEGORY)
    .map((e) => e.name)
    .sort();
  return [DEFAULT_CATEGORY, ...subdirs];
}

/**
 * List the notes under `base`: every category (`default` first, the rest by
 * name, notes by name), or just `category` when given.
 */
export function listNotes(
  base: string,
  category?: string,
  scope: NoteScope = "project",
): NoteEntry[] {
  if (category !== undefined && category.trim() !== "") {
    return listCategory(base, categoryOf(category), scope);
  }
  return categoriesOf(base).flatMap((c) => listCategory(base, c, scope));
}

/**
 * The category a named note lives in. With `category` the answer is that
 * category (when the note exists there). Without it the default category wins,
 * otherwise the note must exist in exactly one category. Returns undefined
 * when there is no such note; throws when the name is ambiguous.
 */
function findNote(base: string, name: string, category?: string): string | undefined {
  if (!validName(name)) return undefined;
  if (category !== undefined && category.trim() !== "") {
    const wanted = categoryOf(category);
    return validName(wanted) && existsSync(notePath(base, name, wanted)) ? wanted : undefined;
  }
  const found = categoriesOf(base).filter((c) => existsSync(notePath(base, name, c)));
  if (found.includes(DEFAULT_CATEGORY)) return DEFAULT_CATEGORY;
  if (found.length > 1) {
    throw new Error(
      `note '${name}' exists in several categories (${found.join(", ")}): pass a category`,
    );
  }
  return found[0];
}

/**
 * Read a note's full body. Returns the text, or undefined when no note of
 * that name exists.
 */
export function readNote(base: string, name: string, category?: string): string | undefined {
  const found = findNote(base, name, category);
  if (found === undefined) return undefined;
  return readFileSync(notePath(base, name, found), "utf8");
}

/**
 * Save a note in `category` (default when omitted). Throws an `Error` (caught
 * by the caller into a string result) when a name is invalid, or the note
 * already exists in that category and `overwrite` is not set. Returns whether
 * the note was newly created or replaced an existing one.
 */
export function saveNote(
  base: string,
  name: string,
  body: string,
  category?: string,
  overwrite = false,
): "created" | "replaced" {
  const where = categoryOf(category);
  if (!validName(name)) {
    throw new Error(`invalid note name '${name}'`);
  }
  if (!validName(where)) {
    throw new Error(`invalid note category '${where}'`);
  }
  const existed = existsSync(notePath(base, name, where));
  if (!overwrite && existed) {
    throw new Error(`note '${name}' already exists in category '${where}'`);
  }
  mkdirSync(categoryDir(base, where), { recursive: true });
  writeFileSync(notePath(base, name, where), body.replace(/\s+$/, "") + "\n", "utf8");
  return existed ? "replaced" : "created";
}

/**
 * A token that changes whenever the note's file does (its modification time),
 * or undefined when there is no such note. An editor sends back the token it
 * loaded with, so a save can tell that the note changed underneath it.
 */
export function noteVersion(base: string, ref: NoteRef): number | undefined {
  const where = categoryOf(ref.category);
  if (!validName(ref.name) || !validName(where)) return undefined;
  try {
    return statSync(notePath(base, ref.name, where)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Initialize a note with a placeholder template body. Throws an `Error` when
 * the name or category is invalid or the note already exists (same rules as
 * `saveNote`).
 */
export function initNote(base: string, name: string, category?: string): void {
  saveNote(base, name, NOTE_TEMPLATE, category);
}

/** Remove a category's directory once its last note is gone (the default category is the notes directory itself). */
function pruneCategory(base: string, category: string): void {
  if (category === DEFAULT_CATEGORY) return;
  try {
    rmdirSync(categoryDir(base, category)); // only succeeds when empty
  } catch {
    // not empty (or already gone)
  }
}

/**
 * Delete a note by name (resolved like `readNote`). Throws an `Error` when no
 * note of that name exists or the name is ambiguous.
 */
export function deleteNote(base: string, name: string, category?: string): void {
  const found = findNote(base, name, category);
  if (found === undefined) {
    throw new Error(`note '${name}' not found`);
  }
  unlinkSync(notePath(base, name, found));
  pruneCategory(base, found);
}

/** Where a note lives: its name and category. */
export interface NoteRef {
  name: string;
  category?: string;
}

/**
 * Move or rename a note. Throws an `Error` when the source is missing, a
 * name/category is invalid, or the destination already exists.
 */
export function moveNote(base: string, from: NoteRef, to: NoteRef): void {
  const source = categoryOf(from.category);
  const target = categoryOf(to.category);
  if (!validName(to.name)) throw new Error(`invalid note name '${to.name}'`);
  if (!validName(target)) throw new Error(`invalid note category '${target}'`);
  if (!validName(from.name) || !validName(source)) {
    throw new Error(`note '${from.name}' not found`);
  }
  if (!existsSync(notePath(base, from.name, source))) {
    throw new Error(`note '${from.name}' not found`);
  }
  if (existsSync(notePath(base, to.name, target))) {
    throw new Error(`note '${to.name}' already exists in category '${target}'`);
  }
  mkdirSync(categoryDir(base, target), { recursive: true });
  renameSync(notePath(base, from.name, source), notePath(base, to.name, target));
  pruneCategory(base, source);
}
