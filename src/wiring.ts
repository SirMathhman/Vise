import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { BACKEND, LlmClient } from "./client/llm.ts";
import { dataDir } from "./data-dir.ts";
import type { Client, ToolController } from "./core/engine.ts";
import type { Message, PromptProgress, Result } from "./core/errors.ts";
import { buildInitialTree } from "./fs-tree.ts";
import { formatNoteEntry, initNote, listNotes } from "./notes.ts";
import { initProfile, listProfiles, readProfile } from "./profiles.ts";
import type {
  NoteSource,
  PostTurnHook,
  PreTurnHook,
  ProfileSource,
  SavedSession,
  SessionSource,
  WorkflowSource,
} from "./repl/session.ts";
import { Session } from "./repl/session.ts";
import {
  listSessions,
  loadSession,
  saveAutoSession,
  saveNamedSession,
} from "./sessions.ts";
import { makeAskUserHandler, type UserPrompter } from "./tools/ask-user.ts";
import { makeSelfHandler } from "./tools/self.ts";
import { makeSubagentHandler } from "./tools/subagent.ts";
import { createToolRunner, toolController, tools } from "./tools.ts";
import { initWorkflow, listWorkflows, loadWorkflow } from "./workflows.ts";

/**
 * Shared edge wiring for the Vise frontends (the interactive terminal driver
 * and the web driver). Constructs the `LlmClient`, every edge data source
 * (profiles, notes, sessions, workflows, hooks), the composed `ToolRunner`
 * (with `run_subagent` / `ask_user` / `self` extras), and the `Session` — the
 * full edge stack both frontends reuse, so the web UI and the terminal share
 * the exact same conversation state, tools, and services.
 *
 * This is the "thin wiring" that `index.ts` and the web driver both call into
 * (invariant #4: edge → core; invariant #2: all I/O lives at the edge). The
 * frontend-specific collaborators — the display callbacks (`onToken`, etc.),
 * the `ask_user` prompter, and the max-tool-rounds consent callback — are
 * passed in, because each frontend presents mid-turn questions and streamed
 * progress differently (a terminal prompt vs. a WebSocket message).
 *
 * The `ToolRunner` has a structural self-reference (`run_subagent` dispatches
 * back through the composed runner) and the `self` / `run_subagent` handlers
 * read the `Session` (active profile, in-flight abort signal) that requires
 * the `ToolRunner` in its own constructor. Both cycles are broken with
 * lazily-resolving closures over `sessionRef` / `toolRunner`, which are
 * filled before any turn runs.
 */

/**
 * Edge implementation of ProfileSource backed by a `profiles/` directory of
 * `.md` files. Thin adapter over the shared profile-file I/O in
 * `src/profiles.ts` (invariant #2: edge owns I/O; the session only asks for
 * names and text).
 */
class FileProfileSource implements ProfileSource {
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
class ShellHook implements PreTurnHook, PostTurnHook {
  private readonly command: string;

  constructor(command: string) {
    this.command = command;
  }

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
class FileNoteSource implements NoteSource {
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
class FileSessionSource implements SessionSource {
  constructor(private readonly base: string) {}

  async save(
    messages: Message[],
    activeProfile: string | undefined,
  ): Promise<Result<void>> {
    return saveAutoSession(this.base, messages, activeProfile);
  }

  async saveNamed(
    name: string,
    messages: Message[],
    activeProfile: string | undefined,
  ): Promise<Result<void>> {
    return saveNamedSession(this.base, name, messages, activeProfile);
  }

  async load(name: string): Promise<Result<SavedSession>> {
    return loadSession(this.base, name);
  }

