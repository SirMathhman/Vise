import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Shared note-file I/O for the edge. Notes are the project's combined
 * "memories" and "skills" store: `memory` notes are short facts (preferences,
 * context, decisions) and `skill` notes are how-to procedures. Each note is a
 * single `.md` file under `notes/<kind>/`, where the filename (minus
 * extension) is the note name and the first non-empty line is its one-line
 * summary (used for listing); the rest is the body.
 *
 * This module is edge I/O (invariant #2). It is shared by the model-facing
 * note tools (`tools.ts`) and the user-facing `/note` command's `NoteSource`
 * (`index.ts`), so the file layout and naming rules live in one place.
 */

/** The two note kinds, also the directory names under `notes/`. */
export type NoteKind = "memory" | "skill";

/** All note kinds, in listing order. */
export const NOTE_KINDS: NoteKind[] = ["memory", "skill"];

/** A single listed note: its kind, name, and one-line summary. */
export interface NoteEntry {
  kind: NoteKind;
  name: string;
  summary: string;
}

/** Directory holding a given kind of note under the base directory. */
function noteDir(base: string, kind: NoteKind): string {
  return join(base, "notes", kind);
}

/** Path of a single note file. */
function notePath(base: string, kind: NoteKind, name: string): string {
  return join(noteDir(base, kind), `${name}.md`);
}

/** Note names must be a single path-safe segment (no traversal). */
function validName(name: string): boolean {
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
 * `[<kind>] <name> — <summary>`. Shared by the model-facing `list_notes`
 * tool and the user-facing `/note` command so the format lives in one place.
 */
export function formatNoteEntry(e: NoteEntry): string {
  return `[${e.kind}] ${e.name} — ${e.summary}`;
}

/**
 * List every note under `base`, across both kinds, sorted by name within each
 * kind. Returns `NoteEntry` records with each note's one-line summary.
 */
export function listNotes(base: string): NoteEntry[] {
  const out: NoteEntry[] = [];
  for (const kind of NOTE_KINDS) {
    const dir = noteDir(base, kind);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).sort();
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const name = f.slice(0, -3);
      const body = readFileSync(join(dir, f), "utf8");
      out.push({ kind, name, summary: summaryOf(body) });
    }
  }
  return out;
}

/**
 * Find which kind holds a note of the given name under `base`, if any.
 * Used so a name is unique across the combined memories+skills store.
 */
export function findNoteKind(base: string, name: string): NoteKind | undefined {
  for (const kind of NOTE_KINDS) {
    if (existsSync(notePath(base, kind, name))) return kind;
  }
  return undefined;
}

/**
 * Read a note's full body. Returns the text, or undefined when no note of
 * that kind+name exists.
 */
export function readNote(
  base: string,
  kind: NoteKind,
  name: string,
): string | undefined {
  const p = notePath(base, kind, name);
  if (!existsSync(p)) return undefined;
  return readFileSync(p, "utf8");
}

/**
 * Save a note. Throws an `Error` (caught by the caller into a string result)
 * when the name is invalid or already exists; a note name is unique across
 * the combined memories+skills store, so an existing name in *either* kind
 * is a conflict.
 */
export function saveNote(
  base: string,
  kind: NoteKind,
  name: string,
  body: string,
): void {
  if (!validName(name)) {
    throw new Error(`invalid note name '${name}'`);
  }
  if (findNoteKind(base, name) !== undefined) {
    throw new Error(`note '${name}' already exists`);
  }
  const dir = noteDir(base, kind);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    notePath(base, kind, name),
    body.replace(/\s+$/, "") + "\n",
    "utf8",
  );
}

/**
 * Delete a note by name (searching both kinds). Throws an `Error` when no
 * note of that name exists in either kind.
 */
export function deleteNote(base: string, name: string): NoteKind {
  const kind = findNoteKind(base, name);
  if (kind === undefined) {
    throw new Error(`note '${name}' not found`);
  }
  rmSync(notePath(base, kind, name));
  return kind;
}
