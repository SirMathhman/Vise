import type { Approval } from "../chat/approvals";
import type { Note, NoteInput } from "common";
import { NoteInputSchema, describeParseError, parseJson } from "common";
import { z } from "zod";
import {
  createNote,
  deleteNote,
  describeNoteError,
  getNote,
  listNotes,
  updateNote,
} from "./notes-store";

// The four note tools. Creating a note runs at once. Overwriting or deleting one returns an
// approval, so the user sees the change before it is made.

const IdArgumentsSchema = z.object({ id: z.string().min(1) });

const SaveArgumentsSchema = NoteInputSchema.extend({
  id: z.string().min(1).optional(),
});

// A note as the list tool shows it: everything but the content, which read_note returns.
function summaryOf(note: Note): Omit<Note, "content"> {
  return {
    id: note.id,
    name: note.name,
    category: note.category,
    summary: note.summary,
  };
}

// A note's fields as the approval card shows them.
function fieldsText(fields: NoteInput): string {
  return [
    `name: ${fields.name}`,
    `category: ${fields.category}`,
    `summary: ${fields.summary}`,
    "content:",
    fields.content,
  ].join("\n");
}

/**
 * The name the model uses to call the list-notes tool.
 */
export const LIST_NOTES_NAME = "list_notes";

/**
 * The tool the model may call to list notes without their content.
 */
export const LIST_NOTES_TOOL = {
  type: "function" as const,
  function: {
    name: LIST_NOTES_NAME,
    description:
      "List every note as JSON with its id, name, category, and summary. The content is not included; use read_note for it. Takes no arguments.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

/**
 * Lists the notes without their content.
 *
 * @returns The notes as JSON text, or a failure message.
 */
export async function runListNotes(): Promise<string> {
  const notes = await listNotes();
  if (!notes.ok) {
    return describeNoteError(notes.error);
  }
  return JSON.stringify(notes.value.map(summaryOf), null, 2);
}

/**
 * The name the model uses to call the read-note tool.
 */
export const READ_NOTE_NAME = "read_note";

/**
 * The tool the model may call to read one note, content included.
 */
export const READ_NOTE_TOOL = {
  type: "function" as const,
  function: {
    name: READ_NOTE_NAME,
    description:
      "Read one note by its id from list_notes, including its content.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The note's id." },
      },
      required: ["id"],
    },
  },
};

/**
 * Reads one note.
 *
 * @param argumentsJson The model's arguments: the note's id.
 * @returns The note as JSON text, or a failure message.
 */
export async function runReadNote(argumentsJson: string): Promise<string> {
  const args = parseJson(IdArgumentsSchema, argumentsJson);
  if (!args.ok) {
    return `Invalid arguments: ${describeParseError(args.error)}`;
  }
  const note = await getNote(args.value.id);
  return note.ok
    ? JSON.stringify(note.value, null, 2)
    : describeNoteError(note.error);
}

/**
 * The name the model uses to call the save-note tool.
 */
export const SAVE_NOTE_NAME = "save_note";

/**
 * The tool the model may call to create a note, or to update one when it gives an id.
 */
export const SAVE_NOTE_TOOL = {
  type: "function" as const,
  function: {
    name: SAVE_NOTE_NAME,
    description:
      "Save a note. Without an id it creates a new note. With an id from list_notes it replaces that note's fields, after the user approves the change. Names must be unique, ignoring case.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The id of the note to update. Omit to create one.",
        },
        name: { type: "string", description: "The note's name." },
        category: {
          type: "string",
          description: "The note's category, such as idea or todo.",
        },
        summary: { type: "string", description: "A short summary." },
        content: { type: "string", description: "The note's full text." },
      },
      required: ["name", "category", "summary", "content"],
    },
  },
};

/**
 * Creates a note at once. An update returns an approval showing the change; the update runs
 * only if the user approves it.
 *
 * @param argumentsJson The model's arguments: the note's fields, and an id to update.
 * @returns The saved note as JSON text, an approval for an update, or a failure message.
 */
export async function runSaveNote(
  argumentsJson: string,
): Promise<string | Approval> {
  const args = parseJson(SaveArgumentsSchema, argumentsJson);
  if (!args.ok) {
    return `Invalid arguments: ${describeParseError(args.error)}`;
  }
  const { id, ...fields } = args.value;
  const input: NoteInput = fields;
  if (id === undefined) {
    const created = await createNote(input);
    return created.ok
      ? JSON.stringify(created.value, null, 2)
      : describeNoteError(created.error);
  }
  const current = await getNote(id);
  if (!current.ok) {
    return describeNoteError(current.error);
  }
  return {
    title: `Update note "${current.value.name}"`,
    body: `Current:\n${fieldsText(current.value)}\n\nNew:\n${fieldsText(input)}`,
    apply: async () => {
      const saved = await updateNote(id, input);
      return saved.ok
        ? JSON.stringify(saved.value, null, 2)
        : describeNoteError(saved.error);
    },
  };
}

/**
 * The name the model uses to call the delete-note tool.
 */
export const DELETE_NOTE_NAME = "delete_note";

/**
 * The tool the model may call to delete a note, after the user approves it. The deletion is
 * permanent.
 */
export const DELETE_NOTE_TOOL = {
  type: "function" as const,
  function: {
    name: DELETE_NOTE_NAME,
    description:
      "Delete one note by its id from list_notes, after the user approves the deletion. The deletion is permanent.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The note's id." },
      },
      required: ["id"],
    },
  },
};

/**
 * Proposes deleting one note. The deletion runs only if the user approves it.
 *
 * @param argumentsJson The model's arguments: the note's id.
 * @returns An approval showing the note, or a failure message.
 */
export async function runDeleteNote(
  argumentsJson: string,
): Promise<string | Approval> {
  const args = parseJson(IdArgumentsSchema, argumentsJson);
  if (!args.ok) {
    return `Invalid arguments: ${describeParseError(args.error)}`;
  }
  const { id } = args.value;
  const current = await getNote(id);
  if (!current.ok) {
    return describeNoteError(current.error);
  }
  return {
    title: `Delete note "${current.value.name}"`,
    body: `${fieldsText(current.value)}\n\nThis cannot be undone.`,
    apply: async () => {
      const removed = await deleteNote(id);
      return removed.ok
        ? `Deleted note "${removed.value.name}".`
        : describeNoteError(removed.error);
    },
  };
}
