// The tool registry and dispatch. Composes schemas and handler functions
// from submodules. No fetch, no stdin/stdout.
import type { Config } from "./config.ts";
import type { Tool } from "./llm/types.ts";
import {
  create_directory,
  create_file,
  edit_file,
  list_directory,
  read_file,
} from "./tools/fs.ts";
import type { ProcessTracker } from "./tools/process.ts";
import {
  kill_process,
  run_powershell,
  wait_for_process,
} from "./tools/process.ts";
import { find_files, search_content } from "./tools/search.ts";
import { run_subagent } from "./tools/subagent.ts";

// Per-call context handed to every tool handler. Carries the state a tool
// needs beyond its arguments: the active model (read at call time, not
// captured at startup), the shared background-process tracker, the
// subagent nesting depth, and the config + tool set + dispatch function a
// subagent needs to spawn its own tools. Passed by reference so the
// /model command's runtime switch is visible to every handler in flight.
export type ToolContext = {
  config: Config;
  model: string;
  tracker: ProcessTracker;
  depth: number;
  tools: Tool[];
  dispatch: (
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<string>;
};

// The tool schemas sent to the model in the request's `tools` field.
export const tools: Tool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file. The path is resolved relative to the working directory. Returns the file's text content, or an error message if the file cannot be read. Optionally, startLine and endLine (1-based, inclusive) limit which lines are returned. At most 500 lines are returned; if the range exceeds this, it is capped.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to read.",
          },
          startLine: {
            type: "number",
            description:
              "The 1-based line number to start reading from. Defaults to 1.",
          },
          endLine: {
            type: "number",
            description:
              "The 1-based inclusive line number to stop at. Defaults to the last line. Capped at startLine + 499 (500 lines max).",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit a file by replacing the first occurrence of replacee with replacement. The path is resolved relative to the working directory. The file must already exist. If replacee is not found, no change is made and an error is returned. Only the first occurrence is replaced.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to edit.",
          },
          replacee: {
            type: "string",
            description:
              "The exact text to find. It must match exactly, including whitespace and indentation.",
          },
          replacement: {
            type: "string",
            description: "The exact text to replace it with.",
          },
        },
        required: ["path", "replacee", "replacement"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description:
        "Create a new file with the given content. The path is resolved relative to the working directory. Parent directories are created if they do not exist. If the file already exists, an error is returned and the file is unchanged.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the file to create.",
          },
          content: {
            type: "string",
            description: "The content to write to the file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_directory",
      description:
        "Create a new directory. The path is resolved relative to the working directory. Parent directories are created if they do not exist. If the directory already exists, an error is returned.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "The path to the directory to create.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List the contents of a directory as an indented tree. The path is resolved relative to the working directory. The depth parameter controls how many levels deep to recurse. Returns file and directory names with their relative paths.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "The path to the directory to list. Defaults to the current working directory.",
          },
          depth: {
            type: "number",
            description:
              "How many levels deep to recurse. Defaults to 1. Capped at 5.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description:
        "Search for files whose names match a pattern. Recursively searches under the path (default the working directory), skipping node_modules and .git. The pattern is a case-insensitive glob where * matches any run of characters. Returns matching file paths relative to the working directory.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              'The filename pattern to match, e.g. "*.ts" or "config".',
          },
          path: {
            type: "string",
            description:
              "Directory to search under. Defaults to the working directory.",
          },
          maxResults: {
            type: "number",
            description:
              "Maximum number of matches to return. Defaults to 100.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_content",
      description:
        "Search for a text pattern in file contents. Searches the path (a directory searched recursively, or a single file), skipping node_modules and .git. Returns matching lines with their file path and line number. Case-insensitive by default.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "The text to search for.",
          },
          path: {
            type: "string",
            description:
              "Directory to search under, or a single file. Defaults to the working directory.",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of matches to return. Defaults to 50.",
          },
          caseSensitive: {
            type: "boolean",
            description:
              "Whether matching is case-sensitive. Defaults to false.",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_subagent",
      description:
        "Delegate a task to a subagent, which runs an isolated conversation seeded with the named profile's instructions. The subagent has full tool access and can spawn its own subagents. Returns the subagent's final answer as a string. Use this to hand off a self-contained task to a specialized persona (profile).",
      parameters: {
        type: "object",
        properties: {
          profile: {
            type: "string",
            description:
              "The name of the profile to run the subagent as. The profile's instruction becomes the subagent's system message.",
          },
          task: {
            type: "string",
            description:
              "The task to hand to the subagent. The subagent sees only this text plus its profile instruction; it does not see the parent conversation.",
          },
        },
        required: ["profile", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_powershell",
      description:
        "Run a PowerShell command. If the command does not finish within the timeout, the process is kept running in the background and a process ID is returned. Use wait_for_process or kill_process to manage it.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The PowerShell command or script to execute.",
          },
          timeout: {
            type: "number",
            description:
              "How long (in seconds) to wait for the command to finish before returning control. The process is not killed when this elapses.",
          },
        },
        required: ["command", "timeout"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_for_process",
      description:
        "Wait for a background process to finish. Returns its output if it has finished, or a message saying it is still running if the timeout elapses.",
      parameters: {
        type: "object",
        properties: {
          process_id: {
            type: "string",
            description: "The ID of the process returned by run_powershell.",
          },
          timeout: {
            type: "number",
            description: "How long (in seconds) to wait.",
          },
        },
        required: ["process_id", "timeout"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_process",
      description:
        "Kill a background process that was started by run_powershell. Returns any output collected so far.",
      parameters: {
        type: "object",
        properties: {
          process_id: {
            type: "string",
            description: "The ID of the process returned by run_powershell.",
          },
        },
        required: ["process_id"],
      },
    },
  },
];

// Per-tool dispatch table. Each handler is imported from its submodule.
// Adding a tool means adding one schema to `tools` above and one entry here.
const handlers: Record<
  string,
  (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
> = {
  read_file,
  edit_file,
  create_file,
  create_directory,
  list_directory,
  find_files,
  search_content,
  run_powershell,
  wait_for_process,
  kill_process,
  run_subagent,
};

// Dispatches a tool call by name. Adding a tool means adding one entry to
// the `handlers` table and one schema to `tools` — no edit to this function.
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const handler = handlers[name];
  return handler ? handler(args, ctx) : `Unknown tool: ${name}`;
}
