import type {
  Client,
  Tool,
  ToolController,
  ToolRunner,
} from "../core/engine.ts";
import { runTurn } from "../core/engine.ts";
import type { Workflow, WorkflowScope } from "../core/workflow.ts";
import type {
  Message,
  PromptProgress,
  Result,
  ViseError,
} from "../core/errors.ts";
import { formatHelp } from "../output/format.ts";
import {
  handleModelCommand,
  handleNotesCommand,
  handleToolCommand,
  reportContext,
} from "./commands.ts";
import { okNoop, runCompaction } from "./compaction.ts";
import {
  handleDeleteCommand,
  handleProfileCommand,
  handleResumeCommand,
  handleSaveCommand,
} from "./session-commands.ts";
import { handleWorkflowCommand } from "./workflow-commands.ts";
import type { WorkflowCommands } from "./workflow-commands.ts";

/**
 * The outcome of a handled line. A successful turn carries the model's reply
 * and, when auto-compaction failed before the turn, an optional
 * `compactionWarning` the edge surfaces on stderr. This keeps all I/O at the
 * edge (invariant #2): the session never writes to stdout or stderr itself.
 */
export type LineResult =
  | "exit"
  | {
      ok: true;
      value: string;
      streamed?: boolean;
      compactionWarning?: ViseError;
    }
  | { ok: false; error: ViseError };

/**
 * Source of context-window data. Provided by the edge: the used count comes
 * from the server's own `usage.prompt_tokens` on the last chat call, and the
 * max comes from the server's live `/slots` report. The session only displays
 * it. This is an authoritative server count, not a local estimate.
 */
export interface ContextSource {
  /**
   * The server's token count of the most recent prompt sent (how full the
   * context is after the last turn). `undefined` until the first successful
   * chat returns a usage block.
   */
  lastPromptTokensUsed(): number | undefined;
  /** The model's maximum context window in tokens, queried live. */
  contextMax(): Promise<Result<number>>;
}

/**
 * Source of profile text. A profile is free-form instruction text appended
 * to the conversation as a user message to shape the assistant's persona.
 * The system message is never modified by profile switching (invariant:
 * this preserves prompt-prefix caching). Provided by the edge (the session
 * performs no I/O).
 */
export interface ProfileSource {
  /** Names of the available profiles (without file extension). */
  listProfiles(): Promise<Result<string[]>>;
  /** Load the full text of the named profile. Empty string when unset. */
  loadProfile(name: string): Promise<Result<string>>;
  /**
   * Initialize a new profile with a placeholder template body. Fails with a
   * `malformed` error when the name is invalid or the profile already exists.
   */
  initProfile(name: string): Promise<Result<string>>;
}

/**
 * Controller for inspecting and switching the active model.
 */
export interface ModelController {
  /** Return the currently active model identifier. */
  getModel(): string;
  /** Set the active model identifier. */
  setModel(name: string): void;
  /** Retrieve available model names from the server. */
  listModels(): Promise<Result<string[]>>;
}

/**
 * Source of note listings for the `/note` command. A note is the project's
 * combined "memories" (short facts) and "skills" (how-to procedures) store,
 * exposed to the model on demand via tools and to the user via `/note`.
 * Only listing is supported here: the model does its own reads/writes through
 * the note tools. Provided by the edge (the session performs no I/O).
 */
export interface NoteSource {
  /** List all notes with their one-line summaries. */
  listNotes(): Promise<Result<string[]>>;
  /** Initialize a new note with a placeholder template body. */
  initNote(name: string): Promise<Result<string>>;
}

/** Edge-owned workflow listing, loading, and creation. */
export interface WorkflowSource {
  listWorkflows(): Promise<
    Result<{ name: string; scope: WorkflowScope; active: boolean }[]>
  >;
  loadWorkflow(name: string): Promise<Result<Workflow>>;
  initWorkflow(name: string, scope: WorkflowScope): Promise<Result<string>>;
}

/**
 * Pre-turn hook: runs a configured shell command before every turn and returns
 * its combined output (stdout/stderr or error text). The output is injected
 * as context into the user's message so the model sees it each turn. Provided
 * by the edge (the session performs no I/O).
 */
