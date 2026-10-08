import { config } from "./config.ts";
import { noAudit, type AuditReader, type AuditSink } from "./core/audit.ts";
import { pruneAuditLog } from "./db/audit/audit-prune.ts";
import { SqliteAuditReader } from "./db/audit/audit-query.ts";
import { SqliteAuditSink } from "./db/audit/audit-store.ts";
import { mkdirSync } from "node:fs";
import { ChromiumBackend } from "./browser/chromium/chromium.ts";
import type { BrowserBackend } from "./browser/types.ts";
import { BACKEND, LlmClient } from "./client/llm.ts";
import { dataDirFor, globalDataDir, noFolderRoot } from "./data-dir.ts";
import { GLOBAL_PROMPT } from "./global-prompt.ts";
import { imageStore } from "./stores/image-store.ts";
import type {
  Client,
  Tool,
  ToolCallListener,
  ToolResultListener,
  ToolRunner,
  ToolController,
  TurnCallbacks,
} from "./core/engine.ts";
import type {
  GenerationProgress,
  Picture,
  PromptProgress,
} from "./core/errors.ts";
import {
  buildInitialMessage,
  HookStore,
  FileNoteSource,
  FileProfileSource,
  FileSessionSource,
  FileWorkflowSource,
} from "./edge-sources.ts";
import type { ModelController, ProfileSource } from "./repl/ports.ts";
import { compactInPlace } from "./repl/turn/compaction.ts";
import { Session } from "./repl/session.ts";
import { TempStore, tempHandlers } from "./tools/temp-store.ts";
import type { GoalEvent } from "./repl/turn/goal-loop.ts";
import { makeBrowserHandlers } from "./tools/browser/browser.ts";
import {
  FileImageSource,
  ImageOutbox,
  makeImageHandlers,
} from "./tools/images.ts";
import { makeAskUserHandler, type UserPrompter } from "./tools/agent/ask-user.ts";
import { makeSearchToolsHandler } from "./tools/search-tools.ts";
import { makeSelfHandler } from "./tools/agent/self.ts";
import { currentSubagentDepth, makeSubagentHandler } from "./tools/agent/subagent.ts";
import { createToolRunner, isFileSystemTool, ToolSet, tools } from "./tools.ts";

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
 *
 * The edge source adapter classes (`FileProfileSource`, `ShellHook`,
 * `FileNoteSource`, `FileSessionSource`, `FileWorkflowSource`) and the
 * `buildInitialMessage` / `loadAgentsMd` / `loadHookCommands` helpers live in
 * `src/edge-sources.ts` — this file only wires them together.
 */

/** Tools that run unsandboxed code and so start disabled; the user opts in with `/tool <name> enable`. */
const RISKY_TOOLS = ["browser_run_code"];

/** The session's picture plumbing: where tools queue the pictures they produce, and the loader for `/image`. */
function imagePlumbing(
  client: LlmClient,
  cwd: string | undefined,
): { images: ImageOutbox; imageSource: FileImageSource } {
  client.imageResolver = (picture) => imageStore.dataUri(picture);
  return {
    images: new ImageOutbox(imageStore),
    imageSource: new FileImageSource(
      cwd,
      () => client.supportsVision(),
      imageStore,
    ),
  };
}

/** A `ToolRunner` that defers to one built later (see the cycle between the runner and `run_subagent`). */
function lazily(get: () => ToolRunner): ToolRunner {
  return {
    run: (name, args, signal) => get().run(name, args, signal),
    takeImages: () => get().takeImages?.() ?? [],
  };
}

/**
 * The session's tool switches and model controller. Tool enablement is per
 * session (each connection gets its own `ToolSet`). Tools that need a model
 * with vision start off; the model's capability turns them on, and on again or
 * off again whenever the model is switched.
 */
