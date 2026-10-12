import { spawnPowerShell } from "./tools/shell.ts";
import { writeFileAtomic } from "./stores/atomic-write.ts";
import { config } from "./config.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalDataDir } from "./data-dir.ts";
import type { SearchHit } from "./repl/ports.ts";
import type { Message, Result } from "@vise/core";
import type { GoalTraceEntry } from "@vise/core";
import type { TodoItem } from "@vise/core";
import {
  parseToolHookEntries,
  toolHookConfig,
  type ToolHookEntry,
} from "@vise/core";
import { buildInitialTree } from "./fs-tree.ts";
import { formatNotes, formatNotesWithin } from "./stores/notes-format.ts";
import { NoteStore } from "./stores/note-store.ts";
import type { NoteScope, NoteStores } from "./stores/notes.ts";
import {
  initProfile,
  listProfiles,
  readAllProfileHooks,
  readProfile,
  readProfileTools,
  setProfileHooks,
  setProfileTools,
} from "./stores/profiles.ts";
import type {
  HookSource,
  NoteSource,
  PostTurnHook,
  PreTurnHook,
  ProfileSource,
  SavedSession,
  SessionEntry,
  SessionSource,
  WorkflowSource,
} from "./repl/session.ts";
import {
  deleteSession,
  listSessions,
  loadSession,
  saveSession,
  searchSessions,
} from "./stores/sessions.ts";
import { initWorkflow, listWorkflows, loadWorkflow } from "./stores/workflows.ts";

/** Most notes the startup message lists (the rest are reached with `list_notes`). */

/**
 * Edge implementation of ProfileSource backed by a `profiles/` directory of
 * `.md` files. Thin adapter over the shared profile-file I/O in
 * `src/stores/profiles.ts` (invariant #2: edge owns I/O; the session only asks for
 * names and text).
 */
export class FileProfileSource implements ProfileSource {
  constructor(private readonly base: string) {}

  async listProfiles(): Promise<Result<string[]>> {
    return { ok: true, value: listProfiles(this.base) };
  }

