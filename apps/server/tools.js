import { getListing, getFileContent, repoRoot } from "./listing.js";
import { resolveWithin } from "./pathGuard.js";

/**
 * A tool the model can call. Its definition (sent to the LLM) and executor
 * (run server-side) live together so the tool contract is defined exactly
 * once. Adding a tool is a single-file change.
 */
const listDirectory = {
  name: "list_directory",
  definition: {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List the files and subdirectories in a directory of the repository. " +
        "Use an empty path to list the repository root.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Directory path relative to the repository root (e.g. "apps/server"). Empty string for the root.',
          },
        },
        required: ["path"],
      },
    },
  },
  async execute(args) {
    const dir = resolveWithin(repoRoot, args?.path ?? "");
    if (!dir) return "Invalid path (must be within the repository).";
    try {
      const entries = await getListing(dir);
      return entries
        .map((e) => `${e.isDirectory ? "dir " : "file"} ${e.name}`)
        .join("\n");
    } catch (err) {
      return `Could not list directory: ${err.message}`;
    }
  },
};

const readFile = {
  name: "read_file",
  definition: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the text content of a file in the repository. " +
        "Use this to answer questions about what a file contains.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'File path relative to the repository root (e.g. "apps/server/chat.js").',
          },
        },
        required: ["path"],
      },
    },
  },
  async execute(args) {
    const file = resolveWithin(repoRoot, args?.path ?? "");
    if (!file) return "Invalid path (must be within the repository).";
    try {
      const content = await getFileContent(file);
      const MAX_CHARS = 100_000;
      if (content.length > MAX_CHARS) {
        return (
          content.slice(0, MAX_CHARS) +
          `\n\n[truncated: file is ${content.length} characters, showing first ${MAX_CHARS}]`
        );
      }
      return content;
    } catch (err) {
      return `Could not read file: ${err.message}`;
    }
  },
};

/**
 * The registry of tools available to the model.
 */
export const TOOLS = [listDirectory, readFile];
