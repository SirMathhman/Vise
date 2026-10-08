import type { Tool } from "../../core/engine.ts";

/** File-system tools (handlers: `files.ts`). */
export const fileTools: Tool[] = [
  {
    type: "function",
    display: { label: "List folder", icon: "📂" },
    function: {
      name: "list_directory",
      description: "List the files and directories in a given path",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to list (default '.')",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    display: { label: "Read file", icon: "📄" },
    function: {
      name: "read_file",
      description:
        "Read a file from a given path. A small file is returned whole. A file over 250 lines (or about 20,000 characters) is returned as its first 250 lines with a note saying how many remain; pass `offset` (and optionally `limit`) to read further, or use search_files to find what you need.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to read",
          },
          offset: {
            type: "integer",
            description: "Line to start at, counting from 1 (optional)",
          },
          limit: {
            type: "integer",
            description: "How many lines to read, at most 250 (optional)",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    display: { label: "Create file", icon: "🆕" },
    function: {
      name: "create_file",
      description:
        "Create a new file at the given path with the given contents. Parent directories are created as needed. Fails if the file already exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to create",
          },
          content: {
            type: "string",
            description: "Contents to write to the file. May be empty.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    display: { label: "Edit file", icon: "📝" },
    function: {
      name: "edit_file",
      description:
        "Replace the exact (unique) occurrence of old_string in a file with new_string. The file can be of arbitrary length; only the changed portion is provided, so the whole file need not be reproduced. old_string must match exactly once.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to edit",
          },
          old_string: {
            type: "string",
            description:
              "Exact literal text to find and replace. Must appear exactly once and must not be empty.",
          },
          new_string: {
            type: "string",
            description:
              "Exact literal text to replace old_string with. May be empty to delete.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    display: { label: "Delete file", icon: "🗑" },
    function: {
      name: "delete_file",
      description: "Delete the file at the given path",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to delete",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    display: { label: "Delete folder", icon: "🗑" },
    function: {
      name: "delete_directory",
      description:
        "Delete the directory at the given path and everything inside it",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the directory to delete",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    display: { label: "Find files", icon: "🔎" },
    function: {
      name: "find_files",
      description:
        "Find files by name using a regular expression. Recursively searches the given directory (default '.') and returns the relative paths of every file whose name matches the regex. Returns an empty list when nothing matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "JavaScript regular expression to match file names against (e.g. '^test.*\\.ts$').",
          },
          root: {
            type: "string",
            description:
              "Directory to search from (default '.'). Traversed recursively.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    display: { label: "Search in files", icon: "🔎" },
    function: {
      name: "search_files",
      description:
        "Search file contents for a regular expression. The path may be a file (searched alone) or a directory (searched recursively). Returns one line per match, in the form '<path>:<line number>: <matching line>'. Returns 'no matches' when nothing matches.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "JavaScript regular expression to match against each line of file contents (e.g. 'TODO|FIXME').",
          },
          path: {
            type: "string",
            description:
              "A file or directory to search (default '.'). Directories are searched recursively.",
          },
        },
        required: ["pattern"],
      },
    },
  },
];
