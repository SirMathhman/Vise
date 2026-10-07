import {
  baseOf,
  deleteNote,
  formatNotes,
  listAllNotes,
  readNote,
  saveNote,
  scopeOf,
  type NoteScope,
  type NoteStores,
} from "../notes.ts";
import { errStr } from "./files.ts";

/** The optional `category` argument (undefined when absent). */
function categoryArg(args: Record<string, unknown>): string | undefined {
  return args.category === undefined ? undefined : String(args.category);
}

/** The required `scope` argument: `project` or `global`. */
function scopeArg(args: Record<string, unknown>): NoteScope {
  const scope = scopeOf(args.scope);
  if (!scope) {
    throw new Error('\'scope\' is required: "project" or "global"');
  }
  return scope;
}

export function listNotesTool(
  args: Record<string, unknown>,
  stores: NoteStores,
): string {
  try {
    const category = String(args.category ?? "").trim();
    const scope = args.scope === undefined ? undefined : scopeArg(args);
    const notes = listAllNotes(stores, category, scope);
    if (notes.length === 0) return "no notes";
    return formatNotes(notes);
  } catch (err) {
    return errStr(err);
  }
}

export function readNoteTool(
  args: Record<string, unknown>,
  stores: NoteStores,
): string {
  const noteName = String(args.name ?? "");
  try {
    const base = baseOf(stores, scopeArg(args));
    return readNote(base, noteName, categoryArg(args)) ?? "";
  } catch (err) {
    return errStr(err);
  }
}

export function saveNoteTool(
  args: Record<string, unknown>,
  stores: NoteStores,
): string {
  const noteName = String(args.name ?? "");
  const body = String(args.body ?? "");
  try {
    const scope = scopeArg(args);
    const base = baseOf(stores, scope);
    const result = saveNote(base, noteName, body, categoryArg(args), true);
    return result === "replaced"
      ? `saved ${scope} note '${noteName}' (replaced the previous content)`
      : `saved ${scope} note '${noteName}'`;
  } catch (err) {
    return errStr(err);
  }
}

export function deleteNoteTool(
  args: Record<string, unknown>,
  stores: NoteStores,
): string {
  const noteName = String(args.name ?? "");
  try {
    const scope = scopeArg(args);
    deleteNote(baseOf(stores, scope), noteName, categoryArg(args));
    return `deleted ${scope} note '${noteName}'`;
  } catch (err) {
    return errStr(err);
  }
}
