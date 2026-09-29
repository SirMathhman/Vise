import type { Tool, ToolRunner } from "./core/engine.ts";
import {
  createFile,
  deleteDirectory,
  deleteFile,
  editFile,
  findFiles,
  listDirectory,
  readFile,
  searchFiles,
} from "./tools/files.ts";
import { runPowershell } from "./tools/shell.ts";
import {
  deleteNoteTool,
  listNotesTool,
  readNoteTool,
  saveNoteTool,
} from "./tools/notes-tool.ts";

/** Tool definitions exposed to the model. */
export const tools: Tool[] = [
  {
    type: "function",
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
    function: {
      name: "read_file",
      description: "Read the full contents of a file from a given path",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path of the file to read",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
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
    function: {
      name: "run_powershell",
      description:
        "Run a PowerShell command and return its combined stdout/stderr output. Runs in the current working directory.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The PowerShell command to run",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
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

/** Edge-provided tool implementations. All I/O is in the modules imported
 * above; the core only depends on the ToolRunner type.
 */

const toolHandlers: Record<
  string,
  (args: Record<string, unknown>) => string | Promise<string>
> = {
  list_directory: listDirectory,
  read_file: readFile,
  create_file: createFile,
  edit_file: editFile,
  delete_file: deleteFile,
  delete_directory: deleteDirectory,
  run_powershell: runPowershell,
  find_files: findFiles,
  search_files: searchFiles,
  list_notes: listNotesTool,
  read_note: readNoteTool,
  save_note: saveNoteTool,
  delete_note: deleteNoteTool,
};

export const toolRunner: ToolRunner = {
  async run(name, args): Promise<string> {
    const handler = toolHandlers[name];
    if (handler === undefined) {
      return `error: unknown tool ${name}`;
    }
    return handler(args);
  },
};
