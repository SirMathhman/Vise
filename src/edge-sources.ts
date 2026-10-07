import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Message, Result } from "./core/errors.ts";
import { buildInitialTree } from "./fs-tree.ts";
import { formatNoteEntry, initNote, listNotes } from "./notes.ts";
import {
  initProfile,
  listProfiles,
  readProfile,
  readProfileTools,
  setProfileTools,
} from "./profiles.ts";
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
} from "./sessions.ts";
import { initWorkflow, listWorkflows, loadWorkflow } from "./workflows.ts";

/**
 * Edge implementation of ProfileSource backed by a `profiles/` directory of
 * `.md` files. Thin adapter over the shared profile-file I/O in
 * `src/profiles.ts` (invariant #2: edge owns I/O; the session only asks for
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
  constructor(readonly command: string) {}

  async run(): Promise<string> {
    try {
      const res = await new Promise<{
        status: number;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const proc = spawn("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          this.command,
        ]);
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
        }, 30_000);
        proc.stdout.on("data", (d: Buffer) => {
          stdout += d.toString("utf8");
        });
        proc.stderr.on("data", (d: Buffer) => {
          stderr += d.toString("utf8");
        });
        proc.on("close", (status) => {
          clearTimeout(timer);
          if (timedOut) {
            resolve({ status: -1, stdout, stderr });
          } else {
            resolve({ status: status ?? -1, stdout, stderr });
          }
        });
        proc.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
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
  constructor(private readonly base: string) {}

  async listNotes(): Promise<Result<string[]>> {
    const notes = listNotes(this.base);
    return {
      ok: true,
      value: notes.map(formatNoteEntry),
    };
  }

  async initNote(name: string): Promise<Result<string>> {
    try {
      initNote(this.base, name);
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
 * `src/sessions.ts` (invariant #2: edge owns I/O; the session only asks for
 * messages and profile names).
 */
export class FileSessionSource implements SessionSource {
  constructor(private readonly base: string) {}

  async save(
    id: string | undefined,
    name: string,
    messages: Message[],
    activeProfile: string | undefined,
  ): Promise<Result<string>> {
    return saveSession(this.base, id, name, messages, activeProfile);
  }

  async load(ref: string): Promise<Result<SavedSession>> {
    return loadSession(this.base, ref);
  }

  async list(): Promise<Result<SessionEntry[]>> {
    return { ok: true, value: listSessions(this.base) };
  }

  async delete(ref: string): Promise<Result<string>> {
    return deleteSession(this.base, ref);
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

/**
 * Read hook commands from `.viserc.json` if present.
 *
 * Each hook key (`preTurnCommand`, `postTurnCommand`) accepts either a
 * single command string or an array of command strings. An array produces
 * one hook per entry; all hooks of a kind run in parallel each turn.
 */
export function loadHookCommands(): { pre?: string[]; post?: string[] } {
  const configPath = join(process.cwd(), ".viserc.json");
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf8");
    const config = JSON.parse(raw);
    const result: { pre?: string[]; post?: string[] } = {};
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
  private readonly listeners = new Set<() => void>();

  constructor() {
    const commands = loadHookCommands();
    this.pre = (commands.pre ?? []).map((c) => new ShellHook(c));
    this.post = (commands.post ?? []).map((c) => new ShellHook(c));
  }

  /** Be told after every successful save (frontends refresh their hook views). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  create(command: string): ShellHook {
    return new ShellHook(command);
  }

  save(hooks: { pre: string[]; post: string[] }): Result<void> {
    const configPath = join(process.cwd(), ".viserc.json");
    try {
      const config: Record<string, unknown> = existsSync(configPath)
        ? JSON.parse(readFileSync(configPath, "utf8"))
        : {};
      for (const [key, list] of [
        ["preTurnCommand", hooks.pre],
        ["postTurnCommand", hooks.post],
      ] as const) {
        if (list.length === 0) delete config[key];
        else config[key] = list;
      }
      const temp = `${configPath}.tmp`;
      writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
      renameSync(temp, configPath);
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
    for (const listener of this.listeners) listener();
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
export function buildInitialMessage(cwd: string, dataBase: string): string {
  const initialTree = buildInitialTree(cwd);
  const agentsMd = loadAgentsMd(cwd);
  const availableProfiles = listProfiles(dataBase);
  const availableNotes = listNotes(dataBase);
  return (
    `Here is the initial directory structure of the working directory:\n${initialTree}` +
    (agentsMd !== ""
      ? `\n\nHere are the agent instructions for this project (AGENTS.md):\n${agentsMd}`
      : "") +
    (availableProfiles.length > 0
      ? `\n\nHere are the available profiles:\n${availableProfiles.join(", ")}`
      : "") +
    (availableNotes.length > 0
      ? `\n\nHere are the available notes:\n${availableNotes
          .map(formatNoteEntry)
          .join("\n")}`
      : "")
  );
}