export interface PreTurnHook {
  /** Run the pre-turn hook command and return its combined output. */
  run(): Promise<string>;
}

/**
 * Post-turn hook: runs a configured shell command after every successful turn
 * and returns its combined output (stdout/stderr or error text). The output
 * is injected as a user message after the assistant's reply, so the model
 * sees it in the next turn. Provided by the edge (the session performs no I/O).
 */
export interface PostTurnHook {
  /** Run the post-turn hook command and return its combined output. */
  run(): Promise<string>;
}

/**
 * A snapshot of a conversation at a point in time, persisted for later
 * resumption. The `messages` array includes the system message; `activeProfile`
 * is the profile name that was active when the snapshot was taken (undefined
 * when no profile was set).
 */
export interface SavedSession {
  messages: Message[];
  activeProfile: string | undefined;
  savedAt: string;
}

/**
 * Source of saved session snapshots. The session calls `save` after every
 * successful normal turn (auto-save) and calls `load`/`list` for the
 * `/resume` command. Provided by the edge (the session performs no I/O).
 */
export interface SessionSource {
  /**
   * Persist the conversation under the given name (the auto-save path).
   * Resolve a collision on the initial save; overwrite the resolved name on
   * subsequent saves. The final name is returned. Fails with a `malformed`
   * error when the name is invalid.
   */
  save(
    name: string,
    messages: Message[],
    activeProfile: string | undefined,
    overwrite: boolean,
  ): Promise<Result<string>>;
  /**
   * Persist the current conversation under a user-chosen name (the manual
   * `/save <name>` path). When `name` is already taken, a numeric suffix is
   * appended and the final name is returned as the result value. Fails with
   * a `malformed` error when the name is invalid.
   */
  saveNamed(
    name: string,
    messages: Message[],
    activeProfile: string | undefined,
  ): Promise<Result<string>>;
  /** Load a saved session by name. Fails with a `malformed` error when not found. */
  load(name: string): Promise<Result<SavedSession>>;
  /** List all saved session names (without file extension). */
  list(): Promise<Result<string[]>>;
  /**
   * Delete a saved session by name. Fails with a `malformed` error when the
   * session does not exist.
   */
  delete(name: string): Promise<Result<void>>;
}

/**
 * The subset of Session state the profile command needs, exposed to
 * `session-commands.ts` so the handler can be a plain module-level function
 * (matching the `commands.ts` pattern) rather than a private method on the
 * class. The Session implements this with closures over its own fields.
 */
export interface ProfileCommands {
  profileSource(): ProfileSource | undefined;
  activeProfile(): string | undefined;
  setActiveProfile(name: string | undefined): void;
  pushMessage(message: Message): void;
}

/**
 * The subset of Session state the resume/save commands need, exposed to
 * `session-commands.ts` so the handlers can be plain module-level functions
 * (matching the `commands.ts` pattern) rather than private methods on the
 * class. The Session implements this with closures over its own fields.
 */
export interface SessionCommands {
  sessionSource(): SessionSource | undefined;
  activeProfile(): string | undefined;
  setActiveProfile(name: string | undefined): void;
  pushMessage(message: Message): void;
  /**
   * Return the live messages array as a shallow copy (system message first).
   * Used by `/save` to snapshot the current conversation.
   */
  messages(): Message[];
  /**
   * Replace the conversation body with the given messages, keeping the live
   * system message at index 0 (invariant #6). Used by `/resume`.
   */
  resetMessages(messages: Message[]): void;
  /**
   * Set the auto-save session name. Used by `/resume` so a resumed
   * conversation keeps writing to its own file rather than colliding into a
   * freshly derived name.
   */
  setSessionName(name: string): void;
}

/**
 * The subset of Session state the compaction handler needs, exposed to
 * `compaction.ts` so the handler can be a plain module-level function
 * (matching the `commands.ts` pattern) rather than a private method on the
 * class. The Session implements this with closures over its own fields.
 */
export interface CompactionSource {
  /** The client used for the summarizing model call. */
  client: Client;
  /** Return the live messages array as a shallow copy (system message first). */
  messages(): Message[];
  /**
   * Replace the conversation body with the given messages, keeping the live
   * system message at index 0 (invariant #6). Used after summarizing.
   */
  resetMessages(messages: Message[]): void;
}

