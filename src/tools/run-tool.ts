import {
  EDIT_FILE,
  LIST_FILES,
  READ_FILE,
  parseEditFileArgs,
  parseListFilesArgs,
  parseReadFileArgs,
  type ToolRunner,
} from "../core/tools.ts";
import { editFile } from "./edit-file.ts";
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
    if (call.name === EDIT_FILE) {
      const args = parseEditFileArgs(call.arguments);
      if (!args.ok) return `invalid arguments: ${args.error.message}`;
      const edit = await editFile(root, args.value.path, args.value.previous, args.value.replacement);
      return edit.ok ? edit.value : `error: ${edit.error.message}`;
    }
    return `unknown tool: ${call.name}`;
  };
}
