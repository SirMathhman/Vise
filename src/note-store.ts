import { resolve } from "node:path";
import {
  categoryOf,
  deleteNote,
  initNote,
  listNotes,
  moveNote,
  noteVersion,
  readNote,
  saveNote,
  scopeOf,
  type NoteEntry,
  type NoteScope,
  type NoteStores,
} from "./notes.ts";

/** Where one note lives: its scope, category (default when absent) and name. */
export interface NoteId {
  scope: NoteScope;
  category?: string | undefined;
  name: string;
}

/** The scope a tool argument or message field names; throws unless it is exactly `project` or `global`. */
export function requireScope(value: unknown): NoteScope {
  const scope = scopeOf(value);
  if (!scope) throw new Error('\'scope\' is required: "project" or "global"');
  return scope;
}

/**
 * The notes of both scopes behind one interface: every operation takes a
 * `NoteId`, so a caller never pairs a directory with a scope label by hand,
 * and the rule for moving a note between scopes lives here once (the note
 * tools, the `/note` command and the web editor all go through it). The file
 * layout and naming rules stay in `notes.ts`. Operations throw an `Error`
 * with a message fit to show (the callers turn it into their own reply).
 */
export class NoteStore {
  constructor(private readonly stores: NoteStores) {}

  /** The data directory of one scope. */
  private base(scope: NoteScope): string {
    return this.stores[scope];
  }

  /** Whether both scopes are one directory (a session started in the home directory). */
  private get merged(): boolean {
    return resolve(this.stores.project) === resolve(this.stores.global);
  }

  /** The notes of both scopes (project first), or of just `scope`; a merged directory lists once, as global. */
  list(category?: string, scope?: NoteScope): NoteEntry[] {
    const project =
      scope === "global" || this.merged
        ? []
        : listNotes(this.stores.project, category, "project");
    const global =
      scope === "project" && !this.merged
        ? []
        : listNotes(this.stores.global, category, "global");
    return [...project, ...global];
  }

  read(id: NoteId): string | undefined {
    return readNote(this.base(id.scope), id.name, id.category);
  }

  /** Save a note; replaces an existing one only when `overwrite` is set. */
  save(id: NoteId, body: string, overwrite: boolean): "created" | "replaced" {
    return saveNote(this.base(id.scope), id.name, body, id.category, overwrite);
  }

  delete(id: NoteId): void {
    deleteNote(this.base(id.scope), id.name, id.category);
  }

  init(id: NoteId): void {
    initNote(this.base(id.scope), id.name, id.category);
  }

  /** A token that changes whenever the note's file does; undefined when it does not exist. */
  version(id: NoteId): number | undefined {
    return noteVersion(this.base(id.scope), {
      name: id.name,
      category: id.category,
    });
  }

  /**
   * Move or rename a note, possibly to the other scope. Never replaces an
   * existing note. Across scopes it copies and then deletes the original; if
   * the delete fails the copy is removed again, so the note is never in both.
   */
  move(from: NoteId, to: NoteId): void {
    if (from.scope === to.scope || this.merged) {
      moveNote(this.base(from.scope), from, to);
      return;
    }
    const body = this.read(from);
    if (body === undefined) throw new Error(`note '${from.name}' not found`);
    this.save(to, body, false);
    try {
      this.delete(from);
    } catch (error) {
      deleteNote(this.base(to.scope), to.name, categoryOf(to.category));
      throw error;
    }
  }
}
