import { type ToolCall, err, ok, type Result } from "./messages.ts";
import { checkName } from "./notes.ts";

export const LIST_FILES = "list_files";
export const READ_FILE = "read_file";
export const EDIT_FILE = "edit_file";
export const CREATE_FILE = "create_file";
export const RUN_POWERSHELL = "run_powershell";
export const READ_COMMAND = "read_command";
export const KILL_COMMAND = "kill_command";
export const CREATE_NOTE = "create_note";
export const RUN_SUBAGENT = "run_subagent";
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 5;
export const MAX_LINES = 500;

// The tools as the model sees them. They are sent with every request and never change,
// so the prompt cache stays valid.
export const listFilesSpec: ToolSpec = {
  type: "function",
  function: {
    name: LIST_FILES,
    description:
      "List the files under a directory inside the working directory, recursing to a depth. Hidden files and folders are skipped. Paths are relative to the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Directory to list, relative to the working directory. Use . for the working directory itself.",
        },
        depth: {
          type: "integer",
          minimum: 1,
          maximum: MAX_DEPTH,
          description: `How many directory levels to list. 1 lists only the directory's own files. Defaults to ${DEFAULT_DEPTH}.`,
        },
      },
      required: ["path"],
    },
  },
};

export const readFileSpec: ToolSpec = {
  type: "function",
  function: {
    name: READ_FILE,
    description: `Read lines of a file inside the working directory. Lines are numbered from 1 and the range is inclusive. At most ${MAX_LINES} lines are returned per call; a longer range is cut short and the result says where to continue.`,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File to read, relative to the working directory.",
        },
        start: {
          type: "integer",
          minimum: 1,
          description: "First line to read, numbered from 1.",
        },
        end: {
          type: "integer",
          minimum: 1,
          description: "Last line to read, inclusive.",
        },
      },
      required: ["path", "start", "end"],
    },
  },
};

export const editFileSpec: ToolSpec = {
  type: "function",
  function: {
    name: EDIT_FILE,
    description:
      "Replace the first occurrence of `previous` in an existing file inside the working directory with `replacement`. The match is exact, including line endings and spacing. The user must approve each edit before it is written. Files cannot be created.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File to edit, relative to the working directory.",
        },
        previous: {
          type: "string",
          description: "Exact text to replace. Must not be empty.",
        },
        replacement: {
          type: "string",
          description: "Text to put in its place.",
        },
      },
      required: ["path", "previous", "replacement"],
    },
  },
};

export const createFileSpec: ToolSpec = {
  type: "function",
  function: {
    name: CREATE_FILE,
    description:
      "Create a new file inside the working directory with the given content. Folders above it are created if missing. An existing file is never overwritten. The user must approve each new file before it is written.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File to create, relative to the working directory.",
        },
        content: {
          type: "string",
          description: "Full text of the new file. May be empty.",
        },
      },
      required: ["path", "content"],
    },
  },
};

export const createNoteSpec: ToolSpec = {
  type: "function",
  function: {
    name: CREATE_NOTE,
    description:
      "Create a note at notes/<category>/<name>.md in the working directory, with a header and an empty body. Use this rather than create_file for notes, so the location follows the notes convention. The category and name may contain only letters, digits, - and _. The user must approve each note before it is written. An existing note is never overwritten; edit it with edit_file afterwards.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Category of the note. Letters, digits, - and _ only.",
        },
        name: {
          type: "string",
          description: "Name of the note. Letters, digits, - and _ only.",
        },
      },
      required: ["category", "name"],
    },
  },
};

export const runPowershellSpec: ToolSpec = {
  type: "function",
  function: {
    name: RUN_POWERSHELL,
    description: `Run a PowerShell command in the working directory. The user must approve each command before it runs. A command still running after 30 seconds keeps running as a background job; use read_command or kill_command with its job number. At most ${MAX_LINES} lines of output are returned.`,
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The PowerShell command to run, as one string.",
        },
      },
      required: ["command"],
    },
  },
};

export const readCommandSpec: ToolSpec = {
  type: "function",
  function: {
    name: READ_COMMAND,
    description:
      "Read the status and latest output of a command that is running in the background, or has finished. Use the job number that run_powershell reported.",
    parameters: {
      type: "object",
      properties: {
        job: {
          type: "integer",
          minimum: 1,
          description: "The job number that run_powershell reported.",
        },
      },
      required: ["job"],
    },
  },
};

export const killCommandSpec: ToolSpec = {
  type: "function",
  function: {
    name: KILL_COMMAND,
    description:
      "Stop a command that is running in the background, along with the processes it started. The user must approve it before it is stopped. Use the job number that run_powershell reported.",
    parameters: {
      type: "object",
      properties: {
        job: {
          type: "integer",
          minimum: 1,
          description: "The job number that run_powershell reported.",
        },
      },
      required: ["job"],
    },
  },
};

