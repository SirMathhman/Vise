import type { Tool } from "../../core/engine.ts";

/** The required `scope` argument of the note tools that act on one note. */
const scopeProperty = {
  type: "string",
  enum: ["project", "global"],
  description:
    "Where the note lives: 'project' (this project only) or 'global' (shared by every project)",
};

/** Note tools (handlers: `notes-tool.ts`). */
export const noteTools: Tool[] = [
  {
    type: "function",
    display: { label: "List notes", icon: "📓" },
    function: {
      name: "list_notes",
      description:
        "List notes grouped by scope and category, with their one-line summaries. Notes are this agent's memory and skills in one store: short facts (what the user told you about themselves, preferences, decisions, things learned) and how-to procedures. Suggested categories: 'user-info', 'memories', 'skills' (any name works). Global notes are shared by every project; project notes belong to this project only. Pass a scope and/or category to list only that group (useful when there are many notes). Use this to see what is known before relying on or writing a note.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["project", "global"],
            description: "Only list this scope (optional; default lists both)",
          },
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
    display: { label: "Read note", icon: "📓" },
    function: {
      name: "read_note",
      description:
        "Read the full body of a note by name. Call list_notes first to see what is available. Pass the category if the name exists in several.",
      parameters: {
        type: "object",
        properties: {
          scope: scopeProperty,
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
        required: ["scope", "name"],
      },
    },
  },
  {
    type: "function",
    display: { label: "Save note", icon: "📝" },
    function: {
      name: "save_note",
      description:
        "Save a note (new, or replacing one of the same name). Notes are the agent's memory and skills in one store: record what you learn about the user, lasting facts and decisions, and how-to procedures worth reusing. Use scope 'global' for what holds across projects (about the user, general skills) and 'project' for what is specific to this project. The first non-empty line of body becomes the note's one-line summary (shown in list_notes); the rest is the body. Saving under an existing name in the same scope and category replaces that note. Give a category to group related notes (suggested: 'user-info', 'memories', 'skills'; any name works and it is created on first use); without one the note goes in the 'default' category.",
      parameters: {
        type: "object",
        properties: {
          scope: scopeProperty,
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
        required: ["scope", "name", "body"],
      },
    },
  },
  {
    type: "function",
    display: { label: "Delete note", icon: "🗑" },
    function: {
      name: "delete_note",
      description: "Delete a note by name. Use with care.",
      parameters: {
        type: "object",
        properties: {
          scope: scopeProperty,
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
        required: ["scope", "name"],
      },
    },
  },
];
