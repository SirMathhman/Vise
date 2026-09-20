/**
 * Definitions of the tools the LLM panel exposes to the model. Each entry is
 * the OpenAI tool definition sent with every chat request. Execution happens
 * on the backend (see /api/llm/tool); the panel only forwards the model's
 * calls and renders the results. Adding a tool means adding one definition
 * here and one handler on the backend — neither side hardcodes tool names
 * beyond this shared list.
 */
import type { LlmToolName } from "@vise/shared";
import type { LlmTool } from "../api/client.js";
import { browserToolDefinitions } from "./browserTools.js";

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

/**
 * Replace a range of lines in an existing file in the workspace (root-scoped).
 * Lines are 1-based: start_line is inclusive, end_line is exclusive. When
 * end_line equals start_line, the content is inserted before that line without
 * deleting anything. The target must be an existing, non-binary text file.
 */
const editFile: LlmTool = {
  type: "function",
  function: {
    name: "edit_file",
    description:
      "Replace a range of lines in an existing file. The path is relative to the workspace root. Lines are 1-based: start_line is inclusive, end_line is exclusive. To insert lines without deleting any, set end_line equal to start_line. To append to the end, set end_line past the file's last line. The target must already exist and be a text file. Use this to modify existing content; use create_file for new files.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'File path relative to the workspace root (e.g. "src/main.ts"). Must already exist.',
        },
        start_line: {
          type: "number",
          description:
            "First line to replace, 1-based and inclusive. Defaults to 1.",
        },
        end_line: {
          type: "number",
          description:
            "Line to stop before, 1-based and exclusive. Must be >= start_line. To insert, set it equal to start_line; to append, set it past the last line. Must be within 300 lines of start_line.",
        },
        content: {
          type: "string",
          description:
            "The text that replaces the lines in the range. An empty string deletes the range.",
        },
      },
      required: ["path", "content"],
    },
  },
};

/**
 * Create a directory in the workspace (root-scoped). The parent directory
 * must already exist; the path is relative to the workspace root.
 */
const createDirectory: LlmTool = {
  type: "function",
  function: {
    name: "create_directory",
    description:
      "Create a new directory in the workspace. Use this to make a folder for new files. The path is relative to the workspace root; the parent directory must already exist.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'Directory path relative to the workspace root (e.g. "src/utils"). The parent must already exist.',
        },
      },
      required: ["path"],
    },
  },
};

/**
 * Create a file in the workspace (root-scoped). The parent directory must
 * already exist; the path is relative to the workspace root.
 */
const createFile: LlmTool = {
  type: "function",
  function: {
    name: "create_file",
    description:
      "Create a new file with the given content. Use this to write new source files, configs, notes, etc. The path is relative to the workspace root; the parent directory must already exist.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'File path relative to the workspace root (e.g. "src/utils.ts"). The parent directory must already exist.',
        },
        content: {
          type: "string",
          description:
            "The full content to write to the file. Defaults to an empty string.",
        },
      },
      required: ["path"],
    },
  },
};

/**
 * Delete a file in the workspace (root-scoped). The path is relative to the
 * workspace root. This is permanent and cannot be undone.
 */
const deleteFile: LlmTool = {
  type: "function",
  function: {
    name: "delete_file",
    description:
      "Delete a file in the workspace. The path is relative to the workspace root. This is permanent and cannot be undone; only use it when the user has explicitly asked to delete a file.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'File path relative to the workspace root (e.g. "src/old.ts"). Must be an existing file.',
        },
      },
      required: ["path"],
    },
  },
};

/**
 * Delete a directory and its entire contents in the workspace (root-scoped).
 * The path is relative to the workspace root. This is permanent and cannot be
 * undone.
 */
const deleteDirectory: LlmTool = {
  type: "function",
  function: {
    name: "delete_directory",
    description:
      "Delete a directory and everything inside it. The path is relative to the workspace root. This is permanent and cannot be undone; only use it when the user has explicitly asked to delete a directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'Directory path relative to the workspace root (e.g. "src/old"). Must be an existing directory.',
        },
      },
      required: ["path"],
    },
  },
};

/**
 * Run a PowerShell command in the workspace root (root-scoped). The command's
 * output and exit status are returned as text. Use for builds, git, typecheck,
 * package installs, and other shell operations that file tools can't do.
 */