  async list(): Promise<Result<string[]>> {
    return { ok: true, value: listSessions(this.base) };
  }
}

/** Edge implementation for project and global JSON workflows. */
class FileWorkflowSource implements WorkflowSource {
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
function loadHookCommands(): { pre?: string[]; post?: string[] } {
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
 * Read the project's `AGENTS.md` agent-instructions file from the working
 * directory. Returns its full text, or an empty string when the file is
 * absent or unreadable (auto-load is best-effort; a missing file must not
 * prevent startup). Edge module: performs `node:fs` I/O (invariant #2).
 */
function loadAgentsMd(dir: string): string {
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
function buildInitialMessage(cwd: string, dataBase: string): string {
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

/**
 * Frontend-specific collaborators passed into `createEdgeSession`. These are
 * the seams that differ between the terminal and web frontends: how streamed
 * tokens/thinking/progress/tool calls are surfaced, how the user is asked a
 * question mid-turn (`ask_user`), and how max-tool-rounds consent is
 * collected. The edge services and `Session` are identical regardless of
 * which frontend calls in.
 */
export interface EdgeSessionOptions {
  /** Surfaced with each token of the user turn's reply as it streams in. */
  onToken?: (token: string) => void;
  /** Surfaced with each token of the model's thinking as it streams in. */
  onThinking?: (token: string) => void;
  /** Surfaced with prompt-processing progress during the silent prefill. */
  onPromptProgress?: (progress: PromptProgress) => void;
  /** Notified of each tool invocation before execution. */
  onToolCall?: (name: string, depth?: number) => void;
  /** Collects the user's answer to an `ask_user` tool call. */
  askUser: UserPrompter;
  /** Prompts the user to continue past the maximum tool rounds. */
  onMaxRounds: () => Promise<boolean>;
}

/** The edge services a frontend needs after construction. */
export interface EdgeSession {
  /** The conversation orchestrator both frontends drive. */
  session: Session;
  /** The LLM transport (the sole network-I/O module). */
  client: Client;
  /** The model-facing tool enable/disable controller. */
  toolController: ToolController;
  /** The pre-turn hook commands from `.viserc.json`. */
  preTurnHooks: string[];
  /** The post-turn hook commands from `.viserc.json`. */
  postTurnHooks: string[];
}

/**
 * Construct the full edge stack: the `LlmClient`, every edge data source, the
 * composed `ToolRunner`, and the `Session`. Shared by the terminal and web
 * frontends so they drive an identical `Session`. See the module doc for the
 * self-reference and session-reference cycles broken with lazily-resolving
 * closures.
 */
export function createEdgeSession(options: EdgeSessionOptions): EdgeSession {
  const cwd = process.cwd();
  const hookCommands = loadHookCommands();
  const preTurnHooks = (hookCommands.pre ?? []).map(
    (cmd) => new ShellHook(cmd),
  );
  const postTurnHooks = (hookCommands.post ?? []).map(
    (cmd) => new ShellHook(cmd),
  );

  const client = new LlmClient();

  // Single directory that holds every runtime data store (profiles/, notes/,
  // sessions/) so the working directory is not polluted by them. The edge I/O
  // modules each join this `base` with their own subdirectory, so pointing the
  // data sources at `.vise/` relocates all three stores under it.
  const profileSource = new FileProfileSource(dataDir);
  const sessionSource = new FileSessionSource(dataDir);
  const workflowSource = new FileWorkflowSource(
    dataDir,
    join(homedir(), ".vise"),
  );

  // The subagent handler needs the ToolRunner for recursion, and the runner
  // needs the handler. Break the cycle with a lazily-resolving structural
  // runner: its `run` closure reads `toolRunner` at dispatch time (after the
  // const below is initialized), so `run_subagent` dispatches back through the
  // real runner and any subagent tool call routes through the composed handler.
  // The `self` and `run_subagent` handlers also read the `Session` (active
  // profile, in-flight abort signal) that is constructed after the runner; the
  // `sessionRef` holder is filled before any turn runs.
  const sessionRef: { current: Session } = {
    current: null as unknown as Session,
  };
  const toolRunner = createToolRunner({
    run_subagent: makeSubagentHandler(
      client,
      profileSource,
      cwd,
      {
        run: (name: string, args: Record<string, unknown>) =>
          toolRunner.run(name, args),
      },
      tools,
      {
        onToken: options.onToken,
        onThinking: options.onThinking,
        onPromptProgress: options.onPromptProgress,
        onToolCall: options.onToolCall,
      },
      (operation) => client.withPreservedSlotCache(operation),
      () => sessionRef.current.currentAbortSignal,
    ),
    ask_user: makeAskUserHandler(options.askUser),
    self: makeSelfHandler({
      backend: BACKEND,
      model: () => client.getModel(),
      cwd,
      contextMax: () => client.contextMax(),
      lastPromptTokens: () => client.lastPromptTokensUsed(),
      activeProfile: () => sessionRef.current.getActiveProfile(),
      preTurnHooks: hookCommands.pre ?? [],
      postTurnHooks: hookCommands.post ?? [],
    }),
  });

  const initialMessage = buildInitialMessage(cwd, dataDir);
  const session = new Session(client, toolRunner, tools, {
    cwd,
    context: client,
    modelController: client,
    toolController,
    profileSource,
    noteSource: new FileNoteSource(dataDir),
    workflowSource,
    sessionSource,
    preTurnHooks,
    postTurnHooks,
    onToken: options.onToken,
    onThinking: options.onThinking,
    onPromptProgress: options.onPromptProgress,
    onToolCall: options.onToolCall,
    initialMessage,
    onMaxRounds: options.onMaxRounds,
  });
  sessionRef.current = session;

  return {
    session,
    client,
    toolController,
    preTurnHooks: hookCommands.pre ?? [],
    postTurnHooks: hookCommands.post ?? [],
  };
}
