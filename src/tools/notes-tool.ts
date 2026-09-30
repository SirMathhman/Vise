import { deleteNote, formatNoteEntry, listNotes, readNote, saveNote } from "../notes.ts";
import { errStr } from "./files.ts";

export function listNotesTool(_args: Record<string, unknown>): string {
  try {
    const notes = listNotes(process.cwd());
    if (notes.length === 0) return "no notes";
    return notes.map(formatNoteEntry).join("\n");
  } catch (err) {
    return errStr(err);
  }
}

export function readNoteTool(args: Record<string, unknown>): string {
  const noteName = String(args.name ?? "");
  try {
    return readNote(process.cwd(), noteName) ?? "";
  } catch (err) {
    return errStr(err);
  }
}

export function saveNoteTool(args: Record<string, unknown>): string {
  const noteName = String(args.name ?? "");
  const body = String(args.body ?? "");
  try {
    saveNote(process.cwd(), noteName, body);
    return `saved note '${noteName}'`;
  } catch (err) {
    return errStr(err);
  }
}

export function deleteNoteTool(args: Record<string, unknown>): string {
  const noteName = String(args.name ?? "");
  try {
    deleteNote(process.cwd(), noteName);
    return `deleted note '${noteName}'`;
  } catch (err) {
    return errStr(err);
  }
}
