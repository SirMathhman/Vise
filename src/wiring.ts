import { join } from "node:path";
import { homedir } from "node:os";
import { ChromiumBackend } from "./browser/chromium.ts";
import type { BrowserBackend } from "./browser/types.ts";
import { BACKEND, LlmClient } from "./client/llm.ts";
import { dataDir } from "./data-dir.ts";
import type { Client, ToolController } from "./core/engine.ts";
import type { PromptProgress } from "./core/errors.ts";
import {
  buildInitialMessage,
  FileNoteSource,
  FileProfileSource,
  FileSessionSource,
  FileWorkflowSource,
  loadHookCommands,
  ShellHook,
} from "./edge-sources.ts";
import type { ProfileSource } from "./repl/ports.ts";
import { Session } from "./repl/session.ts";
import { makeBrowserHandlers } from "./tools/browser.ts";
import { makeAskUserHandler, type UserPrompter } from "./tools/ask-user.ts";
import { makeSearchToolsHandler } from "./tools/search-tools.ts";
import { makeSelfHandler } from "./tools/self.ts";
import { makeSubagentHandler } from "./tools/subagent.ts";
import { createToolRunner, ToolSet, tools } from "./tools.ts";

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
  /** Notified when burst mode enters or leaves an act round. */
  onBurst?: (active: boolean) => void;
  /** Plain-text subagent output, for frontends that style it themselves. */
  onSubagentToken?: (token: string) => void;
  /** Collects the user's answer to an `ask_user` tool call. */
  askUser: UserPrompter;
  /** Prompts the user to continue past the maximum tool rounds. */
  onMaxRounds: () => Promise<boolean>;
  /**
   * The integrated browser the browser tools drive. Shared across sessions
   * when given (the web server passes one); otherwise a private Chromium is
   * created, and it only launches when a browser tool is first used.
   */
  browser?: BrowserBackend;
}

/** The edge services a frontend needs after construction. */
export interface EdgeSession {
  /** The conversation orchestrator both frontends drive. */
  session: Session;
  /** The LLM transport (the sole network-I/O module). */
  client: Client;
  /** The integrated browser; the frontend closes it on shutdown. */
  browser: BrowserBackend;
  /** The model-facing tool enable/disable controller. */
  toolController: ToolController;
  /** The profile store (also used for unqueued whitelist edits). */
  profileSource: ProfileSource;
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
  const browser = options.browser ?? new ChromiumBackend();

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
  // Tool enablement is per session: each connection gets its own ToolSet.
  const toolController = new ToolSet(tools, RISKY_TOOLS);
  const toolRunner = createToolRunner(
    {
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
          onSubagentToken: options.onSubagentToken,
          isToolEnabled: (name) => toolController.isEnabled(name),
        },
        (operation) => client.withPreservedSlotCache(operation),
        () => sessionRef.current.currentAbortSignal,
      ),
      ask_user: makeAskUserHandler(options.askUser),
      search_tools: makeSearchToolsHandler(tools, (name) =>
        toolController.isEnabled(name),
      ),
      ...makeBrowserHandlers(browser),
      self: makeSelfHandler({
        backend: BACKEND,
        model: () => client.getModel(),
        cwd,
        contextMax: () => client.contextMax(),
        lastPromptTokens: () => client.lastPromptTokensUsed(),
        activeProfile: () => sessionRef.current.getActiveProfile(),
        preTurnHooks: preTurnHooks.map((h) => h.command),
        postTurnHooks: postTurnHooks.map((h) => h.command),
      }),
    },
    toolController,
  );

  const initialMessage = buildInitialMessage(cwd, dataDir);
  const session = new Session(client, toolRunner, tools, {
    cwd,
    context: client,
    modelController: client,
    reasoningController: client,
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
    onBurst: options.onBurst,
    initialMessage,
    onMaxRounds: options.onMaxRounds,
  });
  sessionRef.current = session;

  return {
    session,
    client,
    browser,
    toolController,
    profileSource,
    preTurnHooks: preTurnHooks.map((h) => h.command),
    postTurnHooks: postTurnHooks.map((h) => h.command),
  };
}
