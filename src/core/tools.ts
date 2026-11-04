import type { ToolCall } from "./messages.ts";
import { err, ok, type Result } from "./result.ts";

export const LIST_FILES = "list_files";
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 5;

// The tool as the model sees it. It is sent with every request and never changes, so the
// prompt cache stays valid.
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

export interface ListFilesArgs {
  path: string;
  depth: number;
}

// The arguments as the model wrote them, before they are checked.
interface RawArgs {
  path?: unknown;
  depth?: unknown;
}

// Runs a tool call and returns the text to send back to the model. Failures come back
// as text too, so the model can read them and answer.
export type ToolRunner = (call: ToolCall) => Promise<string>;

// Reads the arguments the model wrote. A depth above the cap is clamped to it.
export function parseListFilesArgs(raw: string): Result<ListFilesArgs> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return err(new Error("arguments are not JSON"));
  }
  if (typeof value !== "object" || value === null) return err(new Error("arguments must be an object"));
  const { path, depth } = value as RawArgs;
  if (typeof path !== "string") return err(new Error("path must be a string"));
  const clamped = typeof depth === "number" ? Math.min(Math.max(Math.trunc(depth), 1), MAX_DEPTH) : DEFAULT_DEPTH;
  return ok({ path, depth: clamped });
}

// The line shown to the user when the model makes a call.
export function describeToolCall(call: ToolCall): string {
  if (call.name !== LIST_FILES) return `tool: ${call.name} (unknown tool)`;
  const args = parseListFilesArgs(call.arguments);
  if (!args.ok) return `tool: ${LIST_FILES} (invalid arguments)`;
  return `tool: ${LIST_FILES} ${args.value.path} depth ${args.value.depth}`;
}