// Starts a subagent: a separate conversation, with its profile and its own tool-call limit. Several
// subagents asked for in one reply run together. A subagent is never offered this tool itself.
export const runSubagentSpec: ToolSpec = {
  type: "function",
  function: {
    name: RUN_SUBAGENT,
    description:
      "Run a subagent on a task in its own conversation. The profile gives the subagent its instructions, and it may use only the tools that profile lists. It makes at most max_tool_calls tool calls, then answers with what it has. Its writes and commands ask the user for approval one at a time. It returns its final answer, and its conversation is not added to yours.",
    parameters: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description:
            "Name of the profile that gives the subagent its instructions and tools.",
        },
        task: {
          type: "string",
          description: "The task for the subagent. Must not be empty.",
        },
        max_tool_calls: {
          type: "integer",
          minimum: 1,
          description: "The most tool calls the subagent may make.",
        },
      },
      required: ["profile", "task", "max_tool_calls"],
    },
  },
};

// Every tool the model can be offered, in the order they are sent. A tool that is switched off is
// left out of the request, and the request is the only place the list is used.
export const toolSpecs = [
  listFilesSpec,
  readFileSpec,
  editFileSpec,
  createFileSpec,
  createNoteSpec,
  runPowershellSpec,
  readCommandSpec,
  killCommandSpec,
  runSubagentSpec,
];
export const toolNames: string[] = toolSpecs.map((spec) => spec.function.name);

// A tool the model may be offered, in the shape the request carries.
export interface ToolSpec {
  type: "function";
  function: ToolFunction;
}

export interface ToolFunction {
  name: string;
  description: string;
  parameters: unknown;
}

// The tools that come from MCP servers are named `<server>__<tool>`. No built-in name contains "__", and
// a server name cannot either, so the name alone says which kind a tool is.
export function isExternalName(name: string): boolean {
  return name.includes("__");
}

// Writes the disabled tool names to the settings file. The composition root supplies it.
export type SaveDisabledTools = (names: string[]) => Promise<Result<void>>;

export interface ToolsListCommand {
  kind: "list";
}

export interface ToolSwitchCommand {
  kind: "enable" | "disable";
  name: string;
}

export type ToolsCommand = ToolsListCommand | ToolSwitchCommand;

// Reads the words after /tools: nothing lists the tools, and `enable` or `disable` followed by a
// tool name switches that tool.
export function parseToolsCommand(
  words: string[],
  names: string[],
): Result<ToolsCommand> {
  const [action, name] = words;
  if (words.length === 0) return ok({ kind: "list" });
  if (
    (action === "enable" || action === "disable") &&
    words.length === 2 &&
    name !== undefined
  ) {
    if (!names.includes(name))
      return err(new Error("no tool has that name; /tools lists them"));
    return ok({ kind: action, name });
  }
  return err(
    new Error("usage: /tools | /tools enable <tool> | /tools disable <tool>"),
  );
}

// One tool and whether the user has it switched on.
export interface ToolSwitch {
  name: string;
  enabled: boolean;
}

// Every tool with its switch, in the order of names.
export function toolSwitches(names: string[], disabled: string[]): ToolSwitch[] {
  return names.map((name) => ({ name, enabled: !disabled.includes(name) }));
}

// One line per tool, as name: on or off.
export function toolStates(names: string[], disabled: string[]): string {
  return names
    .map((name) => `${name}: ${disabled.includes(name) ? "off" : "on"}`)
    .join("\n");
}

export interface ListFilesArgs {
  path: string;
  depth: number;
}

export interface ReadFileArgs {
  path: string;
  start: number;
  end: number;
}

export interface EditFileArgs {
  path: string;
  previous: string;
  replacement: string;
}

export interface CreateFileArgs {
  path: string;
  content: string;
}

export interface CreateNoteArgs {
  category: string;
  name: string;
}

export interface RunPowershellArgs {
  command: string;
}

export interface JobArgs {
  job: number;
}

// Asks the user to approve a change. The preview is what will be written or run. Resolves true only
// when the user says yes.
export type Approve = (preview: string) => Promise<boolean>;

// Runs a tool call and returns the text to send back to the model. `offered` names the tools
// that are switched on; a call to any other tool is refused here, before anything is asked.
// Changes and commands run only when `approve` resolves true. Failures come back as text too,
// so the model can read them and answer.
export type ToolRunner = (
  call: ToolCall,
  approve: Approve,
  offered: string[],
) => Promise<string>;

// The arguments as the model wrote them, before they are checked. Each parser checks the fields it reads.
type RawArgs = Record<string, unknown>;

