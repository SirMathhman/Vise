import { LIST_FILES, READ_FILE, parseListFilesArgs, parseReadFileArgs, type ToolRunner } from "../core/tools.ts";
import { listFiles } from "./list-files.ts";
import { readFileLines } from "./read-file.ts";

// The tool runner for a working directory. Errors come back as text for the model to read.
export function runTool(root: string): ToolRunner {
  return async (call) => {
    if (call.name === LIST_FILES) {
      const args = parseListFilesArgs(call.arguments);
      if (!args.ok) return `invalid arguments: ${args.error.message}`;
      const listing = await listFiles(root, args.value.path, args.value.depth);
      if (!listing.ok) return `error: ${listing.error.message}`;
      return listing.value || "(no files)";
    }
    if (call.name === READ_FILE) {
      const args = parseReadFileArgs(call.arguments);
      if (!args.ok) return `invalid arguments: ${args.error.message}`;
      const text = await readFileLines(root, args.value.path, args.value.start, args.value.end);
      if (!text.ok) return `error: ${text.error.message}`;
      return text.value || "(no lines)";
    }
    return `unknown tool: ${call.name}`;
  };
}
