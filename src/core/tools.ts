import type { ToolCall } from "./messages.ts";
import { err, ok, type Result } from "./result.ts";

export const LIST_FILES = "list_files";
export const READ_FILE = "read_file";
export const EDIT_FILE = "edit_file";
export const CREATE_FILE = "create_file";
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 5;
export const MAX_LINES = 500;

// The tools as the model sees them. They are sent with every request and never change,
// so the prompt cache stays valid.
export const listFilesSpec = {
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
          description: "Directory to list, relative to the working directory. Use . for the working directory itself.",
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

export const readFileSpec = {
  type: "function",
  function: {
    name: READ_FILE,
    description: `Read lines of a file inside the working directory. Lines are numbered from 1 and the range is inclusive. At most ${MAX_LINES} lines are returned per call; a longer range is cut short and the result says where to continue.`,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to read, relative to the working directory." },
        start: { type: "integer", minimum: 1, description: "First line to read, numbered from 1." },
        end: { type: "integer", minimum: 1, description: "Last line to read, inclusive." },
      },
      required: ["path", "start", "end"],
    },
  },
};

export const editFileSpec = {
  type: "function",
  function: {
    name: EDIT_FILE,
    description:
      "Replace the first occurrence of `previous` in an existing file inside the working directory with `replacement`. The match is exact, including line endings and spacing. The user must approve each edit before it is written. Files cannot be created.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to edit, relative to the working directory." },
        previous: { type: "string", description: "Exact text to replace. Must not be empty." },
        replacement: { type: "string", description: "Text to put in its place." },
      },
      required: ["path", "previous", "replacement"],
    },
  },
};

export const createFileSpec = {
  type: "function",
  function: {
    name: CREATE_FILE,
    description:
      "Create a new file inside the working directory with the given content. Folders above it are created if missing. An existing file is never overwritten. The user must approve each new file before it is written.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to create, relative to the working directory." },
        content: { type: "string", description: "Full text of the new file. May be empty." },
      },
      required: ["path", "content"],
    },
  },
};

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

// Runs a tool call and returns the text to send back to the model. Failures come back
// as text too, so the model can read them and answer.
export type ToolRunner = (call: ToolCall) => Promise<string>;

// The arguments as the model wrote them, before they are checked.
interface RawArgs {
  path?: unknown;
  depth?: unknown;
  start?: unknown;
  end?: unknown;
  previous?: unknown;
  replacement?: unknown;
  content?: unknown;
}

function readArgs(raw: string): Result<RawArgs> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return err(new Error("arguments are not JSON"));
  }
  if (typeof value !== "object" || value === null) return err(new Error("arguments must be an object"));
  return ok(value as RawArgs);
}

// Reads the arguments the model wrote. A depth above the cap is clamped to it.
export function parseListFilesArgs(raw: string): Result<ListFilesArgs> {
  const args = readArgs(raw);
  if (!args.ok) return args;
  const { path, depth } = args.value;
  if (typeof path !== "string") return err(new Error("path must be a string"));
  const clamped = typeof depth === "number" ? Math.min(Math.max(Math.trunc(depth), 1), MAX_DEPTH) : DEFAULT_DEPTH;
  return ok({ path, depth: clamped });
}

// Reads the arguments the model wrote. start and end are 1-based and inclusive; the
// reader clamps the range to the file and to MAX_LINES.
export function parseReadFileArgs(raw: string): Result<ReadFileArgs> {
  const args = readArgs(raw);
  if (!args.ok) return args;
  const { path, start, end } = args.value;
  if (typeof path !== "string") return err(new Error("path must be a string"));
  if (!isLine(start)) return err(new Error("start must be a line number of at least 1"));
  if (!isLine(end)) return err(new Error("end must be a line number of at least 1"));
  if (end < start) return err(new Error("end must not be before start"));
  return ok({ path, start, end });
}

// Reads the arguments the model wrote. An empty `previous` is refused, so edits cannot create files.
export function parseEditFileArgs(raw: string): Result<EditFileArgs> {
  const args = readArgs(raw);
  if (!args.ok) return args;
  const { path, previous, replacement } = args.value;
  if (typeof path !== "string") return err(new Error("path must be a string"));
  if (typeof previous !== "string" || previous === "") return err(new Error("previous must be a non-empty string"));
  if (typeof replacement !== "string") return err(new Error("replacement must be a string"));
  return ok({ path, previous, replacement });
}

// Reads the arguments the model wrote. Content may be empty.
export function parseCreateFileArgs(raw: string): Result<CreateFileArgs> {
  const args = readArgs(raw);
  if (!args.ok) return args;
  const { path, content } = args.value;
  if (typeof path !== "string") return err(new Error("path must be a string"));
  if (typeof content !== "string") return err(new Error("content must be a string"));
  return ok({ path, content });
}

function isLine(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// Edits and new files are written only after the user approves them.
export function needsApproval(call: ToolCall): boolean {
  return call.name === EDIT_FILE || call.name === CREATE_FILE;
}

// The change shown to the user before they approve it. Undefined when the arguments are
// invalid, in which case the tool reports that without writing anything.
export function approvalPreview(call: ToolCall): string | undefined {
  if (call.name === EDIT_FILE) {
    const args = parseEditFileArgs(call.arguments);
    if (!args.ok) return undefined;
    return `edit ${args.value.path}\n--- previous\n${args.value.previous}\n+++ replacement\n${args.value.replacement}`;
  }
  if (call.name === CREATE_FILE) {
    const args = parseCreateFileArgs(call.arguments);
    if (!args.ok) return undefined;
    return `create ${args.value.path}\n+++ content\n${args.value.content}`;
  }
  return undefined;
}

// The line shown to the user when the model makes a call.
export function describeToolCall(call: ToolCall): string {
  if (call.name === LIST_FILES) {
    const args = parseListFilesArgs(call.arguments);
    if (!args.ok) return `tool: ${LIST_FILES} (invalid arguments)`;
    return `tool: ${LIST_FILES} ${args.value.path} depth ${args.value.depth}`;
  }
  if (call.name === READ_FILE) {
    const args = parseReadFileArgs(call.arguments);
    if (!args.ok) return `tool: ${READ_FILE} (invalid arguments)`;
    return `tool: ${READ_FILE} ${args.value.path} lines ${args.value.start}-${args.value.end}`;
  }
  if (call.name === EDIT_FILE) {
    const args = parseEditFileArgs(call.arguments);
    if (!args.ok) return `tool: ${EDIT_FILE} (invalid arguments)`;
    return `tool: ${EDIT_FILE} ${args.value.path}`;
  }
  if (call.name === CREATE_FILE) {
    const args = parseCreateFileArgs(call.arguments);
    if (!args.ok) return `tool: ${CREATE_FILE} (invalid arguments)`;
    return `tool: ${CREATE_FILE} ${args.value.path}`;
  }
  return `tool: ${call.name} (unknown tool)`;
}
