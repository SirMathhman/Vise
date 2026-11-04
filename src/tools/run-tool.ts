import { LIST_FILES, parseListFilesArgs, type ToolRunner } from "../core/tools.ts";
import { listFiles } from "./list-files.ts";

// The tool runner for a working directory. Errors come back as text for the model to read.
export function runTool(root: string): ToolRunner {
  return async (call) => {
    if (call.name !== LIST_FILES) return `unknown tool: ${call.name}`;
    const args = parseListFilesArgs(call.arguments);
    if (!args.ok) return `invalid arguments: ${args.error.message}`;
    const listing = await listFiles(root, args.value.path, args.value.depth);
    if (!listing.ok) return `error: ${listing.error.message}`;
    return listing.value || "(no files)";
  };
}
