import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Note, NoteInput, Result } from "common";
import { NoteSchema, err, ok, parseJson } from "common";
import { z } from "zod";
import { configDir } from "../config-dir";

// The notes live in one file in the per-user config folder, outside the project, so the
// model's file tools and the sandbox never see them.
const NotesFileSchema = z.object({ notes: z.array(NoteSchema) });

/**
 * Why a note operation failed: no note has the id, another note already has the name, or the
 * notes file cannot be read.
 */
export type NoteError = "not-found" | "name-taken" | "unreadable";

/**
 * User-facing text for a note failure.
 *
 * @param error The failure to describe.
 * @returns The text to show the user or the model.
 */
export function describeNoteError(error: NoteError): string {
  switch (error) {
    case "not-found":
      return "No note has that id.";
    case "name-taken":
      return "Another note already has that name. Names must be unique, ignoring case.";
    case "unreadable":
      return "The notes file could not be read. Check that it is valid JSON.";
  }
}

function notesFile(): string {
  return path.join(configDir(), "notes.json");
}

async function readNotes(): Promise<Result<Note[], NoteError>> {
  const file = Bun.file(notesFile());
  if (!(await file.exists())) {
    return ok([]);
  }
  const parsed = parseJson(NotesFileSchema, await file.text());
  return parsed.ok ? ok(parsed.value.notes) : err("unreadable");
}

async function writeNotes(notes: Note[]): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  await Bun.write(notesFile(), JSON.stringify({ notes }, null, 2));
}

// Writes run one after another, so two saves at once cannot overwrite each other's change.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

// Names are unique ignoring case, and a note may keep its own name when it is edited.
function nameTaken(notes: Note[], name: string, ownId?: string): boolean {
  const wanted = name.toLowerCase();
  return notes.some(
    (note) => note.id !== ownId && note.name.toLowerCase() === wanted,
  );
}

/**
 * Every note, in the order they were created.
 *
 * @returns The notes, or "unreadable" when the file cannot be read.
 */
export function listNotes(): Promise<Result<Note[], NoteError>> {
  return readNotes();
}

/**
 * One note by its id.
 *
 * @param id The note's id.
 * @returns The note, or "not-found" or "unreadable".
 */
export async function getNote(id: string): Promise<Result<Note, NoteError>> {
  const notes = await readNotes();
  if (!notes.ok) {
    return notes;
  }
  const note = notes.value.find((n) => n.id === id);
  return note ? ok(note) : err("not-found");
}

/**
 * Adds a note with a new id.
 *
 * @param input The note's fields.
 * @returns The new note, or "name-taken" or "unreadable".
 */
export function createNote(input: NoteInput): Promise<Result<Note, NoteError>> {
  return serialized(async () => {
    const notes = await readNotes();
    if (!notes.ok) {
      return notes;
    }
    if (nameTaken(notes.value, input.name)) {
      return err("name-taken");
    }
    const note: Note = { id: randomUUID(), ...input };
    await writeNotes([...notes.value, note]);
    return ok(note);
  });
}

/**
 * Replaces a note's fields, keeping its id.
 *
 * @param id The note's id.
 * @param input The new fields.
 * @returns The updated note, or "not-found", "name-taken" or "unreadable".
 */
export function updateNote(
  id: string,
  input: NoteInput,
): Promise<Result<Note, NoteError>> {
  return serialized(async () => {
    const notes = await readNotes();
    if (!notes.ok) {
      return notes;
    }
    if (!notes.value.some((n) => n.id === id)) {
      return err("not-found");
    }
    if (nameTaken(notes.value, input.name, id)) {
      return err("name-taken");
    }
    const updated: Note = { id, ...input };
    await writeNotes(notes.value.map((n) => (n.id === id ? updated : n)));
    return ok(updated);
  });
}

/**
 * Removes a note.
 *
 * @param id The note's id.
 * @returns The removed note, or "not-found" or "unreadable".
 */
export function deleteNote(id: string): Promise<Result<Note, NoteError>> {
  return serialized(async () => {
    const notes = await readNotes();
    if (!notes.ok) {
      return notes;
    }
    const removed = notes.value.find((n) => n.id === id);
    if (!removed) {
      return err("not-found");
    }
    await writeNotes(notes.value.filter((n) => n.id !== id));
    return ok(removed);
  });
}
