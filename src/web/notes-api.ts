import {
  categoryOf,
  deleteNote,
  listNotes,
  moveNote,
  noteVersion,
  readNote,
  saveNote,
} from "../notes.ts";

/**
 * The web UI's notes editor. It talks to the same `.vise/notes/` store as the
 * model's note tools and the `/note` command, directly (never through a model
 * turn). Wire protocol (JSON):
 *   browser → server: { type:"notes_list" }
 *                     { type:"note_get", name, category }
 *                     { type:"note_save", name, category, body, from?:{ name, category }, version? }
 *                         `from` is the note being edited: only then may an existing file be replaced, and a
 *                         changed name/category is a move. Without `from` an existing name is an error.
 *                         `version` (from `note`/`note_result`) makes the save fail if the note changed on disk since it was loaded
 *                     { type:"note_delete", name, category }
 *   server → browser: { type:"notes", notes:[{ name, category, summary }] }
 *                     { type:"note", name, category, body, version }
 *                     { type:"note_result", ok, deleted?, error?, name?, category?, version? }   after a save or delete
 */

type Reply = Record<string, unknown>;

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

function refOf(value: unknown): { name: string; category: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  return { name: str(r["name"]), category: categoryOf(str(r["category"])) };
}

function list(dataDir: string): Reply {
  return { type: "notes", notes: listNotes(dataDir) };
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

/** Save under `name`/`category`, moving the note first when `from` names a different place. */
function save(dataDir: string, msg: Record<string, unknown>): Reply[] {
  const name = str(msg["name"]).trim();
  const category = categoryOf(str(msg["category"]));
  if (name === "") return failure(new Error("a note needs a name"));
  try {
    // Only a note being edited (`from`) may replace a file; a new note must not clobber one.
    const from = refOf(msg["from"]);
    const loaded = msg["version"];
    if (from && typeof loaded === "number") {
      if (noteVersion(dataDir, from) !== loaded) {
        throw new Error(
          "this note changed since you opened it (the model or another tab edited it): select it again to reload",
        );
      }
    }
    if (from && (from.name !== name || from.category !== category)) {
      moveNote(dataDir, from, { name, category });
    }
    saveNote(dataDir, name, str(msg["body"]), category, from !== undefined);
  } catch (error) {
    return failure(error);
  }
  return [
    {
      type: "note_result",
      ok: true,
      name,
      category,
      version: noteVersion(dataDir, { name, category }),
    },
    list(dataDir),
  ];
}

/**
 * Handle one notes message; null when `msg` is not a notes message. Every
 * failure (invalid or clashing name, missing note) comes back as a
 * `note_result` with `ok: false`.
 */
export function handleNoteMessage(
  dataDir: string,
  msg: Record<string, unknown>,
): Reply[] | null {
  const type = msg["type"];
  const name = str(msg["name"]);
  const category = categoryOf(str(msg["category"]));
  try {
    if (type === "notes_list") return [list(dataDir)];
    if (type === "note_get") {
      const body = readNote(dataDir, name, category);
      if (body === undefined) throw new Error(`note '${name}' not found`);
      return [
        {
          type: "note",
          name,
          category,
          body,
          version: noteVersion(dataDir, { name, category }),
        },
      ];
    }
    if (type === "note_save") return save(dataDir, msg);
    if (type === "note_delete") {
      deleteNote(dataDir, name, category);
      return [
        { type: "note_result", ok: true, deleted: true, name, category },
        list(dataDir),
      ];
    }
  } catch (error) {
    return failure(error);
  }
  return null;
}