/**
 * Auto-compaction triggers when the last turn's server-reported token count
 * reaches this fraction of the model's context window. Chosen high enough that
 * a normal turn only compacts when overflow is genuinely imminent.
 */
const COMPACTION_THRESHOLD = 0.9;

/**
 * Derive an auto-save session name from a user-typed message. Pure: no I/O,
 * no globals. Takes the message, trims, takes the first non-empty line,
 * replaces path separators and dots with hyphens, collapses consecutive
 * hyphens into one, drops leading/trailing hyphens, and truncates to 40
 * characters. Returns a non-empty string; falls back to "session" when the
 * result is blank after trimming.
 */
function deriveSessionName(message: string): string {
  const trimmed = message.trim();
  if (trimmed === "") return "session";
  const firstLine = trimmed.split("\n")[0] ?? "";
  const sanitized = firstLine
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\./g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
  if (sanitized === "") return "session";
  const maxLen = 40;
  return sanitized.length > maxLen ? sanitized.slice(0, maxLen) : sanitized;
}

/**
 * Edge-provided options for constructing a Session. Groups the optional
 * edge services (model controller, profile source, hooks) and the required
 * context source + cwd into a single object, so adding a new service is
 * a new optional field, not a new positional parameter.
 */
export interface SessionOptions {
  cwd: string;
  context: ContextSource;
  modelController?: ModelController;
  toolController?: ToolController;
  profileSource?: ProfileSource;
  noteSource?: NoteSource;
  workflowSource?: WorkflowSource;
  preTurnHooks: PreTurnHook[];
  postTurnHooks: PostTurnHook[];
  /**
   * Edge-provided callback invoked with each token of the user turn's reply as
   * it streams in. The session performs no I/O itself (invariant #2); this is
   * the edge's sink for streamed tokens. When absent, replies are not
   * streamed. Used only for normal user turns, not for compaction or other
   * internal model calls.
   */
  onToken?: (token: string) => void;
  /**
   * Edge-provided callback invoked with each token of the model's thinking
   * (reasoning_content) as it streams in, before the reply content. The
   * session performs no I/O itself (invariant #2); this is the edge's sink
   * for streamed thinking tokens, so the edge can show a live count without
   * printing the thinking text. Used for all model calls including tool
   * rounds.
   */
  onThinking?: (token: string) => void;
  /**
   * Edge-provided callback invoked with the prompt-processing progress
   * reported in every streaming chunk (llama.cpp `return_progress`). The
   * session performs no I/O itself (invariant #2); this is the edge's sink
   * for the live prompt count, so it can show how many prompt tokens are
   * being computed during the silent prefill. Used for all model calls
   * including tool rounds.
   */
  onPromptProgress?: (progress: PromptProgress) => void;
  /** Edge-provided notification for each tool invocation before execution. */
  onToolCall?: (name: string, depth?: number) => void;
  /**
   * Initial context injected as the first user message after the system
   * message. Provided by the edge at construction time; typically contains
   * the working directory's initial file structure so the model has a
   * starting map of the project without calling tools.
   */
  initialMessage?: string;
  sessionSource?: SessionSource;
  /**
   * Edge-provided callback invoked when the tool loop reaches its maximum
   * rounds. Prompts the user to continue; returns true to reset the round
   * counter and keep going, false to end the turn with an error. When absent
   * (subagents), the turn ends without prompting.
   */
  onMaxRounds?: () => Promise<boolean>;
}

/**
 * Owns the conversation state (the growing messages array) and handles
 * per-line turns. Stateless with respect to I/O: it takes the transport
 * types, context source, and working directory from the edge and never
 * touches process, stdin, or stdout itself.
 */
