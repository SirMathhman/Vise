import { config } from "../config.ts";
import type { Picture } from "@vise/core";
import type { Client, Tool, ToolController, ToolRunner, TurnCallbacks } from "@vise/core";
import { runTurn } from "@vise/core";
import { SessionAudit } from "./turn/session-audit.ts";
import { deriveSessionName } from "./session-name.ts";
import { GoalLog } from "@vise/core";
import { GoalTracker, handleGoalCommand, type GoalHooks } from "./turn/goal-loop.ts";
import type { Message, Result } from "@vise/core";
import type { CommandNeed } from "./command-catalog.ts";
import { firstThen, freshConversation, helpResult } from "./session-parts.ts";
import { saveConversation, turnLineResult } from "./session-parts.ts";
import { SessionHooks } from "./turn/session-hooks.ts";
import {
  handleModelCommand,
  handleNotesCommand,
  burstNotice,
  handleBurstCommand,
  handleReasoningCommand,
  handleToolCommand,
  reportContext,
  toggleNotice,
} from "./commands/commands.ts";
import { addedSinceLastCall, autoCompact, runCompaction } from "./turn/compaction.ts";
import { makeRoundHook, NoticeQueue } from "./turn/round-hooks.ts";
import { RunScope, RunScopes } from "./turn/run-scope.ts";
import { ProfileToolGate } from "./profile-tools.ts";
import {
  applyWhitelist,
  handleDeleteCommand,
  handleProfileCommand,
  handleResumeCommand,
  handleSaveCommand,
} from "./commands/session-commands.ts";
import { handleMcpCommand } from "../mcp/mcp-command.ts";
import { handleEmbed, handleSearch } from "./commands/search-command.ts";
import { workflowProfileScope } from "./commands/workflow-profiles.ts";
import { findBuiltin, unsupported, type BuiltinCommand } from "./commands/registry.ts";
import { resolveShortcut } from "./commands/shortcut-command.ts";
import { handleWorkflowCommand } from "./commands/workflow-commands.ts";
import type { WorkflowCommands } from "./commands/workflow-commands.ts";