  async loadProfile(name: string): Promise<Result<string>> {
    const text = readProfile(this.base, name);
    if (text === undefined) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: `profile '${name}' not found. Run '/profile' to see available profiles.`,
        },
      };
    }
    return { ok: true, value: text };
  }

  async profileTools(name: string): Promise<Result<string[] | undefined>> {
    return { ok: true, value: readProfileTools(this.base, name) };
  }

  async setProfileTools(
    name: string,
    tools: string[] | undefined,
  ): Promise<Result<string>> {
    try {
      setProfileTools(this.base, name, tools);
      return { ok: true, value: name };
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  async profileHooks(): Promise<Result<Record<string, string[]>>> {
    return { ok: true, value: readAllProfileHooks(this.base) };
  }

  async setProfileHooks(
    name: string,
    hooks: string[],
  ): Promise<Result<string>> {
    try {
      setProfileHooks(this.base, name, hooks);
      return { ok: true, value: name };
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  async initProfile(name: string): Promise<Result<string>> {
    try {
      initProfile(this.base, name);
      return { ok: true, value: name };
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

/**
 * Edge implementation of PreTurnHook and PostTurnHook. Runs a configured shell
 * command and returns its combined stdout/stderr output (or error text).
 * The command is read from `.viserc.json` in the working directory.
 */
export class ShellHook implements PreTurnHook, PostTurnHook {
  /** `cwd` is the session root the hook runs in. */
  constructor(
    readonly command: string,
    private readonly cwd?: string,
  ) {}

  async run(): Promise<string> {
    try {
      const { proc, record } = spawnPowerShell(this.command, this.cwd);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
      }, 30_000);
      const status = await new Promise<number>((resolve, reject) => {
        proc.on("close", (code) => {
          clearTimeout(timer);
          resolve(timedOut ? -1 : (code ?? -1));
        });
        proc.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      const res = { status, stdout: record.stdout, stderr: record.stderr };
      const body = [res.stdout.trim(), res.stderr.trim()]
        .filter((s) => s !== "")
        .join("\n");
      if (res.status !== 0) {
        return `hook error (exit code ${res.status}):\n${body}`.trim();
      }
      return body;
    } catch (err) {
      return `hook error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/**
 * Edge implementation of NoteSource backed by the `notes/` directory.
 * Lists every note with its one-line summary and creates new notes. This is
 * the user's view of the same store the model edits via tools.
 */
export class FileNoteSource implements NoteSource {
  private readonly store: NoteStore;

  constructor(stores: NoteStores) {
    this.store = new NoteStore(stores);
  }

  async listNotes(): Promise<Result<string[]>> {
    const notes = this.store.list();
    return {
      ok: true,
      value: notes.length === 0 ? [] : formatNotes(notes).split("\n"),
    };
  }

  async findNotes(
    name: string,
  ): Promise<Result<{ scope: string; category: string; body: string }[]>> {
    const found = this.store
      .list()
      .filter((n) => n.name === name)
      .map((n) => ({ ...n, body: this.store.read(n) }))
      .flatMap((n) =>
        n.body === undefined
          ? []
          : [{ scope: n.scope, category: n.category, body: n.body }],
      );
    return { ok: true, value: found };
  }

  async initNote(
    name: string,
    category?: string,
    scope: NoteScope = "project",
  ): Promise<Result<string>> {
    try {
      this.store.init({ scope, category, name });
      return { ok: true, value: name };
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

/**
 * Edge implementation of SessionSource backed by a `sessions/` directory of
 * `.json` files. Thin adapter over the shared session I/O in
 * `src/stores/sessions.ts` (invariant #2: edge owns I/O; the session only asks for
 * messages and profile names).
 */
export class FileSessionSource implements SessionSource {
  constructor(private readonly base: string) {}

  async save(
    id: string | undefined,
    name: string,
    messages: Message[],
    activeProfile: string | undefined,
    todos?: TodoItem[],
    goalTrace?: GoalTraceEntry[],
  ): Promise<Result<string>> {
    return saveSession(
      this.base,
      id,
      name,
      messages,
      activeProfile,
      todos,
      goalTrace,
    );
  }

  async load(ref: string): Promise<Result<SavedSession>> {
    return loadSession(this.base, ref);
  }

  async list(): Promise<Result<SessionEntry[]>> {
    return listSessions(this.base);
  }

  async delete(ref: string): Promise<Result<string>> {
    return deleteSession(this.base, ref);
  }

  async search(text: string): Promise<Result<SearchHit[]>> {
    return searchSessions(this.base, text);
  }
}

/** Edge implementation for project and global JSON workflows. */
export class FileWorkflowSource implements WorkflowSource {
  private readonly projectBase: string;
  private readonly globalBase: string;

  constructor(projectBase: string, globalBase: string) {
    this.projectBase = projectBase;
    this.globalBase = globalBase;
  }

  async listWorkflows() {
    return {
      ok: true as const,
      value: listWorkflows(this.projectBase, this.globalBase),
    };
  }

  async loadWorkflow(name: string) {
    try {
      const workflow = loadWorkflow(this.projectBase, this.globalBase, name);
      if (!workflow) {
        return {
          ok: false as const,
          error: {
            kind: "malformed" as const,
            body: `workflow '${name}' not found. Run '/workflow' to list workflows.`,
          },
        };
      }
      return { ok: true as const, value: workflow };
    } catch (err) {
      return {
        ok: false as const,
        error: {
          kind: "malformed" as const,
          body: `workflow '${name}' is invalid: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }
  }

  async initWorkflow(name: string, scope: "project" | "global") {
    try {
      initWorkflow(
        scope === "project" ? this.projectBase : this.globalBase,
        name,
      );
      return { ok: true as const, value: name };
    } catch (err) {
      return {
        ok: false as const,
        error: {
          kind: "malformed" as const,
          body: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}

/** The hooks of a project's `.viserc.json`; a key with no entries is absent. */
export interface HookConfig {
  pre?: string[];
  post?: string[];
  preTool?: ToolHookEntry[];
  postTool?: ToolHookEntry[];
}

/**
 * Read hook commands from `.viserc.json` if present.
 *
 * Each turn hook key (`preTurnCommand`, `postTurnCommand`) accepts either a
 * single command string or an array of command strings. An array produces
 * one hook per entry; all hooks of a kind run in parallel each turn. The tool
 * hook keys (`preToolCommand`, `postToolCommand`) take strings and/or
 * `{command, tools?}` objects (`parseToolHookEntries`).
 */
export function loadHookCommands(root: string = process.cwd()): HookConfig {
  const configPath = join(root, ".viserc.json");
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf8");
    const config = JSON.parse(raw);
    const result: HookConfig = {};
    const preTool = parseToolHookEntries(config.preToolCommand);
    const postTool = parseToolHookEntries(config.postToolCommand);
    if (preTool.length > 0) result.preTool = preTool;
    if (postTool.length > 0) result.postTool = postTool;
    const pre = config.preTurnCommand;
    const post = config.postTurnCommand;
    if (typeof pre === "string") {
      result.pre = [pre];
    } else if (Array.isArray(pre) && pre.every((c) => typeof c === "string")) {
      result.pre = pre;
    }
    if (typeof post === "string") {
      result.post = [post];
    } else if (
      Array.isArray(post) &&
      post.every((c) => typeof c === "string")
    ) {
      result.post = post;
    }
    return result;
  } catch {
    // Malformed config: fall back to no hooks.
  }
  return {};
}

/**
 * The process-wide hook store: the live pre/post hook lists every session
 * shares (so an edit made in one browser tab is in effect everywhere at once),
 * plus the `HookSource` that builds hooks and saves the lists into the
 * `preTurnCommand` / `postTurnCommand` keys of `.viserc.json`, leaving any
 * other keys alone. Create one per process and hand it to every
 * `createEdgeSession`. The write is a temp file plus rename, so a crash
 * mid-write cannot corrupt the config.
 */
export class HookStore implements HookSource {
  readonly pre: ShellHook[];
  readonly post: ShellHook[];
  /** Tool hooks, live like the turn hooks: edited in place, read at every tool call. */
  readonly preTool: ToolHookEntry[];
  readonly postTool: ToolHookEntry[];
  private readonly listeners = new Set<() => void>();

  /** The hooks of the project at `root` (its `.viserc.json`); defaults to the working directory. */
  constructor(private readonly root: string = process.cwd()) {
    const commands = loadHookCommands(root);
    this.pre = (commands.pre ?? []).map((c) => new ShellHook(c, root));
    this.post = (commands.post ?? []).map((c) => new ShellHook(c, root));
    this.preTool = commands.preTool ?? [];
    this.postTool = commands.postTool ?? [];
  }

  /** Be told after every successful save (frontends refresh their hook views). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Refresh every view of the hooks (e.g. after a profile's own hooks changed). */
  notify(): void {
    for (const listener of this.listeners) listener();
  }

  create(command: string): ShellHook {
    return new ShellHook(command, this.root);
  }

  save(hooks: {
    pre: string[];
    post: string[];
    preTool?: ToolHookEntry[];
    postTool?: ToolHookEntry[];
  }): Result<void> {
    const configPath = join(this.root, ".viserc.json");
    try {
      const config: Record<string, unknown> = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, "utf8"))
        : {};
      // A list the caller does not mention keeps what the file has.
      const lists: [string, (string | ToolHookEntry)[]][] = [
        ["preTurnCommand", hooks.pre],
        ["postTurnCommand", hooks.post],
        ...(hooks.preTool
          ? [["preToolCommand", hooks.preTool.map(toolHookConfig)] as [string, (string | ToolHookEntry)[]]]
          : []),
        ...(hooks.postTool
          ? [["postToolCommand", hooks.postTool.map(toolHookConfig)] as [string, (string | ToolHookEntry)[]]]
          : []),
      ];
      for (const [key, list] of lists) {
        if (list.length === 0) delete config[key];
        else config[key] = list;
      }
      writeFileAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: `cannot save .viserc.json: ${reason}`,
        },
      };
    }
    this.notify();
    return { ok: true, value: undefined };
  }
}

/**
 * Read the project's `AGENTS.md` agent-instructions file from the working
 * directory. Returns its full text, or an empty string when the file is
 * absent or unreadable (auto-load is best-effort; a missing file must not
 * prevent startup). Edge module: performs `node:fs` I/O (invariant #2).
 */
export function loadAgentsMd(dir: string): string {
  try {
    return readFileSync(join(dir, "AGENTS.md"), "utf8");
  } catch {
    return "";
  }
}

/**
 * Build the conversation's first user message (after the system message): a
 * capped directory tree, the project's `AGENTS.md` agent-instructions file
 * when present, a comma-separated list of available profile names when the
 * `.vise/profiles/` directory has entries, and a list of available notes
 * (name — summary) when the `.vise/notes/` directory has entries. Each
 * section is conditionally included only when non-empty. This is a one-shot
 * edge value built at construction (invariant #2); the `Session` receives the
 * result as an opaque `initialMessage` string and injects it once.
 */
export function buildInitialMessage(
  cwd: string | undefined,
  dataBase: string,
  globalBase: string = globalDataDir,
): string {
  const initialTree = cwd === undefined ? "" : buildInitialTree(cwd);
  const agentsMd = cwd === undefined ? "" : loadAgentsMd(cwd);
  const availableProfiles = listProfiles(dataBase);
  const availableNotes = new NoteStore({
    project: dataBase,
    global: globalBase,
  }).list();
  return (
    (cwd === undefined
      ? ""
      : `Here is the initial directory structure of the working directory:\n${initialTree}`) +
    (agentsMd !== ""
      ? `\n\nHere are the agent instructions for this project (AGENTS.md):\n${agentsMd}`
      : "") +
    (availableProfiles.length > 0
      ? `\n\nHere are the available profiles:\n${availableProfiles.join(", ")}`
      : "") +
    (availableNotes.length > 0
      ? `\n\nHere are the available notes, by scope and category (global notes are shared by every project; list_notes with a scope and/or category lists just that group):\n${formatNotesWithin(availableNotes, config.startupNoteLimit)}`
      : "")
  );
}
