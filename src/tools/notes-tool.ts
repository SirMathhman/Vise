import { NoteStore, requireScope, type NoteId } from "../note-store.ts";
import { formatNotes } from "../notes-format.ts";
import { errStr } from "./files.ts";

/** The note an argument set names: its required scope, optional category, and name. */
function idOf(args: Record<string, unknown>): NoteId {
  return {
    scope: requireScope(args.scope),
    category: args.category === undefined ? undefined : String(args.category),
    name: String(args.name ?? ""),
  };
}

export function listNotesTool(
  args: Record<string, unknown>,
  store: NoteStore,
): string {
  try {
    const category = String(args.category ?? "").trim();
    const scope =
      args.scope === undefined ? undefined : requireScope(args.scope);
    const notes = store.list(category, scope);
    return notes.length === 0 ? "no notes" : formatNotes(notes);
  } catch (err) {
    return errStr(err);
  }
}

export function readNoteTool(
  args: Record<string, unknown>,
  store: NoteStore,
): string {
  try {
    return store.read(idOf(args)) ?? "";
  } catch (err) {
    return errStr(err);
  }
}

export function saveNoteTool(
  args: Record<string, unknown>,
  store: NoteStore,
): string {
  try {
    const id = idOf(args);
    const result = store.save(id, String(args.body ?? ""), true);
    return result === "replaced"
      ? `saved ${id.scope} note '${id.name}' (replaced the previous content)`
      : `saved ${id.scope} note '${id.name}'`;
  } catch (err) {
    return errStr(err);
  }
}

export function deleteNoteTool(
  args: Record<string, unknown>,
  store: NoteStore,
): string {
  try {
    const id = idOf(args);
    store.delete(id);
    return `deleted ${id.scope} note '${id.name}'`;
  } catch (err) {
    return errStr(err);
  }
}
