import { join } from "node:path";
import {
  deleteNote,
  formatNoteEntry,
  listNotes,
  readNote,
  saveNote,
} from "../notes.ts";
import { errStr } from "./files.ts";

// Every runtime data store (profiles, notes, sessions) lives under a single
// `.vise/` directory so the working directory is not polluted by them. The
// edge I/O modules each join this `base` with their own subdirectory, so
// pointing the note tools at `.vise/` relocates the note store under it.
const dataDir = join(process.cwd(), ".vise");

export function listNotesTool(_args: Record<string, unknown>): string {
  try {
    const notes = listNotes(dataDir);
    if (notes.length === 0) return "no notes";
    return notes.map(formatNoteEntry).join("\n");
  } catch (err) {
    return errStr(err);
  }
}

export function readNoteTool(args: Record<string, unknown>): string {
  const noteName = String(args.name ?? "");
  try {
    return readNote(dataDir, noteName) ?? "";
  } catch (err) {
    return errStr(err);
  }
}

export function saveNoteTool(args: Record<string, unknown>): string {
  const noteName = String(args.name ?? "");
  const body = String(args.body ?? "");
  try {
    saveNote(dataDir, noteName, body);
    return `saved note '${noteName}'`;
  } catch (err) {
    return errStr(err);
  }
}

export function deleteNoteTool(args: Record<string, unknown>): string {
  const noteName = String(args.name ?? "");
  try {
    deleteNote(dataDir, noteName);
    return `deleted note '${noteName}'`;
  } catch (err) {
    return errStr(err);
  }
}
