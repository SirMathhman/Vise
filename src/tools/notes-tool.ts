import { dataDir as defaultDataDir } from "../data-dir.ts";
import {
  deleteNote,
  formatNotes,
  listNotes,
  readNote,
  saveNote,
} from "../notes.ts";
import { errStr } from "./files.ts";

/** The optional `category` argument (undefined when absent). */
function categoryArg(args: Record<string, unknown>): string | undefined {
  return args.category === undefined ? undefined : String(args.category);
}

export function listNotesTool(
  args: Record<string, unknown>,
  dataDir: string = defaultDataDir,
): string {
  try {
    const category = String(args.category ?? "").trim();
    const notes = listNotes(dataDir, category);
    if (notes.length === 0) {
      return category === ""
        ? "no notes"
        : `no notes in category '${category}'`;
    }
    return formatNotes(notes);
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
    return readNote(dataDir, noteName, categoryArg(args)) ?? "";
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
    saveNote(dataDir, noteName, body, categoryArg(args), true);
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
    deleteNote(dataDir, noteName, categoryArg(args));
    return `deleted note '${noteName}'`;
  } catch (err) {
    return errStr(err);
  }
}
