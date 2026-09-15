/**
 * Definitions of the tools the LLM panel exposes to the model. Each entry is
 * the OpenAI tool definition sent with every chat request. Execution happens
 * on the backend (see /api/llm/tool); the panel only forwards the model's
 * calls and renders the results. Adding a tool means adding one definition
 * here and one handler on the backend — neither side hardcodes tool names
 * beyond this shared list.
 */
import type { LlmTool } from "../api/client.js";

/** List the contents of a directory in the workspace (root-scoped). */
const listDirectory: LlmTool = {
  type: "function",
  function: {
    name: "list_directory",
    description:
      'List the files and subdirectories in a directory. Use this to answer questions about what files or folders exist. The path is relative to the workspace root; use an empty string ("") for the root.',
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'Directory path relative to the workspace root. Use "" for the root.',
        },
      },
      required: ["path"],
    },
  },
};

/**
 * Read a range of lines from a file in the workspace (root-scoped). Lines are
 * 1-based: start_line is inclusive, end_line is exclusive. At most 300 lines
 * are returned per call, so long files are read one window at a time.
 */
const readFile: LlmTool = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read a range of lines from a file and return them. Use this to answer questions about a file's content. The path is relative to the workspace root. Lines are 1-based: start_line is inclusive, end_line is exclusive. At most 300 lines are returned per call; to read a long file, call this repeatedly with advancing start_line values.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'File path relative to the workspace root (e.g. "src/main.ts").',
        },
        start_line: {
          type: "number",
          description:
            "First line to read, 1-based and inclusive. Defaults to 1.",
        },
        end_line: {
          type: "number",
          description:
            "Line to stop before, 1-based and exclusive. Defaults to start_line + 300. Must be greater than start_line and within 300 lines of it.",
        },
      },
      required: ["path"],
    },
  },
};

/** All tool definitions available to the model, in a stable order. */
export const llmToolDefinitions: LlmTool[] = [listDirectory, readFile];
