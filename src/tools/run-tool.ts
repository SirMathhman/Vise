import type { ToolCall } from "../core/messages.ts";
import { notePath } from "../core/notes.ts";
import { approvalPreview, needsApproval } from "../core/tool-lines.ts";
import {
  CREATE_FILE,
  CREATE_NOTE,
  EDIT_FILE,
  KILL_COMMAND,
  LIST_FILES,
  READ_COMMAND,
  READ_FILE,
  RUN_POWERSHELL,
  parseCreateFileArgs,
  parseCreateNoteArgs,
  parseEditFileArgs,
  parseJobArgs,
  parseListFilesArgs,
  parseReadFileArgs,
  parseRunPowershellArgs,
  toolNames,
  type Approve,
  type ToolRunner,
} from "../core/tools.ts";
import type { McpRegistry } from "./mcp/registry.ts";
import { noServers } from "./mcp/registry.ts";
import { resolveInside, resolveNewInside } from "./files/contain.ts";
import { createFile } from "./files/create-file.ts";
import { editFile } from "./files/edit-file.ts";
import { listFiles } from "./files/list-files.ts";
import { readFileLines } from "./files/read-file.ts";
import { createNote } from "./notes/create-note.ts";
import { MAX_JOBS, killJob, readJob, runningJobs } from "./jobs.ts";
import { runPowershell } from "./run-powershell.ts";

// The tool runner for a working directory and the MCP servers that started. A change or command is
// checked and previewed, and it runs only if `approve` says yes. Errors come back as text for the
// model to read.
export function runTool(root: string, mcp: McpRegistry = noServers()): ToolRunner {
  return async (call: ToolCall, approve: Approve, offered: string[]) => {
    // A tool switched off is refused here, so no caller of the runner can run it.
    const known = toolNames.includes(call.name) || mcp.has(call.name);
    if (known && !offered.includes(call.name)) {
      return `error: tool ${call.name} is switched off`;
    }
    if (call.name === RUN_POWERSHELL && runningJobs() >= MAX_JOBS) {
      return `error: ${MAX_JOBS} commands are already running in the background`;
    }
    if (needsApproval(call)) {
      const problem = await checkTarget(root, call);
      if (problem) return `error: ${problem}`;
      const preview = approvalPreview(call);
      if (preview !== undefined && !(await approve(preview)))
        return "the user declined this change";
    }
    if (mcp.has(call.name)) return mcp.call(call.name, call.arguments);
    return dispatch(root, call);
  };
}

// Refuses a file change whose path is outside the working directory or hidden, before anyone is asked.
async function checkTarget(
  root: string,
  call: ToolCall,
): Promise<string | undefined> {
  if (call.name === EDIT_FILE) {
    const args = parseEditFileArgs(call.arguments);
    if (!args.ok) return undefined;
    const place = await resolveInside(root, args.value.path);
    return place.ok ? undefined : place.error.message;
  }
  if (call.name === CREATE_FILE) {
    const args = parseCreateFileArgs(call.arguments);
    if (!args.ok) return undefined;
    const place = await resolveNewInside(root, args.value.path);
    return place.ok ? undefined : place.error.message;
  }
  if (call.name === CREATE_NOTE) {
    const args = parseCreateNoteArgs(call.arguments);
    if (!args.ok) return undefined;
    const place = await resolveNewInside(
      root,
      notePath(args.value.category, args.value.name),
    );
    return place.ok ? undefined : place.error.message;
  }
  return undefined;
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
    const text = await readFileLines(
      root,
      args.value.path,
      args.value.start,
      args.value.end,
    );
    if (!text.ok) return `error: ${text.error.message}`;
    return text.value || "(no lines)";
  }
  if (call.name === EDIT_FILE) {
    const args = parseEditFileArgs(call.arguments);
    if (!args.ok) return `invalid arguments: ${args.error.message}`;
    const edit = await editFile(
      root,
      args.value.path,
      args.value.previous,
      args.value.replacement,
    );
    return edit.ok ? edit.value : `error: ${edit.error.message}`;
  }
  if (call.name === CREATE_FILE) {
    const args = parseCreateFileArgs(call.arguments);
    if (!args.ok) return `invalid arguments: ${args.error.message}`;
    const created = await createFile(root, args.value.path, args.value.content);
    return created.ok ? created.value : `error: ${created.error.message}`;
  }
  if (call.name === CREATE_NOTE) {
    const args = parseCreateNoteArgs(call.arguments);
    if (!args.ok) return `invalid arguments: ${args.error.message}`;
    const created = await createNote(
      root,
      args.value.category,
      args.value.name,
    );
    return created.ok ? created.value : `error: ${created.error.message}`;
  }
  if (call.name === RUN_POWERSHELL) {
    const args = parseRunPowershellArgs(call.arguments);
    if (!args.ok) return `invalid arguments: ${args.error.message}`;
    const result = await runPowershell(root, args.value.command);
    return result.ok ? result.value : `error: ${result.error.message}`;
  }
  if (call.name === READ_COMMAND) {
    const args = parseJobArgs(call.arguments);
    if (!args.ok) return `invalid arguments: ${args.error.message}`;
    const job = readJob(args.value.job);
    return job.ok ? job.value : `error: ${job.error.message}`;
  }
  if (call.name === KILL_COMMAND) {
    const args = parseJobArgs(call.arguments);
    if (!args.ok) return `invalid arguments: ${args.error.message}`;
    const stopped = await killJob(args.value.job);
    return stopped.ok ? stopped.value : `error: ${stopped.error.message}`;
  }
  return `unknown tool: ${call.name}`;
}
