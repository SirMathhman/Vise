/**
 * A DOM-free store for the editor's auto-save lifecycle. It owns the state that
 * makes "no unsaved edit is ever silently discarded" true — the current buffer
 * (`content`/`rel`), the `dirty` flag, and the debounced save timer — and the
 * save/flush decision logic. The thin DOM controller (`fileTree.ts`) owns the
 * textarea and the save-status span, and feeds them to the store via `setReader`
 * and the `onStatus`/`persist` callbacks, so the store stays free of both DOM
 * and `api/client.ts` and is testable in Node.
 */

/** The autosave debounce window, in milliseconds. */
const AUTOSAVE_MS = 1000;

/** The save-state a controller surfaces in the `.save-status` span. */
export type SaveStatus = "unsaved" | "saving" | "saved" | "error";

/** A store of the editor's buffer and its auto-save lifecycle (DOM-free). */
export interface FileStateStore {
  /** Whether the buffer has unsaved changes (the beforeunload source of truth). */
  isDirty(): boolean;
  /** The relative path of the loaded file, if any. */
  getRel(): string | undefined;
  /** The last persisted buffer contents, if any. */
  getContent(): string | undefined;
  /** Register the current textarea value reader (set on each render). */
  setReader(fn: () => string | undefined): void;
  /** The user has edited: mark the buffer dirty. */
  markDirty(): void;
  /** Begin loading a file: set rel + content, clear any pending save. */
  beginLoad(rel: string, content: string): void;
  /** Force the buffer clean (used after a destructive tree operation). */
  resetDirty(): void;
  /** Clear any pending auto-save timer. */
  clearTimer(): void;
  /** Schedule a debounced auto-save of the current buffer. */
  scheduleSave(): void;
  /**
   * Persist the current buffer. Resolves `true` when the buffer ends clean
   * (saved, or nothing to save) and `false` when a failed save leaves it dirty —
   * so the caller aborts navigation rather than discarding the edit.
   */
  flush(): Promise<boolean>;
  /** Persist the current buffer (the auto-save path). No-op when unchanged. */
  save(): Promise<void>;
}

/**
 * Build the editor's save-state store. `persist` performs the network write
 * (injected so the store stays client-free); `onStatus` renders a save-state
 * (injected so the store stays DOM-free).
 */
export function createFileStateStore(
  persist: (rel: string, value: string) => Promise<void>,
  onStatus: (state: SaveStatus, message?: string) => void
): FileStateStore {
  let rel: string | undefined;
  let content: string | undefined;
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: () => string | undefined = () => undefined;

  const clearTimer = (): void => {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
  };

  return {
    isDirty: () => dirty,
    getRel: () => rel,
    getContent: () => content,
    setReader(fn) {
      reader = fn;
    },
    markDirty() {
      dirty = true;
    },
    beginLoad(newRel, newContent) {
      clearTimer();
      rel = newRel;
      content = newContent;
      dirty = false;
    },
    resetDirty() {
      dirty = false;
    },
    clearTimer,
    scheduleSave() {
      clearTimer();
      saveTimer = setTimeout(() => {
        saveTimer = undefined;
        void this.save();
      }, AUTOSAVE_MS);
    },
    async flush() {
      clearTimer();
      if (!dirty || !rel) return !dirty;
      const next = reader();
      if (next === undefined) return !dirty;
      try {
        await persist(rel, next);
        content = next;
        dirty = false;
        return true;
      } catch (err) {
        // Keep dirty so the caller aborts and beforeunload fires; surface the
        // failure so the user knows why navigation is blocked.
        onStatus("error", (err as Error).message);
        return !dirty;
      }
    },
    async save() {
      clearTimer();
      if (!rel) return;
      const next = reader();
      if (next === undefined) return;
      if (next === (content ?? "")) {
        dirty = false;
        onStatus("saved");
        return;
      }
      onStatus("saving");
      try {
        await persist(rel, next);
        content = next;
        dirty = false;
        onStatus("saved");
      } catch (err) {
        dirty = true;
        onStatus("error", (err as Error).message);
      }
    },
  };
}
