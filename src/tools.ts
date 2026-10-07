import type { Tool, ToolController, ToolRunner } from "./core/engine.ts";
import { agentTools } from "./tools/defs/agent.ts";
import { browserTools } from "./tools/defs/browser.ts";
import { fileTools } from "./tools/defs/files.ts";
import { noteTools } from "./tools/defs/notes.ts";
import { shellTools } from "./tools/defs/shell.ts";
import {
  createFile,
  deleteDirectory,
  deleteFile,
  editFile,
  findFiles,
  listDirectory,
  readFile,
  searchFiles,
} from "./tools/files.ts";
import {
  deleteNoteTool,
  listNotesTool,
  readNoteTool,
  saveNoteTool,
} from "./tools/notes-tool.ts";
import { deferTools, searchToolsDef } from "./tools/search-tools.ts";
import { killProcess, runPowershell, waitForProcess } from "./tools/shell.ts";

/** Tool definitions exposed to the model, in prompt order. */
const allTools: Tool[] = [
  ...fileTools,
  ...shellTools,
  ...noteTools,
  ...agentTools.filter((t) => t.function.name !== "run_subagent"),
  ...browserTools,
  ...agentTools.filter((t) => t.function.name === "run_subagent"),
];

/** The tool list the app uses: `search_tools` added and the non-core tools deferred. */
export const tools: Tool[] = deferTools([...allTools, searchToolsDef]);

/** A single tool handler, mapping a tool's arguments to its result text. */
export type ToolHandler = (
  args: Record<string, unknown>,
) => string | Promise<string>;

/** Edge-provided tool implementations for the tools that need no edge
 * services. All I/O is in the modules imported above; the core only depends
 * on the ToolRunner type. Tools that need edge services constructed in
 * index.ts (e.g. run_subagent needs the Client and ProfileSource) are added
 * via createToolRunner.
 */

const baseHandlers: Record<string, ToolHandler> = {
  list_directory: listDirectory,
  read_file: readFile,
  create_file: createFile,
  edit_file: editFile,
  delete_file: deleteFile,
  delete_directory: deleteDirectory,
  run_powershell: runPowershell,
  wait_for_process: waitForProcess,
  kill_process: killProcess,
  find_files: findFiles,
  search_files: searchFiles,
  list_notes: listNotesTool,
  read_note: readNoteTool,
  save_note: saveNoteTool,
  delete_note: deleteNoteTool,
};

/**
 * Edge implementation of the core `ToolController`. Tracks which tools are
 * enabled (default: all). The full set of tool definitions is always sent
 * to the model regardless of enabled state — disabling a tool does not
 * change the definitions offered; it only makes `toolRunner` reject
 * invocations of that tool. When the user toggles a tool, the `Session`
 * injects a user message informing the model of the state change.
 */
export class ToolSet implements ToolController {
  private readonly defs: Tool[];
  private readonly disabled = new Set<string>();

  /** `initiallyDisabled` names tools that start off until the user enables them. */
  constructor(defs: Tool[], initiallyDisabled: string[] = []) {
    this.defs = defs;
    for (const name of initiallyDisabled) this.disabled.add(name);
  }

  list(): { name: string; enabled: boolean }[] {
    return this.defs.map((t) => ({
      name: t.function.name,
      enabled: !this.disabled.has(t.function.name),
    }));
  }

  isEnabled(name: string): boolean {
    return !this.disabled.has(name);
  }

  set(name: string, enabled: boolean): void {
    if (enabled) {
      this.disabled.delete(name);
    } else {
      this.disabled.add(name);
    }
  }
}

/**
 * Build a `ToolRunner` composing the static base handlers with any extra
 * handlers supplied at construction time. The extras are for tools whose
 * handler depends on edge services constructed in index.ts (e.g.
 * `run_subagent` needs the `Client` and `ProfileSource`); composing them here
 * keeps the wiring explicit and avoids a mutable module-level handler map.
 * The `toolController` is per session (never module-global), so one web
 * connection toggling tools or switching profile cannot affect another.
 * The full set of tool definitions is always sent to the model regardless of
 * enabled state — disabling a tool does not change the definitions; it only
 * makes the runner report `error: tool <name> is disabled` if the model
 * calls it.
 */
export function createToolRunner(
  extra: Record<string, ToolHandler> | undefined,
  toolController: ToolController,
): ToolRunner {
  const handlers: Record<string, ToolHandler> = { ...baseHandlers, ...extra };
  return {
    async run(name, args): Promise<string> {
      const handler = handlers[name];
      if (handler === undefined) {
        return `error: unknown tool ${name}`;
      }
      if (!toolController.isEnabled(name)) {
        return `error: tool ${name} is disabled`;
      }
      return handler(args);
    },
  };
}
