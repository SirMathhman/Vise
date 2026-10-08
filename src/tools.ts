import { resolve } from "node:path";
import { noAudit, type AuditSink } from "./core/audit.ts";
import type { Tool, ToolController, ToolRunner } from "./core/engine.ts";
import { auditCall, auditRefused } from "./tools/audit-call.ts";
import { dataDirFor, globalDataDir } from "./data-dir.ts";
import { NoteStore } from "./note-store.ts";
import { agentTools } from "./tools/defs/agent.ts";
import { browserTools } from "./tools/defs/browser.ts";
import { fileTools } from "./tools/defs/files.ts";
import { imageTools } from "./tools/defs/images.ts";
import { noteTools } from "./tools/defs/notes.ts";
import type { ImageOutbox } from "./tools/images.ts";
import { tempTools } from "./tools/defs/temp.ts";
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
import { currentToolScope } from "./tools/agent-scope.ts";
import { deferTools, searchToolsDef } from "./tools/search-tools.ts";
import { killProcess, runPowershell, waitForProcess } from "./tools/shell.ts";
import {
  isTooLarge,
  truncateInline,
  type TempStore,
} from "./tools/temp-store.ts";

/** Tag every tool in a definition group with its category. */
const inCategory = (category: string, defs: Tool[]): Tool[] =>
  defs.map((t) => ({ ...t, category }));

/** Flag tools (all of `defs`, or just the `only` names) as needing a file system. */
const needsFileSystem = (defs: Tool[], only?: string[]): Tool[] =>
  defs.map((t) =>
    only === undefined || only.includes(t.function.name)
      ? { ...t, requiresFileSystem: true }
      : t,
  );

/** Flag tools (all of `defs`, or just the `only` names) as needing a model that can see images. */
const needsVision = (defs: Tool[], only?: string[]): Tool[] =>
  defs.map((t) =>
    only === undefined || only.includes(t.function.name)
      ? { ...t, requiresVision: true }
      : t,
  );

/** Tool definitions exposed to the model, in prompt order. */
const allTools: Tool[] = [
  ...inCategory("files", needsFileSystem(fileTools)),
  ...inCategory("files", needsVision(needsFileSystem(imageTools))),
  ...inCategory("shell", needsFileSystem(shellTools)),
  ...inCategory("notes", noteTools),
  ...inCategory("temp", tempTools),
  ...inCategory(
    "agent",
    agentTools.filter((t) => t.function.name !== "run_subagent"),
  ),
  ...inCategory(
    "browser",
    // Its Playwright snippet runs with the user's full privileges, files included.
    needsVision(needsFileSystem(browserTools, ["browser_run_code"]), [
      "browser_screenshot",
    ]),
  ),
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
  signal?: AbortSignal,
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
 * matter what the process working directory is. This is a default, not a
 * sandbox: absolute paths and `..` still reach outside the root.
 */
function resolveAgainstRoot(
  root: string,
  keys: string[],
  handler: ToolHandler,
): ToolHandler {
  return (args) => {
    const next = { ...args };
    for (const key of keys) {
      const value = args[key];
      if (value === undefined || value === "") next[key] = root;
      else if (typeof value === "string") {
        next[key] = resolve(root, value);
      }
    }
    return handler(next);
  };
}

/** Whether a tool is absent from a session with no working directory. */
export const isFileSystemTool = (tool: Tool): boolean =>
  tool.requiresFileSystem === true;

/** The built-in handlers for a session whose root directory is `root`. */
function baseHandlers(root: string): Record<string, ToolHandler> {
  const notes = new NoteStore({
    project: dataDirFor(root),
    global: globalDataDir,
  });
  return {
    list_directory: resolveAgainstRoot(root, ["path"], listDirectory),
    read_file: resolveAgainstRoot(root, ["path"], readFile),
    create_file: resolveAgainstRoot(root, ["path"], createFile),
    edit_file: resolveAgainstRoot(root, ["path"], editFile),
    delete_file: resolveAgainstRoot(root, ["path"], deleteFile),
    delete_directory: resolveAgainstRoot(root, ["path"], deleteDirectory),
    run_powershell: (args) => runPowershell(args, root),
    wait_for_process: waitForProcess,
    kill_process: killProcess,
    find_files: resolveAgainstRoot(root, ["root"], findFiles),
    search_files: resolveAgainstRoot(root, ["path"], searchFiles),
    list_notes: (args) => listNotesTool(args, notes),
    read_note: (args) => readNoteTool(args, notes),
    save_note: (args) => saveNoteTool(args, notes),
    delete_note: (args) => deleteNoteTool(args, notes),
  };
}

/** Tools that bound their own output: the temp tools, and browser_read (which saves a long page's text itself and always shows its element outline). */
const TEMP_TOOLS = new Set([
  "read_temp",
  "search_temp",
  "list_temp",
  "browser_read",
]);

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
  private baseline: Map<string, boolean> | undefined;

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

  setBaseline(states: Map<string, boolean> | undefined): void {
    this.baseline = states;
  }

  baselineEnabled(name: string): boolean {
    return this.baseline?.get(name) ?? this.isEnabled(name);
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
  toolDefs: Tool[] = tools,
  /** Where a result too big to show goes instead (the temp tools read it back). */
  spill?: TempStore,
  /** Where tools put the pictures they produce; the runner hands them over with the result. */
  images?: ImageOutbox,
  /** Hears every tool call with its whole result and how long it took. */
  audit: AuditSink = noAudit,
): ToolRunner {
  const handlers: Record<string, ToolHandler> = {
    ...baseHandlers(root),
    ...extra,
  };
  // A tool that is not offered to the session has no handler either.
  const offered = new Set(toolDefs.map((t) => t.function.name));
  for (const name of Object.keys(handlers)) {
    if (!offered.has(name)) delete handlers[name];
  }
  return {
    takeImages: () => images?.take() ?? [],
    async run(name, args, signal): Promise<string> {
      const handler = handlers[name];
      if (handler === undefined) {
        return auditRefused(audit, name, args, `error: unknown tool ${name}`);
      }
      // A subagent limited by its profile may use exactly its listed tools; anyone else, what the session has enabled.
      const limited = currentToolScope();
      if (limited ? !limited.has(name) : !toolController.isEnabled(name)) {
        const why = limited ? "not available to this agent" : "disabled";
        return auditRefused(audit, name, args, `error: tool ${name} is ${why}`);
      }
      const result = await auditCall(audit, name, args, () =>
        handler(args, signal),
      );
      // The temp tools bound their own output; everything else too big to show is saved instead.
      if (TEMP_TOOLS.has(name) || !isTooLarge(result)) return result;
      // With nowhere to save it, a big result is cut rather than let through whole.
      return spill
        ? spill.spill(name, result)
        : truncateInline(result, "there is nowhere to save it");
    },
  };
}