function controls(
  client: LlmClient,
  sessionTools: Tool[],
): { toolController: ToolSet; modelController: ModelController } {
  const visionTools = sessionTools
    .filter((t) => t.requiresVision)
    .map((t) => t.function.name);
  const toolController = new ToolSet(sessionTools, [
    ...RISKY_TOOLS,
    ...visionTools,
  ]);
  const syncVision = async (): Promise<void> => {
    const sees = await client.supportsVision();
    for (const name of visionTools) toolController.set(name, sees);
  };
  void syncVision();
  const modelController: ModelController = {
    getModel: () => client.getModel(),
    setModel: (name) => {
      client.setModel(name);
      void syncVision();
    },
    listModels: () => client.listModels(),
  };
  return { toolController, modelController };
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
  /** How much each model call has generated so far (and a final `done`), for a "still writing" display. */
  onGenerating?: (progress: GenerationProgress) => void;
  /** Notified of each tool invocation before execution. */
  onToolCall?: ToolCallListener;
  onToolResult?: ToolResultListener;
  /** A tool produced a picture (a screenshot, a viewed file) for the user to see. */
  onImage?: (image: Picture) => void;
  /** Notified when burst mode enters or leaves an act round. */
  onBurst?: (active: boolean) => void;
  /** Told the goal, each verdict on it, and when goal checking is switched. */
  onGoal?: (event: GoalEvent) => void;
  /** Whether each turn is checked against a goal (default on). */
  goalChecking?: boolean;
  /** Plain-text subagent output, for frontends that style it themselves. */
  onSubagentToken?: (token: string, depth?: number) => void;
  /** Collects the user's answer to an `ask_user` tool call. */
  askUser: UserPrompter;
  /** Prompts the user to continue past the maximum tool rounds. */
  onMaxRounds: (question: string) => Promise<boolean>;
  /**
   * The integrated browser the browser tools drive. Shared across sessions
   * when given (the web server passes one); otherwise a private Chromium is
   * created, and it only launches when a browser tool is first used.
   */
  browser?: BrowserBackend;
  /**
   * The hook lists and their store. The web server passes one shared by every
   * connection (edits are then seen by all); otherwise a private one is made.
   */
  hookStore?: HookStore;
  /** The directory the session is rooted at; defaults to the process working directory. */
  root?: string;
  /**
   * A session with no working directory: the file and shell tools do not exist
   * for it. Its stores and hooks live in a generated directory (`noFolderRoot`).
   */
  noFolder?: boolean;
}

/** The edge services a frontend needs after construction. */
export interface EdgeSession {
  /** The conversation orchestrator both frontends drive. */
  session: Session;
  /** The LLM transport (the sole network-I/O module). */
  client: Client;
  /** Whether the active model can see images (asked live; the model can change). */
  canSeeImages: () => Promise<boolean>;
  /** The integrated browser; the frontend closes it on shutdown. */
  browser: BrowserBackend;
  /** The model-facing tool enable/disable controller. */
  toolController: ToolController;
  /** The profile store (also used for unqueued whitelist edits). */
  profileSource: ProfileSource;
  /** Delete the session's temp directory (big tool results saved for the model). */
  cleanup: () => void;
  /** The pre-turn hook commands from `.viserc.json`. */
  preTurnHooks: string[];
  /** The post-turn hook commands from `.viserc.json`. */
  postTurnHooks: string[];
}

/** What a subagent's turns report and use: the frontend's display callbacks, the tool state, and upkeep for its own conversation (it can outgrow the window too). */
function subagentCallbacks(
  options: EdgeSessionOptions,
  toolController: ToolController,
  client: LlmClient,
  audit: AuditSink,
): TurnCallbacks {
  return {
    // The subagent's own conversation is kept in the audit log (without its system message).
    onSubagentDone: (messages) => {
      const depth = currentSubagentDepth();
      for (const message of messages.slice(1)) {
        audit.record({ kind: "message", message, depth });
      }
    },
    onToken: options.onToken,
    onThinking: options.onThinking,
    onToolCall: options.onToolCall,
    onToolResult: options.onToolResult,
    onImage: options.onImage,
    onSubagentToken: options.onSubagentToken,
    isToolEnabled: (name) => toolController.isEnabled(name),
    onRound: (_round, messages) =>
      compactInPlace(
        client,
        client,
        messages,
        config.inTurnCompactionThreshold,
      ),
  };
}

/** The notifications a frontend wants from a session (streamed tokens, tool calls, burst, goals). */
function displayCallbacks(
  options: EdgeSessionOptions,
): Pick<
  EdgeSessionOptions,
  | "onToken"
  | "onThinking"
  | "onToolCall"
  | "onToolResult"
  | "onImage"
  | "onBurst"
  | "onGoal"
> {
  return {
    onToken: options.onToken,
    onThinking: options.onThinking,
    onToolCall: options.onToolCall,
    onToolResult: options.onToolResult,
    onImage: options.onImage,
    onBurst: options.onBurst,
    onGoal: options.onGoal,
  };
}

/** The audit log of a session rooted at `root`: where events go and how `/audit` reads them (nothing when the log is off). */
function auditFor(root: string): {
  auditSink: AuditSink;
  auditReader?: AuditReader;
} {
  if (!config.auditEnabled) return { auditSink: noAudit };
  pruneAuditLog(); // old conversations go before this one starts recording
  const sink = new SqliteAuditSink(root);
  return {
    auditSink: sink,
    auditReader: new SqliteAuditReader(() => sink.flush()),
  };
}

/** Where the client reports each model call: prompt progress, generation, the audit log. */
function wireClientSinks(
  client: LlmClient,
  options: EdgeSessionOptions,
  audit: AuditSink,
): void {
  client.setProgressSink(options.onPromptProgress);
  client.setGenerationSink(options.onGenerating);
  client.setAuditSink(audit);
}

/**
 * Construct the full edge stack: the `LlmClient`, every edge data source, the
 * composed `ToolRunner`, and the `Session`. Shared by the terminal and web
 * frontends so they drive an identical `Session`. See the module doc for the
 * self-reference and session-reference cycles broken with lazily-resolving
 * closures.
 */
