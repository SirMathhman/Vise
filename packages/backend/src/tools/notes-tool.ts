import { NoteStore, requireScope, type NoteId } from "../stores/note-store.ts";
import { formatNotes } from "../stores/notes-format.ts";
import { categoryOf } from "../stores/notes.ts";
import { errStr } from "./files.ts";

/** The note an argument set names: its required scope, optional category, and name. */
function idOf(args: Record<string, unknown>): NoteId {
  return {
    scope: requireScope(args.scope),
    category: args.category === undefined ? undefined : String(args.category),
    name: String(args.name ?? ""),
  };
}

export function listNotesTool(args: Record<string, unknown>, store: NoteStore): string {
  try {
    const category = String(args.category ?? "").trim();
    const scope = args.scope === undefined ? undefined : requireScope(args.scope);
    const notes = store.list(category, scope);
    return notes.length === 0 ? "no notes" : formatNotes(notes);
  } catch (err) {
    return errStr(err);
  }
}

export function readNoteTool(args: Record<string, unknown>, store: NoteStore): string {
  try {
    return store.read(idOf(args)) ?? "error: no such note";
  } catch (err) {
    return errStr(err);
  }
}

export function saveNoteTool(args: Record<string, unknown>, store: NoteStore): string {
  try {
    const id = idOf(args);
    // An empty note is never what was meant: a model that sent its text under another name must be told, not thanked.
    if (typeof args.body !== "string" || args.body.trim() === "") {
      const other = ["content", "text", "note"].find((key) => typeof args[key] === "string");
      return other
        ? `error: save_note takes the note's text as 'body', not '${other}'; nothing was saved`
        : "error: save_note needs a non-empty 'body' (the note's text); nothing was saved";
    }
    const result = store.save(id, args.body, true);
    const category = categoryOf(id.category);
    const where = `${id.scope} note '${id.name}' in category '${category}'`;
    // Saving never moves a note: the same name under another category is a separate note, so say so.
    const elsewhere = store
      .list("", id.scope)
      .filter((n) => n.name === id.name && n.category !== category)
      .map((n) => `'${n.category}'`);
    const also =
      elsewhere.length === 0
        ? ""
        : `; a note of the same name also exists in ${elsewhere.join(", ")} (save does not move notes: delete_note the old one with its category to finish a move)`;
    return result === "replaced"
      ? `saved ${where} (replaced the previous content)${also}`
      : `saved ${where}${also}`;
  } catch (err) {
    return errStr(err);
  }
}

export function deleteNoteTool(args: Record<string, unknown>, store: NoteStore): string {
  try {
    const id = idOf(args);
    store.delete(id);
    return `deleted ${id.scope} note '${id.name}'`;
  } catch (err) {
    return errStr(err);
  }
}