export class Session {
  private readonly messages: Message[];
  private readonly systemMessage: Message;
  private readonly client: Client;
  private readonly tools: ToolRunner;
  private readonly toolDefs: Tool[];
  private readonly context: ContextSource;
  private readonly modelController?: ModelController;
  private readonly toolController?: ToolController;
  private readonly profileSource?: ProfileSource;
  private readonly noteSource?: NoteSource;
  private readonly workflowSource?: WorkflowSource;
  private readonly preTurnHooks: PreTurnHook[];
  private readonly postTurnHooks: PostTurnHook[];
  private readonly cwd: string;
  private readonly onToken?: (token: string) => void;
  private readonly onThinking?: (token: string) => void;
  private readonly onPromptProgress?: (progress: PromptProgress) => void;
  private readonly onToolCall?: (name: string, depth?: number) => void;
  private readonly initialMessage?: string;
  private readonly sessionSource?: SessionSource;
  private readonly onMaxRounds?: () => Promise<boolean>;
  private activeProfile: string | undefined;
  /** The stable auto-save name, derived from first input or set by `/resume`. */
  private sessionName: string | undefined;
  /**
   * Whether this name has been persisted. A name can be assigned before its
   * first save, so its presence alone cannot distinguish collision-safe
   * initial saving from overwriting the session on subsequent saves.
   */
  private hasAutoSaved = false;
  /**
   * The AbortController for the turn in flight. A fresh controller is created
   * at the start of each normal turn; `interrupt()` aborts it so the in-flight
   * model call and tool rounds stop. `null` when no turn is running.
  */
  private currentAbort: AbortController | null = null;
  private readonly profileCommands: ProfileCommands;
  private readonly sessionCommands: SessionCommands;
  private readonly compactionSource: CompactionSource;
  private readonly workflowCommands: WorkflowCommands;

  constructor(
    client: Client,
    tools: ToolRunner,
    toolDefs: Tool[],
    options: SessionOptions,
  ) {
    this.client = client;
    this.tools = tools;
    this.toolDefs = toolDefs;
    this.context = options.context;
    this.modelController = options.modelController;
    this.toolController = options.toolController;
    this.profileSource = options.profileSource;
    this.noteSource = options.noteSource;
    this.workflowSource = options.workflowSource;
    this.preTurnHooks = options.preTurnHooks;
    this.postTurnHooks = options.postTurnHooks;
    this.cwd = options.cwd;
    this.onToken = options.onToken;
    this.onThinking = options.onThinking;
    this.onPromptProgress = options.onPromptProgress;
    this.onToolCall = options.onToolCall;
    this.initialMessage = options.initialMessage;
    this.sessionSource = options.sessionSource;
    this.onMaxRounds = options.onMaxRounds;
    this.systemMessage = {
      role: "system",
      content: `Working directory: ${options.cwd}`,
    };
    this.messages = [this.systemMessage];
    if (this.initialMessage !== undefined && this.initialMessage !== "") {
      this.messages.push({ role: "user", content: this.initialMessage });
    }
    // The command handlers are plain functions in `session-commands.ts`;
    // the Session wires them to its own state with closures, so the
    // handlers stay free of class-internal references (the `commands.ts`
    // pattern). They are wired after `this.messages` exists so the
    // closures can push/replace the conversation safely.
    this.profileCommands = {
      profileSource: () => this.profileSource,
      activeProfile: () => this.activeProfile,
      setActiveProfile: (name) => {
        this.activeProfile = name;
      },
      pushMessage: (message) => {
        this.messages.push(message);
      },
    };
    this.sessionCommands = {
      sessionSource: () => this.sessionSource,
      activeProfile: () => this.activeProfile,
      setActiveProfile: (name) => {
        this.activeProfile = name;
      },
      pushMessage: (message) => {
        this.messages.push(message);
      },
      messages: () => [...this.messages],
      resetMessages: (body) => {
        this.messages.length = 0;
        this.messages.push(this.systemMessage);
        for (const m of body) {
          this.messages.push(m);
        }
      },
      setSessionName: (name) => {
        this.sessionName = name;
        this.hasAutoSaved = true;
      },
    };
    this.compactionSource = {
      client: this.client,
      messages: () => [...this.messages],
      resetMessages: (body) => {
        this.messages.length = 0;
        this.messages.push(this.systemMessage);
        for (const m of body) {
          this.messages.push(m);
        }
      },
    };
    this.workflowCommands = {
      workflowSource: () => this.workflowSource,
      client: () => this.client,
      tools: () => this.tools,
      toolDefs: () => this.toolDefs,
      // `runWorkflow` mutates the conversation in place (the engine's
      // documented side channel), so the handler holds the live array.
      messages: () => this.messages,
      preTurnHooks: () => this.preTurnHooks,
      postTurnHooks: () => this.postTurnHooks,
      onToken: () => this.onToken,
      onThinking: () => this.onThinking,
      onPromptProgress: () => this.onPromptProgress,
      onToolCall: () => this.onToolCall,
      onMaxRounds: () => this.onMaxRounds,
      maybeAutoCompact: () => this.maybeAutoCompact(),
      save: () => this.saveSession(),
      setSessionName: (name) => (this.sessionName ??= deriveSessionName(name)),
      setCurrentAbort: (controller) => {
        this.currentAbort = controller;
      },
    };
  }

