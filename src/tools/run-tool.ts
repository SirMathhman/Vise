import type { ToolCall } from "../core/messages.ts";
import {
  CREATE_FILE,
  EDIT_FILE,
  LIST_FILES,
  READ_FILE,
  approvalPreview,
  needsApproval,
  parseCreateFileArgs,
  parseEditFileArgs,
  parseListFilesArgs,
  parseReadFileArgs,
  type Approve,
  type ToolRunner,
} from "../core/tools.ts";
import { resolveInside, resolveNewInside } from "./files/contain.ts";
import { createFile } from "./files/create-file.ts";
import { editFile } from "./files/edit-file.ts";
import { listFiles } from "./files/list-files.ts";
import { readFileLines } from "./files/read-file.ts";

// The tool runner for a working directory. A change is checked and previewed, and it is
// written only if `approve` says yes. Errors come back as text for the model to read.
export function runTool(root: string): ToolRunner {
  return async (call: ToolCall, approve: Approve) => {
    if (needsApproval(call)) {
      const problem = await checkTarget(root, call);
      if (problem) return `error: ${problem}`;
      const preview = approvalPreview(call);
      if (preview !== undefined && !(await approve(preview))) return "the user declined this change";
    }
    return dispatch(root, call);
  };
}

// Refuses a change whose path is outside the working directory or hidden, before anyone is asked.
async function checkTarget(root: string, call: ToolCall): Promise<string | undefined> {
  const path = call.name === EDIT_FILE ? parseEditFileArgs(call.arguments) : parseCreateFileArgs(call.arguments);
  if (!path.ok) return undefined;
  const place =
    call.name === EDIT_FILE
      ? await resolveInside(root, path.value.path)
      : await resolveNewInside(root, path.value.path);
  return place.ok ? undefined : place.error.message;
}

async function dispatch(root: string, call: ToolCall): Promise<string> {
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
  if (call.name === CREATE_FILE) {
    const args = parseCreateFileArgs(call.arguments);
    if (!args.ok) return `invalid arguments: ${args.error.message}`;
    const created = await createFile(root, args.value.path, args.value.content);
    return created.ok ? created.value : `error: ${created.error.message}`;
  }
  return `unknown tool: ${call.name}`;
}