const runCommand: LlmTool = {
  type: "function",
  function: {
    name: "run_command",
    description:
      "Run a PowerShell command in the workspace root and return its combined output and exit status. Use this for builds, git, typecheck, package installs, and other shell operations that the file tools cannot do. The command runs non-interactively with a 30-second timeout; if it hangs or exceeds the timeout it is reported as timed out. Prefer read-only commands first (e.g. git status, pnpm typecheck) before making changes.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            'The PowerShell command to run (e.g. "pnpm typecheck" or "git status"). Runs in the workspace root.',
        },
      },
      required: ["command"],
    },
  },
};

/**
 * Search for file names matching a regular expression across the workspace,
 * excluding files and directories git ignores. Matches the file's base name
 * (the file name without its directory).
 */
const findFiles: LlmTool = {
  type: "function",
  function: {
    name: "find_files",
    description:
      "Search for file names that match a regular expression, across the whole workspace, excluding files and directories that git ignores (anything in .gitignore, nested .gitignore files, or .git/info/exclude). The pattern is matched against each file's base name (the file name without its directory). Use this to find files by name without listing every directory first.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            'A regular expression matched against each file\'s base name (e.g. ".*\\.test\\.ts$" to find test files).',
        },
      },
      required: ["pattern"],
    },
  },
};

/**
 * Search the text content of files for a regular expression, across the
 * whole workspace, excluding files and directories git ignores. Unlike
 * find_files (which matches file *names*), this matches each line of a
 * file's *content*. Binary and oversized files are skipped.
 */
const searchFiles: LlmTool = {
  type: "function",
  function: {
    name: "search_files",
    description:
      "Search the text content of files for a regular expression, across the whole workspace, excluding files and directories that git ignores (anything in .gitignore, nested .gitignore files, or .git/info/exclude). Unlike find_files, which matches file names, this matches each line of a file's content and returns every matching line with its file path and line number. Binary files and files over the size cap are skipped. Use this to find where a symbol, string, or pattern occurs before reading the surrounding lines with read_file.",
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description:
            'A regular expression matched against each line\'s text (e.g. "function\\s+runTurn" to find a function definition).',
        },
      },
      required: ["pattern"],
    },
  },
};

/**
 * Delegate a self-contained sub-task to an independent helper agent. Handled
 * entirely client-side (see components/llm.ts's runSubagent): the panel runs
 * a nested tool-calling loop with its own message history (just the task, not
 * this conversation) under the named profile passed in `profile` (its system
 * prompt, tool allowlist, and hooks — see components/profiles.ts). A
 * subagent cannot spawn further subagents.
 */
const createSubagent: LlmTool = {
  type: "function",
  function: {
    name: "create_subagent",
    description:
      'Delegate a self-contained sub-task to an independent helper agent. The helper does not see this conversation — only the task description you give it — and works through it under the profile named by the required `profile` argument (that profile\'s own system prompt, tool allowlist, and hooks; see the profile names listed in the system prompt). It cannot spawn further subagents. Its final answer becomes this call\'s result. Use it to offload a focused, well-scoped piece of work (e.g. "find every call site of X and list them" or "fix the failing test in Y") without spending this conversation\'s own tool-call budget or context on the intermediate steps.',
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "A clear, self-contained description of the sub-task, including all context the helper needs — it cannot see this conversation.",
        },
        profile: {
          type: "string",
          description:
            "The name of the profile to run this subagent under. Required: it must be one of the profile names listed in the system prompt.",
        },
      },
      required: ["task", "profile"],
    },
  },
};

/**
 * Ask the user one or more questions and wait for their answers. Handled
 * entirely client-side (see components/llm.ts's askQuestions): the panel
 * renders an interactive question card in the transcript, pauses the turn,
 * and feeds the user's answers back to the model as the tool result. The
 * model can supply predefined options for each question and/or allow
 * free-form text. Subagents cannot call this — only the main conversation
 * loop can ask questions.
 */
const askQuestions: LlmTool = {
  type: "function",
  function: {
    name: "ask_questions",
    description:
      'Ask the user one or more questions and wait for their answers. Each question has a prompt string, optional predefined answer options, and an optional multi_select flag (allowing multiple options to be selected). Free-form text input is always available alongside any options. Use this to clarify ambiguous requirements, gather preferences, or resolve genuine ambiguities before proceeding. The answers are returned as "Q1: answer1\\nQ2: answer2" so you can tell which answer corresponds to which question.',
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "One or more questions to ask.",
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "The question text to show to the user.",
              },
              options: {
                type: "array",
                description:
                  "Optional predefined answer options. Omit for free-form only.",
                items: {
                  type: "string",
                  description: "An option the user can select.",
                },
              },
              multi_select: {
                type: "boolean",
                description:
                  "Allow selecting multiple options. Defaults to false.",
              },
            },
            required: ["question"],
          },
        },
      },
      required: ["questions"],
    },
  },
};

