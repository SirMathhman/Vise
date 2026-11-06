import { parseNoteCommand, type NoteRunner } from "../../core/notes.ts";
import { createNote } from "./create-note.ts";
import { listNotes } from "./list-notes.ts";

// The /note command for a working directory. The text it returns is what the REPL prints.
export function runNoteCommand(root: string): NoteRunner {
  return async (words) => {
    const command = parseNoteCommand(words);
    if (!command.ok) return `error: ${command.error.message}`;
    const result =
      command.value.kind === "new"
        ? await createNote(root, command.value.category, command.value.name)
        : await listNotes(root, command.value.category);
    return result.ok ? result.value : `error: ${result.error.message}`;
  };
}
