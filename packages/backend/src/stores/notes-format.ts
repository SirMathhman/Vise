import type { NoteEntry } from "./notes.ts";

/** Presentation of listed notes (the store and its file layout are in `notes.ts`). */

/**
 * Render one listed note as its presentation line: `<name> — <summary>`.
 */
export function formatNoteEntry(e: NoteEntry): string {
  return `${e.name} — ${e.summary}`;
}

/**
 * Render notes grouped by category (in the order given): a heading with the
 * note count, then one indented line per note. Shared by the `list_notes`
 * tool, the `/note` command and the startup message.
 */
export function formatNotes(entries: NoteEntry[]): string {
  return formatNotesWithin(entries, Number.POSITIVE_INFINITY);
}

/**
 * Like `formatNotes`, but lists at most `maxNotes` notes in total (in group
 * order); every category still gets its heading and count, and the rest are
 * summarised as a pointer to `list_notes`. Bounds the startup message however
 * many notes there are.
 */
export function formatNotesWithin(entries: NoteEntry[], maxNotes: number): string {
  const groups = new Map<string, NoteEntry[]>();
  for (const e of entries) {
    const key = `${e.scope}/${e.category}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  let left = maxNotes;
  const out: string[] = [];
  for (const [heading, notes] of groups) {
    out.push(`${heading} (${notes.length})`);
    for (const n of notes.slice(0, left)) {
      out.push(`  ${formatNoteEntry(n)}`);
    }
    const hidden = notes.length - Math.min(notes.length, left);
    left = Math.max(0, left - notes.length);
    if (hidden > 0) {
      const { scope, category } = notes[0]!;
      out.push(`  ... ${hidden} more: list_notes with scope '${scope}' and category '${category}'`);
    }
  }
  return out.join("\n");
}