export interface SubagentArgs {
  profile: string;
  task: string;
  maxToolCalls: number;
}

// Reads the arguments the model wrote for run_subagent. The profile must be a valid note name, the
// task must not be empty, and the limit must be a whole number of at least 1.
export function parseSubagentArgs(raw: string): Result<SubagentArgs> {
  const args = readArgs(raw);
  if (!args.ok) return args;
  const { profile, task, max_tool_calls } = args.value;
  if (typeof profile !== "string")
    return err(new Error("profile must be a string"));
  const checkedProfile = checkName(profile, "profile");
  if (!checkedProfile.ok) return checkedProfile;
  if (typeof task !== "string" || task.trim() === "")
    return err(new Error("task must be a non-empty string"));
  if (!isLine(max_tool_calls))
    return err(
      new Error("max_tool_calls must be a whole number of at least 1"),
    );
  return ok({ profile, task, maxToolCalls: max_tool_calls });
}

function readArgs(raw: string): Result<RawArgs> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return err(new Error("arguments are not JSON"));
  }
  if (typeof value !== "object" || value === null)
    return err(new Error("arguments must be an object"));
  return ok(value as RawArgs);
}

// Reads the arguments the model wrote. A depth above the cap is clamped to it.
export function parseListFilesArgs(raw: string): Result<ListFilesArgs> {
  const args = readArgs(raw);
  if (!args.ok) return args;
  const { path, depth } = args.value;
  if (typeof path !== "string") return err(new Error("path must be a string"));
  const clamped =
    typeof depth === "number"
      ? Math.min(Math.max(Math.trunc(depth), 1), MAX_DEPTH)
      : DEFAULT_DEPTH;
  return ok({ path, depth: clamped });
}

// Reads the arguments the model wrote. start and end are 1-based and inclusive; the
// reader clamps the range to the file and to MAX_LINES.
export function parseReadFileArgs(raw: string): Result<ReadFileArgs> {
  const args = readArgs(raw);
  if (!args.ok) return args;
  const { path, start, end } = args.value;
  if (typeof path !== "string") return err(new Error("path must be a string"));
  if (!isLine(start))
    return err(new Error("start must be a line number of at least 1"));
  if (!isLine(end))
    return err(new Error("end must be a line number of at least 1"));
  if (end < start) return err(new Error("end must not be before start"));
  return ok({ path, start, end });
}

// Reads the arguments the model wrote. An empty `previous` is refused, so edits cannot create files.
export function parseEditFileArgs(raw: string): Result<EditFileArgs> {
  const args = readArgs(raw);
  if (!args.ok) return args;
  const { path, previous, replacement } = args.value;
  if (typeof path !== "string") return err(new Error("path must be a string"));
  if (typeof previous !== "string" || previous === "")
    return err(new Error("previous must be a non-empty string"));
  if (typeof replacement !== "string")
    return err(new Error("replacement must be a string"));
  return ok({ path, previous, replacement });
}

// Reads the arguments the model wrote. Content may be empty.
export function parseCreateFileArgs(raw: string): Result<CreateFileArgs> {
  const args = readArgs(raw);
  if (!args.ok) return args;
  const { path, content } = args.value;
  if (typeof path !== "string") return err(new Error("path must be a string"));
  if (typeof content !== "string")
    return err(new Error("content must be a string"));
  return ok({ path, content });
}

// Reads the arguments the model wrote. The category and name must pass the note name rules.
export function parseCreateNoteArgs(raw: string): Result<CreateNoteArgs> {
  const args = readArgs(raw);
  if (!args.ok) return args;
  const { category, name } = args.value;
  if (typeof category !== "string")
    return err(new Error("category must be a string"));
  if (typeof name !== "string") return err(new Error("name must be a string"));
  const checkedCategory = checkName(category, "category");
  if (!checkedCategory.ok) return checkedCategory;
  const checkedName = checkName(name, "name");
  if (!checkedName.ok) return checkedName;
  return ok({ category, name });
}

// Reads the arguments the model wrote. The command must not be empty.
export function parseRunPowershellArgs(raw: string): Result<RunPowershellArgs> {
  const args = readArgs(raw);
  if (!args.ok) return args;
  const { command } = args.value;
  if (typeof command !== "string" || command.trim() === "")
    return err(new Error("command must be a non-empty string"));
  return ok({ command });
}

// Reads the job number the model wrote. It must be a whole number of at least 1.
export function parseJobArgs(raw: string): Result<JobArgs> {
  const args = readArgs(raw);
  if (!args.ok) return args;
  const { job } = args.value;
  if (!isLine(job))
    return err(new Error("job must be a job number of at least 1"));
  return ok({ job });
}

function isLine(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}