/**
 * Load a named skill's full content into context. Handled entirely
 * client-side (see components/llm.ts's resolveToolCall): the panel looks up
 * the skill by name in the skill store (components/skills.ts) and returns its
 * content, or a model-readable error listing the available skill names. The
 * model sees each skill's name and one-line summary in the system prompt's
 * available-skills list (see components/llm.ts's systemPrompt) and calls this
 * tool when it decides a skill's full instructions are relevant. A subagent
 * cannot call this — its offered tool list excludes use_skill unconditionally
 * (see subagentToolDefs), since the store is a panel concern the headless
 * loop doesn't own.
 */
const useSkill: LlmTool = {
  type: "function",
  function: {
    name: "use_skill",
    description:
      "Load a named skill's full instructions into context. Each available skill is listed in the system prompt with its name and a one-line summary. Call this with the `name` of the skill whose full instructions you need (for example, when the task clearly falls within a skill's stated purpose). The skill's content is returned verbatim as this call's result, to be followed for the rest of the task. If no skill is relevant, do not call this. Only the skill names listed in the system prompt exist.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "The exact name of the skill to load, as listed in the system prompt.",
        },
      },
      required: ["name"],
    },
  },
};

/**
 * Find tools by keyword, including ones not loaded up front (see
 * DEFERRED_TOOL_NAMES). Handled client-side (components/llm.ts's
 * resolveToolCall), which searches the active profile's allowed tools.
 */
const searchTools: LlmTool = {
  type: "function",
  function: {
    name: "search_tools",
    description:
      'Search the available tools by keyword and return each match\'s name, description, and parameter schema. Some tools are not loaded up front (the system prompt lists them); use this to find one and learn its parameters, then run it with call_tool. Every word of the query must appear in the tool\'s name or description (e.g. "browser click"). Use "select:name1,name2" to fetch exact tools by name.',
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            'Keywords to match against tool names and descriptions, or "select:name1,name2" for exact names.',
        },
      },
      required: ["query"],
    },
  },
};

/**
 * Run a deferred tool by name (see DEFERRED_TOOL_NAMES). Handled client-side:
 * it re-dispatches as a call to the named tool, so the active profile's
 * allowed-tools check and the tool's usual handling still apply; loaded tools
 * are refused (they are called directly).
 */
const callTool: LlmTool = {
  type: "function",
  function: {
    name: "call_tool",
    description:
      "Run a tool that is not loaded up front, by name, with the given arguments, and return its result exactly as if you had called it directly. Find the tool and its parameter schema with search_tools, then call it here, putting its parameters inside `arguments`. Tools you already have loaded must be called directly; this refuses them.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The exact name of the tool to run, e.g. browser_open.",
        },
        arguments: {
          type: "object",
          description:
            "The tool's arguments, an object matching the parameter schema from search_tools.",
          additionalProperties: true,
        },
      },
      required: ["name"],
    },
  },
};

/**
 * The tools not sent with each request: the model finds them with
 * `search_tools` and runs them with `call_tool`. The browser tools are the
 * largest, most specialised group, so they are deferred; their names are still
 * listed in the system prompt so the model knows to look.
 */
export const DEFERRED_TOOL_NAMES: readonly string[] =
  browserToolDefinitions.map((t) => t.function.name);

/** The two meta-tools over the tool list; never disabled, never user-toggled. */
export const META_TOOL_NAMES = [
  "search_tools",
  "call_tool",
] as const satisfies readonly LlmToolName[];

/** Whether `name` is one of the meta-tools. */
export function isMetaTool(name: string): boolean {
  return (META_TOOL_NAMES as readonly string[]).includes(name);
}

/** All tool definitions, in a stable order (loaded and deferred alike). */
export const llmToolDefinitions: LlmTool[] = [
  listDirectory,
  findFiles,
  searchFiles,
  readFile,
  editFile,
  createDirectory,
  createFile,
  deleteFile,
  deleteDirectory,
  runCommand,
  ...browserToolDefinitions,
  createSubagent,
  askQuestions,
  useSkill,
  searchTools,
  callTool,
];

/** The definitions actually sent with each request: everything except the deferred tools. */
export const offeredToolDefinitions: LlmTool[] = llmToolDefinitions.filter(
  (t) => !DEFERRED_TOOL_NAMES.includes(t.function.name)
);
