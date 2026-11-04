import type { ToolCall } from "./messages.ts";
import { err, ok, type Result } from "./result.ts";

export const LIST_FILES = "list_files";
export const READ_FILE = "read_file";
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

export interface ListFilesArgs {
  path: string;
  depth: number;
}

export interface ReadFileArgs {
  path: string;
  start: number;
  end: number;
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

function isLine(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
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
  return `tool: ${call.name} (unknown tool)`;
}
