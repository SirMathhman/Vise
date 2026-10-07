import type { Tool } from "../../core/engine.ts";

/** Project-note tools (handlers: `notes-tool.ts`). */
export const noteTools: Tool[] = [
  {
    type: "function",
    function: {
      name: "list_notes",
      description:
        "List all notes with their one-line summaries. Notes are short facts or how-to procedures stored for this project. Use this to see what is known before relying on or writing a note.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description:
        "Read the full body of a note by name. Call list_notes first to see what is available.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the note to read",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_note",
      description:
        "Save a new note for this project. The first non-empty line of body becomes the note's one-line summary (shown in list_notes); the rest is the body. Note names must be unique.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Short unique name for the note (becomes the filename)",
          },
          body: {
            type: "string",
            description:
              "Note contents. The first non-empty line is its summary.",
          },
        },
        required: ["name", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_note",
      description: "Delete a note by name. Use with care.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the note to delete",
          },
        },
        required: ["name"],
      },
    },
  },
];
