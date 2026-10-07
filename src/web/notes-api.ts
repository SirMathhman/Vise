import {
  baseOf,
  categoryOf,
  deleteNote,
  listAllNotes,
  moveNote,
  noteVersion,
  readNote,
  saveNote,
  scopeOf,
  type NoteScope,
  type NoteStores,
} from "../notes.ts";

/**
 * The web UI's notes editor. It talks to the same stores as the model's note
 * tools and the `/note` command (`.vise/notes/` of the project, and
 * `~/.vise/notes/` for global notes), directly (never through a model turn).
 * A note is named by its `scope` (`project` | `global`), `category` and `name`.
 * Wire protocol (JSON):
 *   browser → server: { type:"notes_list" }
 *                     { type:"note_get", name, category, scope }
 *                     { type:"note_save", name, category, scope, body, from?:{ name, category, scope }, version? }
 *                         `from` is the note being edited: only then may an existing file be replaced, and a
 *                         changed name/category/scope is a move. Without `from` an existing name is an error.
 *                         `version` (from `note`/`note_result`) makes the save fail if the note changed on disk since it was loaded
 *                     { type:"note_delete", name, category, scope }
 *   server → browser: { type:"notes", notes:[{ name, category, scope, summary }] }
 *                     { type:"note", name, category, scope, body, version }
 *                     { type:"note_result", ok, deleted?, error?, name?, category?, scope?, version? }   after a save or delete
 */

type Reply = Record<string, unknown>;

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

interface Ref {
  name: string;
  category: string;
  scope: NoteScope;
}

/** The scope a message names; a note always lives in exactly one. */
function scopeArg(value: unknown): NoteScope {
  const scope = scopeOf(value);
  if (!scope) throw new Error("a note's scope must be 'project' or 'global'");
  return scope;
}

function refOf(value: unknown): Ref | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  return {
    name: str(r["name"]),
    category: categoryOf(str(r["category"])),
    scope: scopeArg(r["scope"]),
  };
}

function list(stores: NoteStores): Reply {
  return { type: "notes", notes: listAllNotes(stores) };
}

function failure(error: unknown): Reply[] {
  return [
    {
      type: "note_result",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    },
  ];
}

/** Move a note to another place; across scopes that is a copy and a delete (never over an existing note). */
function relocate(stores: NoteStores, from: Ref, to: Ref): void {
  if (from.scope === to.scope) {
    moveNote(baseOf(stores, from.scope), from, to);
    return;
  }
  const body = readNote(baseOf(stores, from.scope), from.name, from.category);
  if (body === undefined) throw new Error(`note '${from.name}' not found`);
  saveNote(baseOf(stores, to.scope), to.name, body, to.category, false);
  deleteNote(baseOf(stores, from.scope), from.name, from.category);
}

/** Save under `name`/`category`/`scope`, moving the note first when `from` names a different place. */
function save(stores: NoteStores, msg: Record<string, unknown>): Reply[] {
  const name = str(msg["name"]).trim();
  const category = categoryOf(str(msg["category"]));
  if (name === "") return failure(new Error("a note needs a name"));
  try {
    const scope = scopeArg(msg["scope"]);
    // Only a note being edited (`from`) may replace a file; a new note must not clobber one.
    const from = refOf(msg["from"]);
    const loaded = msg["version"];
    if (from && typeof loaded === "number") {
      if (noteVersion(baseOf(stores, from.scope), from) !== loaded) {
        throw new Error(
          "this note changed since you opened it (the model or another tab edited it): select it again to reload",
        );
      }
    }
    const moved =
      from &&
      (from.name !== name ||
        from.category !== category ||
        from.scope !== scope);
    if (from && moved) relocate(stores, from, { name, category, scope });
    const base = baseOf(stores, scope);
    saveNote(base, name, str(msg["body"]), category, from !== undefined);
    return [
      {
        type: "note_result",
        ok: true,
        name,
        category,
        scope,
        version: noteVersion(base, { name, category }),
      },
      list(stores),
    ];
  } catch (error) {
    return failure(error);
  }
}

/**
 * Handle one notes message; null when `msg` is not a notes message. Every
 * failure (invalid or clashing name, missing note) comes back as a
 * `note_result` with `ok: false`.
 */
export function handleNoteMessage(
  stores: NoteStores,
  msg: Record<string, unknown>,
): Reply[] | null {
  const type = msg["type"];
  const name = str(msg["name"]);
  const category = categoryOf(str(msg["category"]));
  try {
    if (type === "notes_list") return [list(stores)];
    if (type === "note_get") {
      const scope = scopeArg(msg["scope"]);
      const base = baseOf(stores, scope);
      const body = readNote(base, name, category);
      if (body === undefined) throw new Error(`note '${name}' not found`);
      return [
        {
          type: "note",
          name,
          category,
          scope,
          body,
          version: noteVersion(base, { name, category }),
        },
      ];
    }
    if (type === "note_save") return save(stores, msg);
    if (type === "note_delete") {
      const scope = scopeArg(msg["scope"]);
      deleteNote(baseOf(stores, scope), name, category);
      return [
        { type: "note_result", ok: true, deleted: true, name, category, scope },
        list(stores),
      ];
    }
  } catch (error) {
    return failure(error);
  }
  return null;
}
