import { getListing, repoRoot } from "./listing.js";
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

/**
 * The registry of tools available to the model.
 */
export const TOOLS = [listDirectory];
