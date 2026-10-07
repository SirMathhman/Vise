import type {
  Client,
  Tool,
  ToolController,
  ToolRunner,
  TurnCallbacks,
} from "../core/engine.ts";
import { runTurn } from "../core/engine.ts";
import type {
  Message,
  PromptProgress,
  Result,
  ViseError,
} from "../core/errors.ts";
import { formatHelp } from "../output/format.ts";
import { SessionHooks } from "./session-hooks.ts";
import {
  handleModelCommand,
  handleNotesCommand,
  handleBurstCommand,
  handleReasoningCommand,
  handleToolCommand,
  reportContext,
  toggleNotice,
} from "./commands.ts";
import { okNoop, runCompaction } from "./compaction.ts";
import { ProfileToolGate } from "./profile-tools.ts";
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

export type {
  ContextSource,
  ProfileSource,
  ModelController,
  ReasoningController,
  NoteSource,
  WorkflowSource,
  HookSource,
  PreTurnHook,
  PostTurnHook,
  SavedSession,
  SessionEntry,
  SessionSource,
  ProfileCommands,
  SessionCommands,
  CompactionSource,
} from "./ports.ts";
import type {
  ContextSource,
  ProfileSource,
  ModelController,
  ReasoningController,
  NoteSource,
  WorkflowSource,
  HookSource,
  PreTurnHook,
  PostTurnHook,
  SessionSource,
  ProfileCommands,
  SessionCommands,
  CompactionSource,
} from "./ports.ts";

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
  // Trim again after cutting, so the name never ends in a space.
  return sanitized.length > maxLen
    ? sanitized.slice(0, maxLen).trimEnd()
    : sanitized;
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
  reasoningController?: ReasoningController;
  toolController?: ToolController;
  profileSource?: ProfileSource;
  noteSource?: NoteSource;
  workflowSource?: WorkflowSource;
  preTurnHooks: PreTurnHook[];
  postTurnHooks: PostTurnHook[];
  /** Persists hook edits (`/hooks add|remove`); without it hooks are read-only. */
  hookSource?: HookSource;
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
  /** Notified when burst mode enters or leaves an act round. */
  onBurst?: (active: boolean) => void;
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
  private readonly reasoningController?: ReasoningController;
  private readonly toolController?: ToolController;
  private burst = false;
  private pendingProfile: Message[] = [];
  private readonly isToolEnabled = (name: string): boolean =>
    this.toolController?.isEnabled(name) ?? true;
  private readonly profileSource?: ProfileSource;
  private readonly noteSource?: NoteSource;
  private readonly workflowSource?: WorkflowSource;
  private readonly hooks: SessionHooks;
  private readonly cwd: string;
  private readonly onToken?: (token: string) => void;
  private readonly onThinking?: (token: string) => void;
  private readonly onPromptProgress?: (progress: PromptProgress) => void;
  private readonly onToolCall?: (name: string, depth?: number) => void;
  private readonly onBurst?: (active: boolean) => void;
  private readonly initialMessage?: string;
  private readonly sessionSource?: SessionSource;
  private readonly onMaxRounds?: () => Promise<boolean>;
  private activeProfile: string | undefined;
  /** The session's display name: derived from the first input, or renamed. */
  private sessionName: string | undefined;
  /** The generated id of the session file; undefined until the first save. */
  private sessionId: string | undefined;
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
    this.reasoningController = options.reasoningController;
    this.toolController = options.toolController;
    this.profileSource = options.profileSource;
    this.noteSource = options.noteSource;
    this.workflowSource = options.workflowSource;
    this.hooks = new SessionHooks(options, () => this.activeProfile);
    this.cwd = options.cwd;
    this.onToken = options.onToken;
    this.onThinking = options.onThinking;
    this.onPromptProgress = options.onPromptProgress;
    this.onToolCall = options.onToolCall;
    this.onBurst = options.onBurst;
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
    this.profileCommands = this.buildProfileCommands(options.toolController);
    this.sessionCommands = {
      sessionSource: () => this.sessionSource,
      activeProfile: () => this.activeProfile,
      setActiveProfile: (name) => {
        this.activeProfile = name;
      },
      pushMessage: (message) => {
        this.messages.push(message);
      },
      messages: () => {
        this.flushPendingProfile();
        return [...this.messages];
      },
      resetMessages: (body) => {
        this.pendingProfile = [];
        this.messages.length = 0;
        this.messages.push(this.systemMessage);
        for (const m of body) {
          this.messages.push(m);
        }
      },
      currentSession: () => ({ id: this.sessionId, name: this.sessionName }),
      setSession: (id, name) => {
        this.sessionId = id;
        this.sessionName = name;
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
      preTurnHooks: () => this.hooks.applicable("pre"),
      postTurnHooks: () => this.hooks.applicable("post"),
      onToken: () => this.onToken,
      onThinking: () => this.onThinking,
      onPromptProgress: () => this.onPromptProgress,
      onToolCall: () => this.onToolCall,
      onMaxRounds: () => this.onMaxRounds,
      isToolEnabled: () => this.isToolEnabled,
      maybeAutoCompact: () => this.maybeAutoCompact(),
      save: () => this.saveSession(),
      setSessionName: (name) => (this.sessionName ??= deriveSessionName(name)),
      setCurrentAbort: (controller) => {
        this.currentAbort = controller;
      },
    };
  }

  private buildProfileCommands(
    toolController: ToolController | undefined,
  ): ProfileCommands {
    // Switching profile is lazy: its messages wait in `pendingProfile` until
    // the next turn, and each switch discards the previous switch's messages,
    // so only the last `/profile` before a turn reaches the conversation.
    const profileTools = new ProfileToolGate(toolController, (m) =>
      this.pendingProfile.push(m),
    );
    return {
      profileSource: () => this.profileSource,
      activeProfile: () => this.activeProfile,
      setActiveProfile: (name) => {
        this.activeProfile = name;
        this.pendingProfile = [];
      },
      pushMessage: (message) => {
        this.pendingProfile.push(message);
      },
      toolNames: () => profileTools.names(),
      applyProfileTools: (tools) => profileTools.apply(tools),
    };
  }

  private turnCallbacks(abort: AbortSignal): TurnCallbacks {
    return {
      onToken: this.onToken,
      onThinking: this.onThinking,
      onPromptProgress: this.onPromptProgress,
      onToolCall: this.onToolCall,
      onBurst: this.onBurst,
      onMaxRounds: this.onMaxRounds,
      isToolEnabled: this.isToolEnabled,
      burst: this.burst,
      abort,
    };
  }

  private burstCommand(line: string): Result<string> {
    return handleBurstCommand(
      () => this.burst,
      (on) => {
        this.burst = on;
        // Appended (never edited into the prompt) so the cache is kept.
        this.messages.push({
          role: "user",
          content: on
            ? "Burst mode is now on. Think once to plan, then carry the plan out with tool calls; you will not be able to think between calls. Your plan is kept in your earlier <plan> message: keep following it, one dependent call after another, until every step is done. When the plan is complete output <done/>. If a tool errors you will get to think again."
            : "Burst mode is now off. You may think before each step again.",
        });
      },
      line,
    );
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
          hasReasoning: !!this.reasoningController,
          hasTools: !!this.toolController,
          hasProfile: !!this.profileSource,
          hasNotes: !!this.noteSource,
          hasWorkflows: !!this.workflowSource,
          hasSessions: !!this.sessionSource,
          preTurnHookCount: this.hooks.pre.length,
          postTurnHookCount: this.hooks.post.length,
        }),
      };
    if (trimmed === "/context") return reportContext(this.context);
    if (trimmed === "/hooks" || trimmed.startsWith("/hooks ")) {
      return this.hooks.command(trimmed);
    }
    if (trimmed === "/compact") return this.doCompact();
    if (trimmed === "/new") return this.newConversation();
    if (trimmed === "/model" || trimmed.startsWith("/model ")) {
      return handleModelCommand(this.modelController, trimmed);
    }
    if (trimmed === "/reasoning" || trimmed.startsWith("/reasoning ")) {
      return handleReasoningCommand(this.reasoningController, trimmed);
    }
    if (trimmed === "/burst" || trimmed.startsWith("/burst ")) {
      return this.burstCommand(trimmed);
    }
    if (trimmed === "/tool" || trimmed.startsWith("/tool ")) {
      return handleToolCommand(
        this.toolController,
        trimmed,
        (names, enabled) => {
          // Tools' enabled state changed; tell the model so it stops calling
          // disabled tools and knows to invoke newly-enabled ones. The full
          // definition list is always sent regardless, so this is a state
          // note, not a change to the tools offered.
          this.messages.push({
            role: "user",
            content: toggleNotice(names, enabled),
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
      this.flushPendingProfile();
      await this.hooks.refresh();
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
      this.flushPendingProfile();
      await this.runHooks("pre");
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
        this.turnCallbacks(abort.signal),
      );
      if (!turn.ok) return turn;
      await this.runHooks("post");
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

  /** The global hooks and each profile's own hooks, plus the profile names (for the web panel). */
  hooksView(): ReturnType<SessionHooks["view"]> {
    return this.hooks.view();
  }

  /** The current hook command lines (live: edits show up at once). */
  hookCommands(): { pre: string[]; post: string[] } {
    return {
      pre: this.hooks.pre.map((h) => h.command),
      post: this.hooks.post.map((h) => h.command),
    };
  }

  /**
   * Run all hooks in the given list in parallel and push each non-blank
   * output as a user message, in config order. Shared by the pre-turn and
   * post-turn paths so the parallel execution, non-blank filter, and
   * injection logic live in one place.
   */
  private async runHooks(phase: "pre" | "post"): Promise<void> {
    for (const output of await this.hooks.run(phase)) {
      this.messages.push({ role: "user", content: output });
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

  /**
   * Start a fresh conversation: the system message and project map only, a new
   * auto-save name (the old conversation is already auto-saved), and the
   * active profile re-applied to the new conversation. Burst mode, the model
   * and tool enablement are left as they are.
   */
  private async newConversation(): Promise<Result<string>> {
    this.pendingProfile = [];
    this.messages.length = 0;
    this.messages.push(this.systemMessage);
    if (this.initialMessage) {
      this.messages.push({ role: "user", content: this.initialMessage });
    }
    this.sessionName = undefined;
    this.sessionId = undefined;
    const profile = this.activeProfile;
    if (profile !== undefined) {
      const applied = await handleProfileCommand(
        this.profileCommands,
        `/profile ${profile}`,
      );
      if (!applied.ok) return applied;
    }
    return { ok: true, value: "started a new conversation" };
  }

  /** Move the last profile switch's messages into the conversation. */
  private flushPendingProfile(): void {
    this.messages.push(...this.pendingProfile);
    this.pendingProfile = [];
  }

  private async saveSession(): Promise<void> {
    if (!this.sessionSource) return;
    if (this.sessionName === undefined) return;
    try {
      const saved = await this.sessionSource.save(
        this.sessionId,
        this.sessionName,
        [...this.messages],
        this.activeProfile,
      );
      if (saved.ok) this.sessionId = saved.value;
    } catch {
      // Persistence is best-effort; a rejected edge promise must not fail a turn.
    }
  }
}
