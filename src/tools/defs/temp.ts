import type { Tool } from "../../core/engine.ts";

/**
 * Temp-file tools (handlers: `temp-store.ts`). A tool result that is too large
 * to show is saved to a temporary file; these read and search those files, and
 * work in every session, including ones with no working directory.
 */
export const tempTools: Tool[] = [
  {
    type: "function",
    display: { label: "Read saved output", icon: "🗃" },
    function: {
      name: "read_temp",
      description:
        "Read part of a saved temp file (a tool result that was too large to show). Returns up to 250 lines starting at `offset`, and says how many lines remain. Use it to page through a big result.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the temp file, as given in the result",
          },
          offset: {
            type: "integer",
            description: "Line to start at, counting from 1. Default 1.",
          },
          limit: {
            type: "integer",
            description: "How many lines to read, at most 250. Default 250.",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    display: { label: "Search saved output", icon: "🗃" },
    function: {
      name: "search_temp",
      description:
        "Search saved temp files (tool results that were too large to show) for lines matching a JavaScript regular expression (no inline flags such as (?i); use ignore_case). Returns matching lines as name:line: text, at most 100. Searches every temp file unless a name is given. Prefer this to reading a whole big result.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Regular expression to match against each line",
          },
          name: {
            type: "string",
            description: "Only search this temp file (optional)",
          },
          ignore_case: {
            type: "boolean",
            description: "Match case-insensitively. Default false.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    display: { label: "List saved output", icon: "🗃" },
    function: {
      name: "list_temp",
      description:
        "List the saved temp files (large tool results) with their length and the tool each came from.",
      parameters: { type: "object", properties: {} },
    },
  },
];
