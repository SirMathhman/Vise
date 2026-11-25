import type { NotesResponse } from "common";
import { NoteInputSchema, describeParseError } from "common";
import { errorJson, json, readBody } from "../http";
import type { NoteError } from "./notes-store";
import {
  createNote,
  deleteNote,
  describeNoteError,
  getNote,
  listNotes,
  updateNote,
} from "./notes-store";

// Maps a note failure to its HTTP status: a missing note is 404, a taken name is 409.
function noteFailure(error: NoteError): Response {
  const status =
    error === "not-found" ? 404 : error === "name-taken" ? 409 : 500;
  return errorJson(describeNoteError(error), status);
}

// GET lists every note; POST creates one.
async function notesCollection(req: Request): Promise<Response> {
  if (req.method === "GET") {
    const notes = await listNotes();
    if (!notes.ok) {
      return noteFailure(notes.error);
    }
    const body: NotesResponse = { notes: notes.value };
    return json(body);
  }
  const input = await readBody(req, NoteInputSchema);
  if (!input.ok) {
    return errorJson(describeParseError(input.error), 400);
  }
  const created = await createNote(input.value);
  return created.ok ? json(created.value, 201) : noteFailure(created.error);
}

// GET reads one note; PUT replaces its fields; DELETE removes it.
async function noteItem(req: Request, id: string): Promise<Response> {
  if (req.method === "GET") {
    const note = await getNote(id);
    return note.ok ? json(note.value) : noteFailure(note.error);
  }
  if (req.method === "PUT") {
    const input = await readBody(req, NoteInputSchema);
    if (!input.ok) {
      return errorJson(describeParseError(input.error), 400);
    }
    const updated = await updateNote(id, input.value);
    return updated.ok ? json(updated.value) : noteFailure(updated.error);
  }
  if (req.method === "DELETE") {
    const removed = await deleteNote(id);
    return removed.ok ? json(removed.value) : noteFailure(removed.error);
  }
  return errorJson("Method not allowed", 405);
}

/**
 * Serves /api/notes and /api/notes/:id. The path must already be one of those.
 *
 * @param req The request.
 * @param pathname The request's path, such as /api/notes/abc.
 * @returns The response for the note route.
 */
export function handleNotes(req: Request, pathname: string): Promise<Response> {
  if (pathname === "/api/notes") {
    return req.method === "GET" || req.method === "POST"
      ? notesCollection(req)
      : Promise.resolve(errorJson("Method not allowed", 405));
  }
  return noteItem(req, pathname.slice("/api/notes/".length));
}