export function createEdgeSession(options: EdgeSessionOptions): EdgeSession {
  // The session root: fixed for the life of the session (the web server hosts
  // sessions with different roots in one process).
  const root = options.noFolder
    ? noFolderRoot
    : (options.root ?? process.cwd());
  if (options.noFolder) mkdirSync(root, { recursive: true });
  // The working directory the model sees; none for a session without one.
  const cwd = options.noFolder ? undefined : root;
  const sessionTools = options.noFolder
    ? tools.filter((t) => !isFileSystemTool(t))
    : tools;
  const dataDir = dataDirFor(root);
  // Sessions that share a store share the same live hook arrays.
  const hookStore = options.hookStore ?? new HookStore(root);

  const client = new LlmClient();
  const audit = auditFor(root);
  // Every model call of this session (reply, goal check, compaction...) reports here.
  wireClientSinks(client, options, audit.auditSink);
  const browser: BrowserBackend = options.browser ?? new ChromiumBackend();

  // Single directory that holds every runtime data store (profiles/, notes/,
  // sessions/) so the working directory is not polluted by them. The edge I/O
  // modules each join this `base` with their own subdirectory, so pointing the
  // data sources at `.vise/` relocates all three stores under it.
  const profileSource = new FileProfileSource(dataDir);
  const sessionSource = new FileSessionSource(dataDir);
  const workflowSource = new FileWorkflowSource(dataDir, globalDataDir);

  // The subagent handler needs the ToolRunner for recursion, and the runner
  // needs the handler. Break the cycle with a lazily-resolving structural
  // runner: its `run` closure reads `toolRunner` at dispatch time (after the
  // const below is initialized), so `run_subagent` dispatches back through the
  // real runner and any subagent tool call routes through the composed handler.
  // The `self` and `run_subagent` handlers also read the `Session` (active
  // profile, in-flight abort signal) that is constructed after the runner; the
  // `sessionRef` holder is filled before any turn runs.
  const sessionRef = { current: null as unknown as Session };
  const { toolController, modelController } = controls(client, sessionTools);
  const { images, imageSource } = imagePlumbing(client, cwd);
  // Tool results too big to show go here instead; the temp tools read them back.
  const temp = new TempStore();
  const toolRunner = createToolRunner(
    {
      run_subagent: makeSubagentHandler(
        client,
        profileSource,
        cwd,
        lazily(() => toolRunner),
        sessionTools,
        subagentCallbacks(options, toolController, client, audit.auditSink),
        (operation) => client.withPreservedSlotCache(operation),
        () => sessionRef.current.currentAbortSignal,
        (name) => toolController.baselineEnabled(name),
      ),
      ask_user: makeAskUserHandler(options.askUser),
      search_tools: makeSearchToolsHandler(sessionTools, (name) =>
        toolController.isEnabled(name),
      ),
      ...makeBrowserHandlers(browser, temp, cwd, images),
      ...makeImageHandlers(images, cwd),
      ...tempHandlers(temp),
      self: makeSelfHandler({
        backend: BACKEND,
        model: () => client.getModel(),
        cwd,
        contextMax: () => client.contextMax(),
        lastPromptTokens: () => client.lastPromptTokensUsed(),
        activeProfile: () => sessionRef.current.getActiveProfile(),
        preTurnHooks: () => hookStore.pre.map((h) => h.command),
        postTurnHooks: () => hookStore.post.map((h) => h.command),
      }),
    },
    toolController,
    root,
    sessionTools,
    temp,
    images,
    audit.auditSink,
  );

  const initialMessage = buildInitialMessage(cwd, dataDir);
  const session = new Session(client, toolRunner, sessionTools, {
    cwd,
    context: client,
    modelController,
    reasoningController: client,
    toolController,
    profileSource,
    noteSource: new FileNoteSource({ project: dataDir, global: globalDataDir }),
    imageSource,
    workflowSource,
    sessionSource,
    ...audit,
    preTurnHooks: hookStore.pre,
    postTurnHooks: hookStore.post,
    hookSource: hookStore,
    ...displayCallbacks(options),
    // Every turn is checked against a goal unless the frontend opts out.
    goalChecking: options.goalChecking ?? true,
    initialMessage,
    systemPrompt: GLOBAL_PROMPT,
    onMaxRounds: options.onMaxRounds,
  });
  sessionRef.current = session;
  // A browser the user shares with the agent tells it when a tab is given or taken back.
  const offShare = browser.onUserShare?.((text) => session.notify(text));

  return {
    session,
    client,
    canSeeImages: () => client.supportsVision(),
    browser,
    toolController,
    profileSource,
    cleanup: () => {
      offShare?.();
      session.endAudit();
      temp.dispose();
    },
    preTurnHooks: hookStore.pre.map((h) => h.command),
    postTurnHooks: hookStore.post.map((h) => h.command),
  };
}
