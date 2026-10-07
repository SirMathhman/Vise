import { resolve } from "node:path";
import type { Tool, ToolController, ToolRunner } from "./core/engine.ts";
import { dataDirFor } from "./data-dir.ts";
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

/** Tag every tool in a definition group with its category. */
const inCategory = (category: string, defs: Tool[]): Tool[] =>
  defs.map((t) => ({ ...t, category }));

/** Tool definitions exposed to the model, in prompt order. */
const allTools: Tool[] = [
  ...inCategory("files", fileTools),
  ...inCategory("shell", shellTools),
  ...inCategory("notes", noteTools),
  ...inCategory(
    "agent",
    agentTools.filter((t) => t.function.name !== "run_subagent"),
  ),
  ...inCategory("browser", browserTools),
  ...inCategory(
    "agent",
    agentTools.filter((t) => t.function.name === "run_subagent"),
  ),
];

/** The tool list the app uses: `search_tools` added and the non-core tools deferred. */
export const tools: Tool[] = deferTools([
  ...allTools,
  { ...searchToolsDef, category: "search" },
]);

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

/**
 * Resolve the named path arguments against the session `root`, so a relative
 * path (or a missing one, meaning "here") means a place inside the root no
 * matter what the process working directory is. Absolute paths pass through.
 */
function rooted(
  root: string,
  keys: string[],
  handler: ToolHandler,
): ToolHandler {
  return (args) => {
    const next = { ...args };
    for (const key of keys) {
      const value = args[key];
      if (value === undefined) next[key] = root;
      else if (typeof value === "string" && value !== "") {
        next[key] = resolve(root, value);
      }
    }
    return handler(next);
  };
}

/** The built-in handlers for a session whose root directory is `root`. */
function baseHandlers(root: string): Record<string, ToolHandler> {
  const notes = dataDirFor(root);
  return {
    list_directory: rooted(root, ["path"], listDirectory),
    read_file: rooted(root, ["path"], readFile),
    create_file: rooted(root, ["path"], createFile),
    edit_file: rooted(root, ["path"], editFile),
    delete_file: rooted(root, ["path"], deleteFile),
    delete_directory: rooted(root, ["path"], deleteDirectory),
    run_powershell: (args) => runPowershell(args, root),
    wait_for_process: waitForProcess,
    kill_process: killProcess,
    find_files: rooted(root, ["root"], findFiles),
    search_files: rooted(root, ["path"], searchFiles),
    list_notes: (args) => listNotesTool(args, notes),
    read_note: (args) => readNoteTool(args, notes),
    save_note: (args) => saveNoteTool(args, notes),
    delete_note: (args) => deleteNoteTool(args, notes),
  };
}

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

  list(): {
    name: string;
    enabled: boolean;
    category?: string;
  }[] {
    return this.defs.map((t) => ({
      name: t.function.name,
      enabled: !this.disabled.has(t.function.name),
      category: t.category,
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
  root: string = process.cwd(),
): ToolRunner {
  const handlers: Record<string, ToolHandler> = {
    ...baseHandlers(root),
    ...extra,
  };
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
