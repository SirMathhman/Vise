import { dataDir as defaultDataDir } from "../data-dir.ts";
import {
  deleteNote,
  formatNoteEntry,
  listNotes,
  readNote,
  saveNote,
} from "../notes.ts";
import { errStr } from "./files.ts";

export function listNotesTool(
  _args: Record<string, unknown>,
  dataDir: string = defaultDataDir,
): string {
  try {
    const notes = listNotes(dataDir);
    if (notes.length === 0) return "no notes";
    return notes.map(formatNoteEntry).join("\n");
  } catch (err) {
    return errStr(err);
  }
}

export function readNoteTool(
  args: Record<string, unknown>,
  dataDir: string = defaultDataDir,
): string {
  const noteName = String(args.name ?? "");
  try {
    return readNote(dataDir, noteName) ?? "";
  } catch (err) {
    return errStr(err);
  }
}

export function saveNoteTool(
  args: Record<string, unknown>,
  dataDir: string = defaultDataDir,
): string {
  const noteName = String(args.name ?? "");
  const body = String(args.body ?? "");
  try {
    saveNote(dataDir, noteName, body);
    return `saved note '${noteName}'`;
  } catch (err) {
    return errStr(err);
  }
}

export function deleteNoteTool(
  args: Record<string, unknown>,
  dataDir: string = defaultDataDir,
): string {
  const noteName = String(args.name ?? "");
  try {
    deleteNote(dataDir, noteName);
    return `deleted note '${noteName}'`;
  } catch (err) {
    return errStr(err);
  }
}