  /**
   * Handle a single non-empty line. Returns "exit" when the line is `/exit`;
   * a formatted context line for `/context`; a compaction note for `/compact`;
   * otherwise the turn outcome. An auto-compact that fails before a turn does
   * not abort the turn — the user's prompt still runs against the uncut
   * conversation — and the failure is carried as `compactionWarning` on the
   * successful result so the edge can surface it (the session performs no I/O).
   */
  async handleLine(line: string): Promise<LineResult> {
    const trimmed = line.trim();
    if (trimmed === "/exit") return "exit";
    if (trimmed === "/help")
      return {
        ok: true,
        value: formatHelp({
          hasModel: !!this.modelController,
          hasTools: !!this.toolController,
          hasProfile: !!this.profileSource,
          hasNotes: !!this.noteSource,
          hasWorkflows: !!this.workflowSource,
          hasSessions: !!this.sessionSource,
          preTurnHookCount: this.preTurnHooks.length,
          postTurnHookCount: this.postTurnHooks.length,
        }),
      };
    if (trimmed === "/context") return reportContext(this.context);
    if (trimmed === "/compact") return this.doCompact();
    if (trimmed === "/model" || trimmed.startsWith("/model ")) {
      return handleModelCommand(this.modelController, trimmed);
    }
    if (trimmed === "/tool" || trimmed.startsWith("/tool ")) {
      return handleToolCommand(
        this.toolController,
        trimmed,
        (name, enabled) => {
          // A tool's enabled state changed; tell the model so it stops calling
          // disabled tools and knows to invoke newly-enabled ones. The full
          // definition list is always sent regardless, so this is a state
          // note, not a change to the tools offered.
          this.messages.push({
            role: "user",
            content: enabled
              ? `Tool '${name}' is now enabled. You may call it.`
              : `Tool '${name}' is now disabled. Do not call it; if asked, say it is disabled.`,
          });
        },
      );
    }
    if (trimmed === "/profile" || trimmed.startsWith("/profile ")) {
      return handleProfileCommand(this.profileCommands, trimmed);
    }
    if (trimmed === "/note" || trimmed.startsWith("/note ")) {
      return handleNotesCommand(this.noteSource, trimmed);
    }
    if (trimmed === "/workflow" || trimmed.startsWith("/workflow ")) {
      return handleWorkflowCommand(this.workflowCommands, trimmed);
    }
    if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
      return handleResumeCommand(this.sessionCommands, trimmed);
    }
    if (trimmed === "/save" || trimmed.startsWith("/save ")) {
      return handleSaveCommand(this.sessionCommands, trimmed);
    }
    if (trimmed === "/delete" || trimmed.startsWith("/delete ")) {
      return handleDeleteCommand(this.sessionCommands, trimmed);
    }
    const abort = new AbortController();
    this.currentAbort = abort;
    try {
      await this.runHooks(this.preTurnHooks);
      this.messages.push({ role: "user", content: line });
      if (this.sessionName === undefined) {
        this.sessionName = deriveSessionName(line);
      }
      const auto = await this.maybeAutoCompact();
      const streamed = this.onToken !== undefined;
      const turn = await runTurn(
        this.client,
        this.tools,
        this.messages,
        this.toolDefs,
        {
          onToken: this.onToken,
          onThinking: this.onThinking,
          onPromptProgress: this.onPromptProgress,
          onToolCall: this.onToolCall,
          onMaxRounds: this.onMaxRounds,
          abort: abort.signal,
        },
      );
      if (!turn.ok) return turn;
      await this.runHooks(this.postTurnHooks);
      await this.saveSession();
      // A failed auto-compact is non-fatal: proceed with the (uncut)
      // conversation and let the edge report that compaction did not happen.
      // The `streamed` flag tells the edge the reply text (if any) was
      // already written token-by-token, so it only needs to emit the trailing
      // newline rather than re-print.
      if (auto.ok) {
        return { ok: true, value: turn.value, streamed };
      }
      return {
        ok: true,
        value: turn.value,
        streamed,
        compactionWarning: auto.error,
      };
    } finally {
      this.currentAbort = null;
    }
  }

  /**
   * Interrupt the turn in flight, if any. Aborts the in-flight model call and
   * stops the tool loop between rounds; the running turn's promise then
   * resolves with an `interrupted` error. Returns `true` if a turn was running
   * and was interrupted, `false` if no turn was running (no-op). Called by the
   * edge's SIGINT handler, which uses the return value to decide whether to
   * interrupt (turn in flight) or exit (idle prompt).
   */
  interrupt(): boolean {
    if (this.currentAbort) {
      this.currentAbort.abort();
      return true;
    }
    return false;
  }

  /**
   * The AbortSignal for the turn in flight, or `undefined` when no turn is
   * running. The subagent handler forwards this into its `runSubagent`
   * callbacks so a subagent's in-flight model call is interrupted together
   * with the parent's turn (the same Ctrl+C that aborts the parent aborts the
   * subagent).
   */
  get currentAbortSignal(): AbortSignal | undefined {
    return this.currentAbort?.signal;
  }

  /**
   * Run all hooks in the given list in parallel and push each non-blank
   * output as a user message, in config order. Shared by the pre-turn and
   * post-turn paths so the parallel execution, non-blank filter, and
   * injection logic live in one place.
   */
  private async runHooks(hooks: PreTurnHook[] | PostTurnHook[]): Promise<void> {
    if (hooks.length === 0) return;
    const outputs = await Promise.all(hooks.map((h) => h.run()));
    for (const output of outputs) {
      if (output.trim() !== "") {
        this.messages.push({ role: "user", content: output });
      }
    }
  }

  /**
   * Auto-compaction guard, run before every normal turn. Returns a successful
   * no-op when nothing needed compacting (cold start, below threshold, or
   * nothing to summarize). When the last turn's server-reported usage is at or
   * above `COMPACTION_THRESHOLD` of the live window, performs the same
   * compaction as `/compact`. Best-effort: any failure is returned so the
   * caller can log it, but never blocks the turn.
   */
  private async maybeAutoCompact(): Promise<Result<string>> {
    const lastUsed = this.context.lastPromptTokensUsed();
    if (lastUsed === undefined) return okNoop();
    const max = await this.context.contextMax();
    if (!max.ok) return max;
    if (lastUsed < COMPACTION_THRESHOLD * max.value) return okNoop();
    return this.doCompact();
  }

  /**
   * Shared compaction body: delegates to `compaction.ts` to split the
   * conversation, summarize the older portion, and replace the conversation
   * with the summary plus the recent turns. On any error the conversation is
   * left untouched and the error is returned.
   */
  private async doCompact(): Promise<Result<string>> {
    return runCompaction(this.compactionSource);
  }

  /**
   * Auto-save the current conversation after a successful normal turn.
  * Silently ignores I/O errors — a save failure must not interrupt the
  * turn. The snapshot is written under a stable name derived from the first
  * user message, with collisions resolved on the initial save.
   */
  /**
   * The currently active profile name, or undefined when none is set.
   * Exposed for the edge's `self` tool, which reports the agent's identity
   * (the session's active-profile state is otherwise private).
   */
  getActiveProfile(): string | undefined {
    return this.activeProfile;
  }

  private async saveSession(): Promise<void> {
    if (!this.sessionSource) return;
    if (this.sessionName === undefined) return;
    try {
      const saved = await this.sessionSource.save(
        this.sessionName,
        [...this.messages],
        this.activeProfile,
        this.hasAutoSaved,
      );
      if (saved.ok) {
        this.sessionName = saved.value;
        this.hasAutoSaved = true;
      }
    } catch {
      // Persistence is best-effort; a rejected edge promise must not fail a turn.
    }
  }
}
