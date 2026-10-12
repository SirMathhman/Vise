import type {
  ToolCallListener,
  ToolController,
  ToolResultListener,
} from "@vise/core";
import type { AuditReader, AuditSink } from "@vise/core";
import type { Picture } from "@vise/core";
import type { TodoStore } from "@vise/core";
import type { ToolHookEntry } from "@vise/core";
import type { GoalEvent } from "./turn/goal-loop.ts";
import type { WorkflowEvent } from "@vise/core";
import type {
  ContextSource,
  HookSource,
  ModelController,
  ImageSource,
  NoteSource,
  PostTurnHook,
  PreTurnHook,
  ProfileSource,
  ReasoningController,
  SessionSource,
  WorkflowSource,
  McpStatusSource,
  SemanticIndexPort,
} from "./ports.ts";

/**
 * Edge-provided options for constructing a Session. Groups the optional
 * edge services (model controller, profile source, hooks) and the required
 * context source + cwd into a single object, so adding a new service is
 * a new optional field, not a new positional parameter.
 */
export interface SessionOptions {
  /**
   * Instructions that lead the system message whatever the profile (the edge
   * supplies them; absent, the system message is just the working directory line).
   */
  systemPrompt?: string;
  /** The working directory; absent for a session with no file system. */
  cwd?: string;
  context: ContextSource;
  modelController?: ModelController;
  reasoningController?: ReasoningController;
  toolController?: ToolController;
  profileSource?: ProfileSource;
  noteSource?: NoteSource;
  /** The MCP servers `/mcp` reports on and restarts. */
  mcp?: McpStatusSource;
  /** The folder's semantic index (`/search semantic`, `/embed`); without one those commands are unavailable. */
  semantic?: SemanticIndexPort;
  /** Which frontend drives the session: the web page also answers `/steer` and `/queue` (shown in `/help`). Default: terminal. */
  surface?: "terminal" | "web";
  /** Loads the image files `/image <path>` attaches; without it that command is unavailable. */
  imageSource?: ImageSource;
  workflowSource?: WorkflowSource;
  preTurnHooks: PreTurnHook[];
  postTurnHooks: PostTurnHook[];
  /** The live tool hook lists (run by the tool runner, edited by `/hooks add|remove pretool|posttool`). */
  preToolHooks?: ToolHookEntry[];
  postToolHooks?: ToolHookEntry[];
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
  /** Edge-provided notification for each tool invocation before execution. */
  onToolCall?: ToolCallListener;
  onToolResult?: ToolResultListener;
  /** A tool produced a picture for the user to see (the model gets it with the result). */
  onImage?: (image: Picture) => void;
  /** Notified when burst mode enters or leaves an act round. */
  onBurst?: (active: boolean) => void;
  /** Told the goal, each verdict on it, and when goal checking is switched. */
  onGoal?: (event: GoalEvent) => void;
  /** Told a running workflow's progress: each step as it starts and how the run ended. */
  onWorkflow?: (event: WorkflowEvent) => void;
  /** Whether each turn is checked against a goal (default off here; the edge wiring turns it on). */
  goalChecking?: boolean;
  /**
   * Initial context injected as the first user message after the system
   * message. Provided by the edge at construction time; typically contains
   * the working directory's initial file structure so the model has a
   * starting map of the project without calling tools.
   */
  initialMessage?: string;
  sessionSource?: SessionSource;
  /** The agent's todo list: saved with the session, restored on resume, cleared by `/new`. */
  todos?: TodoStore;
  /** Where the audit log of this conversation goes (nothing is recorded when absent). */
  auditSink?: AuditSink;
  /** Answers `/audit` from the audit log (absent when the log is off). */
  auditReader?: AuditReader;
  /**
   * Edge-provided callback invoked when the tool loop reaches its maximum
   * rounds. Prompts the user to continue; returns true to reset the round
   * counter and keep going, false to end the turn with an error. When absent
   * (subagents), the turn ends without prompting.
   */
  onMaxRounds?: (question: string) => Promise<boolean>;
}

/** The system message: the edge's instructions (if any), then where the session works. */
export function systemMessageFor(
  options: Pick<SessionOptions, "cwd" | "systemPrompt">,
): { role: "system"; content: string } {
  const where =
    options.cwd === undefined
      ? "This session has no working directory and no file system access."
      : `Working directory: ${options.cwd}`;
  const lead = options.systemPrompt ? `${options.systemPrompt}\n\n` : "";
  return { role: "system", content: lead + where };
}
