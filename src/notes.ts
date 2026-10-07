import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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

/** A single listed note: its name, category and one-line summary. */
export interface NoteEntry {
  name: string;
  category: string;
  summary: string;
}

/** Path of the notes directory under the base directory. */
function noteDir(base: string): string {
  return join(base, "notes");
}

/** Directory holding a category's notes (`default` is the notes directory itself). */
function categoryDir(base: string, category: string): string {
  return category === DEFAULT_CATEGORY
    ? noteDir(base)
    : join(noteDir(base), category);
}

/** Path of a single note file. */
function notePath(base: string, name: string, category: string): string {
  return join(categoryDir(base, category), `${name}.md`);
}

/**
 * Note, category and profile names must be a single path-safe segment (no
 * traversal). Profiles share the same naming rule, so this is exported for
 * reuse by `src/profiles.ts`.
 */
export function validName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..")
  );
}

/** The category a possibly-absent argument names: trimmed, `default` when empty. */
function categoryOf(category: unknown): string {
  const text = typeof category === "string" ? category.trim() : "";
  return text === "" ? DEFAULT_CATEGORY : text;
}

/** First non-empty line of a note's body, or "" for an empty note. */
function summaryOf(body: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim();
}

/** The notes of one category, sorted by name. */
function listCategory(base: string, category: string): NoteEntry[] {
  const dir = categoryDir(base, category);
  if (!existsSync(dir)) return [];
  const out: NoteEntry[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const body = readFileSync(join(dir, f), "utf8");
    out.push({ name: f.slice(0, -3), category, summary: summaryOf(body) });
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
 * Render one listed note as its presentation line: `<name> — <summary>`.
 */
export function formatNoteEntry(e: NoteEntry): string {
  return `${e.name} — ${e.summary}`;
}

/**
 * Render notes grouped by category (in the order given): a heading with the
 * note count, then one indented line per note. Shared by the `list_notes`
 * tool, the `/note` command and the startup message.
 */
export function formatNotes(entries: NoteEntry[]): string {
  const groups = new Map<string, NoteEntry[]>();
  for (const e of entries) {
    groups.set(e.category, [...(groups.get(e.category) ?? []), e]);
  }
  return [...groups]
    .map(
      ([category, notes]) =>
        `${category} (${notes.length})\n` +
        notes.map((n) => `  ${formatNoteEntry(n)}`).join("\n"),
    )
    .join("\n");
}

/**
 * List the notes under `base`: every category (`default` first, the rest by
 * name, notes by name), or just `category` when given.
 */
export function listNotes(base: string, category?: string): NoteEntry[] {
  if (category !== undefined && category.trim() !== "") {
    return listCategory(base, categoryOf(category));
  }
  return categoriesOf(base).flatMap((c) => listCategory(base, c));
}

/**
 * The category a named note lives in. With `category` the answer is that
 * category (when the note exists there). Without it the default category wins,
 * otherwise the note must exist in exactly one category. Returns undefined
 * when there is no such note; throws when the name is ambiguous.
 */
function findNote(
  base: string,
  name: string,
  category?: string,
): string | undefined {
  if (!validName(name)) return undefined;
  if (category !== undefined && category.trim() !== "") {
    const wanted = categoryOf(category);
    return validName(wanted) && existsSync(notePath(base, name, wanted))
      ? wanted
      : undefined;
  }
  const found = categoriesOf(base).filter((c) =>
    existsSync(notePath(base, name, c)),
  );
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
export function readNote(
  base: string,
  name: string,
  category?: string,
): string | undefined {
  const found = findNote(base, name, category);
  if (found === undefined) return undefined;
  return readFileSync(notePath(base, name, found), "utf8");
}

/**
 * Save a note in `category` (default when omitted). Throws an `Error` (caught
 * by the caller into a string result) when a name is invalid or the note
 * already exists in that category.
 */
export function saveNote(
  base: string,
  name: string,
  body: string,
  category?: string,
): void {
  const where = categoryOf(category);
  if (!validName(name)) {
    throw new Error(`invalid note name '${name}'`);
  }
  if (!validName(where)) {
    throw new Error(`invalid note category '${where}'`);
  }
  if (existsSync(notePath(base, name, where))) {
    throw new Error(`note '${name}' already exists in category '${where}'`);
  }
  mkdirSync(categoryDir(base, where), { recursive: true });
  writeFileSync(
    notePath(base, name, where),
    body.replace(/\s+$/, "") + "\n",
    "utf8",
  );
}

/**
 * Initialize a note with a placeholder template body. Throws an `Error` when
 * the name or category is invalid or the note already exists (same rules as
 * `saveNote`).
 */
export function initNote(base: string, name: string, category?: string): void {
  saveNote(base, name, NOTE_TEMPLATE, category);
}

/**
 * Delete a note by name (resolved like `readNote`). Throws an `Error` when no
 * note of that name exists or the name is ambiguous.
 */
export function deleteNote(
  base: string,
  name: string,
  category?: string,
): void {
  const found = findNote(base, name, category);
  if (found === undefined) {
    throw new Error(`note '${name}' not found`);
  }
  unlinkSync(notePath(base, name, found));
}
