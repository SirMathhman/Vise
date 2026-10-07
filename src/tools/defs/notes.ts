import type { Tool } from "../../core/engine.ts";

/** Project-note tools (handlers: `notes-tool.ts`). */
export const noteTools: Tool[] = [
  {
    type: "function",
    function: {
      name: "list_notes",
      description:
        "List notes grouped by category, with their one-line summaries. Notes are short facts or how-to procedures stored for this project. Pass a category to list only that group (useful when there are many notes). Use this to see what is known before relying on or writing a note.",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description:
              "Only list this category (optional; default lists every category)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_note",
      description:
        "Read the full body of a note by name. Call list_notes first to see what is available. Pass the category if the name exists in several.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the note to read",
          },
          category: {
            type: "string",
            description:
              "Category of the note (optional; default category first, otherwise the only one containing it)",
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
        "Save a note for this project (new, or replacing one of the same name). The first non-empty line of body becomes the note's one-line summary (shown in list_notes); the rest is the body. Saving under an existing name in the same category replaces that note. Give a category to group related notes (any name; it is created on first use); without one the note goes in the 'default' category.",
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
          category: {
            type: "string",
            description:
              "Category to file the note under (optional; default: 'default')",
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
          category: {
            type: "string",
            description:
              "Category of the note (optional; needed only if the name exists in several)",
          },
        },
        required: ["name"],
      },
    },
  },
];
