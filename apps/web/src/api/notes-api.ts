import { NoteStore, requireScope, type NoteId } from "../../stores/note-store.ts";
import { categoryOf } from "../../stores/notes.ts";
import { failedResult, str, type Reply } from "./wire/reply.ts";

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


function refOf(value: unknown): NoteId | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  return {
    name: str(r["name"]),
    category: categoryOf(str(r["category"])),
    scope: requireScope(r["scope"]),
  };
}

function list(store: NoteStore): Reply {
  return { type: "notes", notes: store.list() };
}

const failure = (error: unknown): Reply[] => failedResult("note_result", error);

/** Save under `name`/`category`/`scope`, moving the note first when `from` names a different place. */
function save(store: NoteStore, msg: Record<string, unknown>): Reply[] {
  const name = str(msg["name"]).trim();
  const category = categoryOf(str(msg["category"]));
  if (name === "") return failure(new Error("a note needs a name"));
  try {
    const id: NoteId = { name, category, scope: requireScope(msg["scope"]) };
    // Only a note being edited (`from`) may replace a file; a new note must not clobber one.
    const from = refOf(msg["from"]);
    const loaded = msg["version"];
    if (from && typeof loaded === "number" && store.version(from) !== loaded) {
      throw new Error(
        "this note changed since you opened it (the model or another tab edited it): select it again to reload",
      );
    }
    const moved =
      from &&
      (from.name !== name ||
        from.category !== category ||
        from.scope !== id.scope);
    if (from && moved) store.move(from, id);
    store.save(id, str(msg["body"]), from !== undefined);
    return [
      { type: "note_result", ok: true, ...id, version: store.version(id) },
      list(store),
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
  store: NoteStore,
  msg: Record<string, unknown>,
): Reply[] | null {
  const type = msg["type"];
  if (type === "notes_list") return [list(store)];
  if (type === "note_save") return save(store, msg);
  if (type !== "note_get" && type !== "note_delete") return null;
  try {
    const id: NoteId = {
      name: str(msg["name"]),
      category: categoryOf(str(msg["category"])),
      scope: requireScope(msg["scope"]),
    };
    if (type === "note_get") {
      const body = store.read(id);
      if (body === undefined) throw new Error(`note '${id.name}' not found`);
      return [{ type: "note", ...id, body, version: store.version(id) }];
    }
    store.delete(id);
    return [
      { type: "note_result", ok: true, deleted: true, ...id },
      list(store),
    ];
  } catch (error) {
    return failure(error);
  }
}
