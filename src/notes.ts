import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Shared note-file I/O for the edge. Notes are the project's store of short
 * facts and how-to procedures. Each note is a single `.md` file under
 * `notes/`, where the filename (minus extension) is the note name and the
 * first non-empty line is its one-line summary (used for listing); the rest
 * is the body.
 *
 * This module is edge I/O (invariant #2). It is shared by the model-facing
 * note tools (`tools.ts`) and the user-facing `/note` command's `NoteSource`
 * (`index.ts`), so the file layout and naming rules live in one place.
 */

/** The placeholder body for a newly initialized note. */
const NOTE_TEMPLATE = "TODO: describe this note\n\n# Body";

/** A single listed note: its name and one-line summary. */
export interface NoteEntry {
  name: string;
  summary: string;
}

/** Path of the notes directory under the base directory. */
function noteDir(base: string): string {
  return join(base, "notes");
}

/** Path of a single note file. */
function notePath(base: string, name: string): string {
  return join(noteDir(base), `${name}.md`);
}

/**
 * Note and profile names must be a single path-safe segment (no traversal).
 * Profiles share the same naming rule, so this is exported for reuse by
 * `src/profiles.ts`.
 */
export function validName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..")
  );
}

/** First non-empty line of a note's body, or "" for an empty note. */
function summaryOf(body: string): string {
  const line = body.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.trim();
}

/**
 * Render a single listed note as its presentation line:
 * `<name> — <summary>`. Shared by the model-facing `list_notes` tool and
 * the user-facing `/note` command so the format lives in one place.
 */
export function formatNoteEntry(e: NoteEntry): string {
  return `${e.name} — ${e.summary}`;
}

/**
 * List every note under `base`, sorted by name. Returns `NoteEntry` records
 * with each note's one-line summary.
 */
export function listNotes(base: string): NoteEntry[] {
  const dir = noteDir(base);
  if (!existsSync(dir)) return [];
  const out: NoteEntry[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".md")) continue;
    const name = f.slice(0, -3);
    const body = readFileSync(join(dir, f), "utf8");
    out.push({ name, summary: summaryOf(body) });
  }
  return out;
}

/**
 * Read a note's full body. Returns the text, or undefined when no note of
 * that name exists.
 */
export function readNote(base: string, name: string): string | undefined {
  const p = notePath(base, name);
  if (!existsSync(p)) return undefined;
  return readFileSync(p, "utf8");
}

/**
 * Save a note. Throws an `Error` (caught by the caller into a string result)
 * when the name is invalid or already exists.
 */
export function saveNote(base: string, name: string, body: string): void {
  if (!validName(name)) {
    throw new Error(`invalid note name '${name}'`);
  }
  if (existsSync(notePath(base, name))) {
    throw new Error(`note '${name}' already exists`);
  }
  mkdirSync(noteDir(base), { recursive: true });
  writeFileSync(notePath(base, name), body.replace(/\s+$/, "") + "\n", "utf8");
}

/**
 * Initialize a note with a placeholder template body. Throws an `Error` when
 * the name is invalid or already exists (same rules as `saveNote`).
 */
export function initNote(base: string, name: string): void {
  saveNote(base, name, NOTE_TEMPLATE);
}

/**
 * Delete a note by name. Throws an `Error` when no note of that name exists.
 */
export function deleteNote(base: string, name: string): void {
  const p = notePath(base, name);
  if (!existsSync(p)) {
    throw new Error(`note '${name}' not found`);
  }
  unlinkSync(p);
}