// The ports are re-exported here, where most of their users already import `Session` from.
export type * from "./ports.ts";
import type {
  LineResult,
  ContextSource,
  ProfileSource,
  ModelController,
  ReasoningController,
  NoteSource,
  WorkflowSource,
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

type OnRound = TurnCallbacks["onRound"];

export type { SessionOptions } from "./session-options.ts";
import { PendingImages } from "./commands/image-command.ts";
import { systemMessageFor, type SessionOptions } from "./session-options.ts";

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
  private readonly goals: GoalTracker;
  /** Every goal decision of this conversation; saved with it (never part of the conversation). */
  private readonly goalLog = new GoalLog(() => this.messages.length);
  private pendingProfile: Message[] = [];
  /** What reaches the model between rounds: notices and the user's steering words. */
  readonly notices = new NoticeQueue();
  private readonly isToolEnabled = (name: string): boolean =>
    this.toolController?.isEnabled(name) ?? true;
  private readonly profileSource?: ProfileSource;
  private readonly noteSource?: NoteSource;
  private readonly workflowSource?: WorkflowSource;
  private readonly hooks: SessionHooks;
  private readonly opts: SessionOptions;
  private readonly audit: SessionAudit;
  /** Images attached with `/image`, for the next message. */
  private readonly attachments: PendingImages;
  private readonly initialMessage?: string;
  private readonly sessionSource?: SessionSource;
  private activeProfile: string | undefined;
  /** The session's display name: derived from the first input, or renamed. */
  private sessionName: string | undefined;
  /** The generated id of the session file; undefined until the first save. */
  private sessionId: string | undefined;
  /**
   * The line in flight. Every line (turn, workflow or command) gets its scope
   * synchronously as `handleLine` starts; `interrupt()` stops it, and every
   * wait of the line is raced against it, so Stop never depends on the work
   * underneath cooperating.
   */
  private readonly runs = new RunScopes();
  private readonly profileCommands: ProfileCommands;
  private readonly sessionCommands: SessionCommands;
  private readonly workflowCommands: WorkflowCommands;

  constructor(client: Client, tools: ToolRunner, toolDefs: Tool[], options: SessionOptions) {
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
    this.opts = options;
    this.hooks = new SessionHooks(options, () => this.activeProfile);
    this.audit = new SessionAudit(options.auditSink, options.auditReader);
    this.attachments = new PendingImages(options.imageSource);
    this.goals = new GoalTracker(
      options.goalChecking ?? false,
      (event) => {
        this.audit.goal(event);
        options.onGoal?.(event);
      },
      this.goalLog.add,
    );
    this.initialMessage = options.initialMessage;
    this.sessionSource = options.sessionSource;
    this.systemMessage = systemMessageFor(options);
    this.messages = freshConversation(this.systemMessage, this.initialMessage);
    // The command handlers are plain functions in `session-commands.ts`;
    // the Session wires them to its own state with closures, so the
    // handlers stay free of class-internal references (the `commands.ts`
    // pattern). They are wired after `this.messages` exists so the
    // closures can push/replace the conversation safely.
    this.profileCommands = this.buildProfileCommands(options.toolController);
    this.sessionCommands = {
      sessionSource: () => this.sessionSource,
      activeProfile: () => this.activeProfile,
      setActiveProfile: (name) => void (this.activeProfile = name),
      pushMessage: (message) => void this.messages.push(message),
      messages: () => {
        this.flushPendingProfile();
        return this.persistableMessages();
      },
      applyProfileTools: (name) => applyWhitelist(this.profileCommands, this.profileSource, name),
      resetMessages: (body) => {
        this.pendingProfile = [];
        this.goals.goal = undefined;
        this.audit.restart(this.messages);
        this.replaceConversation(body);
      },
      currentSession: () => ({ id: this.sessionId, name: this.sessionName }),
      todos: this.opts.todos,
      goalLog: this.goalLog,
      setSession: (id, name) => {
        this.sessionId = id;
        this.sessionName = name;
        if (id !== undefined) this.audit.link(id);
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
      onToken: () => this.opts.onToken,
      onThinking: () => this.opts.onThinking,
      onToolCall: () => this.opts.onToolCall,
      onToolResult: () => this.opts.onToolResult,
      onImage: () => this.opts.onImage,
      onMaxRounds: () => this.opts.onMaxRounds,
      onWorkflow: () => this.opts.onWorkflow,
      roundHook: (signal) => this.roundHook(signal),
      isToolEnabled: () => this.isToolEnabled,
      maybeAutoCompact: () => this.maybeAutoCompact(),
      save: () => this.saveSession(),
      setSessionName: (name) => (this.sessionName ??= deriveSessionName(name)),
      profileScope: () =>
        workflowProfileScope(this.profileCommands, this.opts.toolController, () =>
          this.flushPendingProfile(),
        ),
      scope: () => this.scope(),
      underGoal: (said, signal, first) => this.runUnderGoal(said, signal, first),
    };
  }

  /** The line in flight's scope; a detached one when called outside a line (tests calling a handler directly). */
  private scope(): RunScope {
    return this.runs.current ?? new RunScope();
  }

  /**
   * What compaction works on, bound to the line that starts it: a compaction
   * the line stopped waiting for (the user pressed Stop) never replaces the
   * conversation when it finishes later.
   */
  private compaction(): CompactionSource {
    const scope = this.runs.current;
    return {
      client: this.client,
      audit: this.audit.sink,
      messages: () => this.persistableMessages(),
      resetMessages: (body) => {
        if (scope === null || scope.live()) this.replaceConversation(body);
      },
      prefix: () => ({ system: this.systemMessage, tools: this.toolDefs }),
    };
  }

  /** Replace the conversation with the system message and `body`. */
  private replaceConversation(body: Message[]): void {
    this.audit.messages(this.messages); // what is about to go (compaction) is on record first
    this.messages.length = 0;
    this.messages.push(this.systemMessage, ...body);
    this.audit.skip(this.messages.length);
  }

  private buildProfileCommands(toolController: ToolController | undefined): ProfileCommands {
    // Switching profile is lazy: its messages wait in `pendingProfile` until
    // the next turn, and each switch discards the previous switch's messages,
    // so only the last `/profile` before a turn reaches the conversation.
    const profileTools = new ProfileToolGate(toolController, (m) => this.pendingProfile.push(m));
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

  private turnCallbacks(abort: AbortSignal, onRound?: OnRound): TurnCallbacks {
    return {
      onRound,
      onToken: this.opts.onToken,
      onThinking: this.opts.onThinking,
      onToolCall: this.opts.onToolCall,
      onToolResult: this.opts.onToolResult,
      onImage: this.opts.onImage,
      onBurst: this.opts.onBurst,
      onMaxRounds: this.opts.onMaxRounds,
      isToolEnabled: this.isToolEnabled,
      // A model switched to one without grammar support cannot run burst.
      burst: this.burst && this.modelController?.supportsBurst?.() !== false,
      abort,
    };
  }

  /** Between rounds of a long turn: keep the context from overflowing, save, check progress (one per user message). */
  private roundHook(signal: AbortSignal): OnRound {
    const deps = {
      compact: (messages: Message[]) => {
        this.audit.messages(this.messages);
        return autoCompact(
          this.compaction(),
          this.context,
          config.inTurnCompactionThreshold,
          true,
          addedSinceLastCall(messages),
        );
      },
      save: () => this.saveSession(),
      progress: (quiet?: number) =>
        this.goals.progress(
          this.client,
          this.messages,
          this.toolDefs,
          signal,
          this.opts.onMaxRounds,
          quiet,
        ),
      writes: (name: string) => this.toolDefs.some((t) => t.function.name === name && t.writes),
    };
    return makeRoundHook(deps, this.opts.onToken, this.notices);
  }

  private burstCommand(line: string): Result<string> {
    return handleBurstCommand(
      () => this.burst,
      (on) => ((this.burst = on), this.notify(burstNotice(on))),
      line,
      this.modelController?.supportsBurst?.() !== false,
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
  async handleLine(line: string, images: Picture[] = []): Promise<LineResult> {
    // The scope exists before anything else happens, so Stop always has a line to
    // stop, and the whole line is raced against it: whatever the line is waiting
    // on (now or in code added later), Stop ends it at once. The waits inside are
    // raced too, so work the line stopped waiting for never lands afterwards.
    const scope = this.runs.begin();
    try {
      return await scope.waitLine(this.runLine(scope, line, images));
    } finally {
      this.runs.end(scope);
    }
  }

  private async runLine(scope: RunScope, line: string, images: Picture[]): Promise<LineResult> {
    const trimmed = line.trim();
    const command = this.slashCommand(trimmed);
    if (command !== undefined) {
      return this.audit.command(trimmed, scope.waitLine(command), () => this.messages);
    }
    const resolved = trimmed.startsWith("/")
      ? await scope.wait(resolveShortcut(this.noteSource, this.workflowSource, trimmed))
      : undefined;
    if (resolved && !resolved.ok) return resolved;
    const shortcut = resolved?.value;
    if (shortcut?.kind === "error") return { ok: false, error: shortcut.error };
    if (shortcut?.kind === "workflow") {
      const run = scope.waitLine(this.workflowLine(shortcut.line));
      return this.audit.command(trimmed, run, () => this.messages);
    }
    // A note's body is the message the agent receives.
    if (shortcut?.kind === "note") line = shortcut.text;
    return this.runTurnLine(scope, line, images);
  }

  /** A line that is a turn for the model: hooks, the turn under the goal, saving. */
  private async runTurnLine(scope: RunScope, line: string, images: Picture[]): Promise<LineResult> {
    this.audit.turnStart(line);
    try {
      this.flushPendingProfile();
      await this.runHooks("pre", scope);
      this.messages.push(this.attachments.message(line, images));
      if (this.sessionName === undefined) {
        this.sessionName = deriveSessionName(line);
      }
      const auto = await this.maybeAutoCompact();
      if (!scope.live()) return await this.stopped();
      const streamed = this.opts.onToken !== undefined;
      const roundHook = this.roundHook(scope.signal);
      const turn = await this.goals.run(
        this.client,
        this.messages,
        this.toolDefs,
        () =>
          runTurn(
            this.client,
            this.tools,
            this.messages,
            this.toolDefs,
            this.turnCallbacks(scope.signal, roundHook),
          ),
        scope.signal,
        this.goalHooks(),
      );
      this.audit.turnResult(turn);
      if (!turn.ok) {
        await this.saveSession(); // what the turn did before it failed is kept too
        return turn;
      }
      await this.runHooks("post", scope);
      await this.saveSession();
      return turnLineResult(turn.value, streamed, auto);
    } catch (e) {
      this.audit.turnThrew(e);
      await this.saveSession(); // the goal trace of the turn that threw is kept
      throw e;
    } finally {
      this.audit.messages(this.messages);
      this.audit.turnEnd(this.sessionId);
    }
  }

  /** What the goal loop needs from the session: asking to go on, upkeep between continues, the todo list. */
  private goalHooks(said?: string): GoalHooks {
    return {
      confirmMore: this.opts.onMaxRounds,
      // Save first: a session that dies between continues keeps its goal trace.
      beforeContinue: () => this.saveSession().then(() => this.maybeAutoCompact()),
      openTodos: () =>
        (this.opts.todos?.get() ?? [])
          .filter((t) => t.status !== "completed")
          .map((t) => t.content),
      ...(said === undefined ? {} : { said }),
    };
  }

  /**
   * Run `first` (a workflow) as a turn under the goal, so it ends only when the
   * goal is met and the todo list is finished; when it is not, the model is
   * sent back with ordinary turns, never the workflow again.
   */
  private runUnderGoal(
    said: string,
    signal: AbortSignal,
    first: () => Promise<Result<string>>,
  ): Promise<Result<string>> {
    const roundHook = this.roundHook(signal);
    const turn = () =>
      runTurn(
        this.client,
        this.tools,
        this.messages,
        this.toolDefs,
        this.turnCallbacks(signal, roundHook),
      );
    return this.goals.run(
      this.client,
      this.messages,
      this.toolDefs,
      firstThen(first, turn),
      signal,
      this.goalHooks(said),
    );
  }

  private async workflowLine(trimmed: string): Promise<LineResult> {
    this.flushPendingProfile();
    await this.hooks.refresh();
    return handleWorkflowCommand(this.workflowCommands, trimmed);
  }

  /** Every built-in slash command (the names a note or workflow cannot be reached by). */
  private readonly commands: BuiltinCommand[] = [
    { name: "/exit", exact: true, run: () => "exit" },
    { name: "/help", exact: true, run: () => this.help() },
    { name: "/context", exact: true, run: () => this.contextReport() },
    { name: "/hooks", run: (line) => this.hooks.command(line) },
    { name: "/compact", exact: true, run: () => this.doCompact() },
    { name: "/image", run: (line) => this.attachments.command(line) },
    { name: "/new", exact: true, run: () => this.newConversation() },
    { name: "/model", run: (line) => handleModelCommand(this.modelController, line) },
    { name: "/reasoning", run: (line) => handleReasoningCommand(this.reasoningController, line) },
    { name: "/goal", run: (line) => handleGoalCommand(this.goals, line, this.goalLog) },
    { name: "/burst", run: (line) => this.burstCommand(line) },
    { name: "/mcp", run: (line) => handleMcpCommand(this.opts.mcp, line) },
    { name: "/tool", run: (line) => this.toolCommand(line) },
    { name: "/profile", run: (line) => handleProfileCommand(this.profileCommands, line) },
    { name: "/note", run: (line) => handleNotesCommand(this.noteSource, line) },
    { name: "/workflow", run: (line) => this.workflowLine(line) },
    { name: "/resume", run: (line) => handleResumeCommand(this.sessionCommands, line) },
    { name: "/save", run: (line) => handleSaveCommand(this.sessionCommands, line) },
    { name: "/delete", run: (line) => handleDeleteCommand(this.sessionCommands, line) },
    {
      name: "/search",
      run: (line) => handleSearch(this.sessionCommands, this.opts.semantic, line),
    },
    { name: "/embed", run: (line) => handleEmbed(this.opts.semantic, line) },
    { name: "/audit", run: (line) => this.audit.slash(line) ?? unsupported("audit log") },
  ];

  private help(): LineResult {
    const has: [CommandNeed, boolean][] = [
      ["model", !!this.modelController],
      ["reasoning", !!this.reasoningController],
      ["tools", !!this.toolController],
      ["profile", !!this.profileSource],
      ["notes", !!this.noteSource],
      ["workflows", !!this.workflowSource],
      ["sessions", !!this.sessionSource],
      ["audit", this.audit.enabled],
      ["mcp", !!this.opts.mcp],
      ["semantic", !!this.opts.semantic],
    ];
    const hooks = { pre: this.hooks.pre.length, post: this.hooks.post.length };
    return helpResult(has, this.opts.surface === "web", hooks);
  }

  private toolCommand(line: string): Result<string> {
    // When tools' enabled state changes the model is told, so it stops calling disabled tools and knows about newly enabled ones. The full definition list is always sent, so this is a state note, not a change to the tools offered.
    return handleToolCommand(this.toolController, line, (names, enabled) => {
      this.notify(toggleNotice(names, enabled));
    });
  }

  /** Run a slash command; undefined when `trimmed` is not one (it is then a normal turn). */
  private slashCommand(trimmed: string): LineResult | Promise<LineResult> | undefined {
    return findBuiltin(this.commands, trimmed)?.run(trimmed);
  }

  /**
   * Interrupt the line in flight (a turn, workflow or command), if any. Its
   * promise resolves with an `interrupted` error at once, whatever it was
   * waiting on, and the in-flight model call and tools are told to stop through
   * the signal. Returns `true` if a line was running and was interrupted,
   * `false` if none was running (no-op). Called by the
   * edge's SIGINT handler, which uses the return value to decide whether to
   * interrupt (turn in flight) or exit (idle prompt).
   */
  interrupt(): boolean {
    return this.runs.interrupt();
  }

  /**
   * The AbortSignal for the turn in flight, or `undefined` when no turn is
   * running. The subagent handler forwards this into its `runSubagent`
   * callbacks so a subagent's in-flight model call is interrupted together
   * with the parent's turn (the same Ctrl+C that aborts the parent aborts the
   * subagent).
   */
  get currentAbortSignal(): AbortSignal | undefined {
    return this.runs.current?.signal;
  }

  /** Whether turns are checked against a goal (for the edge to show the setting). */
  goalChecking = (): boolean => this.goals.enabled;

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
  private async runHooks(phase: "pre" | "post", scope: RunScope): Promise<void> {
    const outputs = await scope.wait(this.hooks.run(phase));
    // A stopped line adds nothing from hooks that finish after it.
    if (!outputs.ok || !scope.live()) return;
    for (const output of outputs.value) {
      this.messages.push({ role: "user", content: output });
    }
  }

  /** The outcome of a line the user stopped; what it did so far is saved. */
  private async stopped(): Promise<LineResult> {
    const turn: LineResult = { ok: false, error: { kind: "interrupted" } };
    this.audit.turnResult(turn);
    await this.saveSession();
    return turn;
  }

  /**
   * Auto-compaction guard, run before every normal turn. Returns a successful
   * no-op when nothing needed compacting (cold start, below threshold, or
   * nothing to summarize). When the last turn's server-reported usage is at or
   * above `COMPACTION_THRESHOLD` of the live window, performs the same
   * compaction as `/compact`. Best-effort: any failure is returned so the
   * caller can log it, but never blocks the turn.
   */
  private maybeAutoCompact(): Promise<Result<string>> {
    return this.scope().waitResult(
      autoCompact(this.compaction(), this.context, config.compactionThreshold),
    );
  }

  /** `/compact`: summarize the older conversation (`compaction.ts`); on any error it is left untouched. */
  private doCompact = (): Promise<Result<string>> => runCompaction(this.compaction());

  /** The id of the saved session this conversation writes to, once it has one. */
  getSessionId = (): string | undefined => this.sessionId;

  /** The active profile name, or undefined when none is set (for the `self` tool). */
  getActiveProfile = (): string | undefined => this.activeProfile;

  /**
   * Start a fresh conversation: the system message and project map only, a new
   * auto-save name (the old conversation is already auto-saved), and the
   * active profile re-applied to the new conversation. Burst mode, the model
   * and tool enablement are left as they are.
   */
  private async newConversation(): Promise<Result<string>> {
    this.pendingProfile = [];
    this.goals.goal = undefined;
    this.goalLog.clear();
    this.opts.todos?.set([]);
    const fresh = freshConversation(this.systemMessage, this.initialMessage);
    const oldMessages = this.messages.splice(0, this.messages.length, ...fresh);
    this.sessionName = undefined;
    this.sessionId = undefined;
    this.audit.restart(oldMessages);
    const profile = this.activeProfile;
    if (profile !== undefined) {
      const applied = await handleProfileCommand(this.profileCommands, `/profile ${profile}`);
      if (!applied.ok) return applied;
    }
    return { ok: true, value: "started a new conversation" };
  }

  /** Whether burst mode is on (the page's header shows it). */
  isBurst = (): boolean => this.burst;

  /** The context-fill line `/context` prints. A pure read, so a frontend can ask for it without it being a command (and an audit event). */
  contextReport = (): Promise<Result<string>> => reportContext(this.context);

  /** Tell the model something the user did (a shared tab); it is added before the next model call, never between a tool call and its result. */
  notify = (text: string): void => this.notices.add(text);

  /** The audit record of this conversation ends (the session is closing). */
  endAudit(): void {
    this.audit.end();
  }

  /** Move the last profile switch's messages (and any waiting notices) into the conversation. */
  private flushPendingProfile(): void {
    this.notices.drainInto(this.messages);
    this.messages.push(...this.pendingProfile);
    this.pendingProfile = [];
  }

  /** The conversation as it is saved and summarised: the goal loop's continue notes are not the user's words, so they are left out. */
  private persistableMessages = (): Message[] => this.messages.filter((m) => !this.goals.isNote(m));

  private async saveSession(): Promise<void> {
    if (!this.sessionSource || this.sessionName === undefined) return;
    const id = await saveConversation(this.sessionSource, {
      id: this.sessionId,
      name: this.sessionName,
      messages: this.persistableMessages(),
      profile: this.activeProfile,
      todos: this.opts.todos,
      goalLog: this.goalLog,
    });
    if (id !== undefined) this.sessionId = id;
  }
}
