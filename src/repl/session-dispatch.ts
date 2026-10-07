import type {
  Client,
  Tool,
  ToolController,
  ToolRunner,
} from "../core/engine.ts";
import { runTurn } from "../core/engine.ts";
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
  handleReasoningCommand,
  handleToolCommand,
  toggleNotice,
  reportContext,
} from "./commands.ts";
import {
  handleProfileCommand,
  handleResumeCommand,
  handleSaveCommand,
} from "./session-commands.ts";
import { handleWorkflowCommand } from "./workflow-commands.ts";
import type { WorkflowCommands } from "./workflow-commands.ts";
import type {
  ContextSource,
  ModelController,
  NoteSource,
  ProfileCommands,
  ProfileSource,
  PreTurnHook,
  PostTurnHook,
  ReasoningController,
  SessionCommands,
  SessionSource,
  WorkflowSource,
} from "./session.ts";

/**
 * The outcome of a handled line. A successful turn carries the model's reply
 * and, when auto-compaction failed before the turn, an optional
 * `compactionWarning` the edge surfaces on stderr. This keeps all I/O at the
 * edge (invariant #2): the session never writes to stdout or stderr itself.
 * Structurally identical to the `LineResult` in `session.ts`; the two are
 * mutually assignable (structural typing).
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
 * The subset of Session state the line dispatcher needs, exposed to this
 * module so `handleLine` can be a plain module-level function (matching the
 * `commands.ts` / `session-commands.ts` pattern) rather than a private method
 * on the class. The Session implements it with closures over its own fields.
 */
export interface SessionDispatch {
  modelController(): ModelController | undefined;
  reasoningController(): ReasoningController | undefined;
  toolController(): ToolController | undefined;
  profileSource(): ProfileSource | undefined;
  noteSource(): NoteSource | undefined;
  workflowSource(): WorkflowSource | undefined;
  sessionSource(): SessionSource | undefined;
  context(): ContextSource;
  preTurnHooks(): PreTurnHook[];
  postTurnHooks(): PostTurnHook[];
  /** The live messages array (mutated in place by the turn). */
  messages(): Message[];
  client(): Client;
  tools(): ToolRunner;
  toolDefs(): Tool[];
  onToken(): ((token: string) => void) | undefined;
  onThinking(): ((token: string) => void) | undefined;
  onPromptProgress(): ((progress: PromptProgress) => void) | undefined;
  onToolCall(): ((name: string, depth?: number) => void) | undefined;
  onMaxRounds(): (() => Promise<boolean>) | undefined;
  /** The pre-wired command-handler facades. */
  profileCommands(): ProfileCommands;
  sessionCommands(): SessionCommands;
  workflowCommands(): WorkflowCommands;
  /** Run the shared compaction body (the `/compact` path). */
  doCompact(): Promise<Result<string>>;
  /** Run the auto-compaction guard and return its `Result`. */
  maybeAutoCompact(): Promise<Result<string>>;
  /** Persist the conversation after the turn (auto-save). */
  save(): Promise<void>;
  /** Store the per-turn AbortController (the source of truth for interrupt). */
  setCurrentAbort(controller: AbortController | null): void;
}

/**
 * Run all hooks in the given list in parallel and push each non-blank
 * output as a user message into the given conversation, in config order.
 * Shared by the pre-turn and post-turn paths so the parallel execution,
 * non-blank filter, and injection logic live in one place.
 */
async function runHooks(
  hooks: PreTurnHook[] | PostTurnHook[],
  messages: Message[],
): Promise<void> {
  if (hooks.length === 0) return;
  const outputs = await Promise.all(hooks.map((h) => h.run()));
  for (const output of outputs) {
    if (output.trim() !== "") {
      messages.push({ role: "user", content: output });
    }
  }
}

/**
 * Handle a single non-empty line. Returns "exit" when the line is `/exit`;
 * a formatted context line for `/context`; a compaction note for `/compact`;
 * otherwise the turn outcome. An auto-compact that fails before a turn does
 * not abort the turn — the user's prompt still runs against the uncut
 * conversation — and the failure is carried as `compactionWarning` on the
 * successful result so the edge can surface it (the session performs no I/O).
 */
export async function dispatch(
  session: SessionDispatch,
  line: string,
): Promise<LineResult> {
  const trimmed = line.trim();
  if (trimmed === "/exit") return "exit";
  if (trimmed === "/help")
    return {
      ok: true,
      value: formatHelp({
        hasModel: !!session.modelController(),
        hasReasoning: !!session.reasoningController(),
        hasTools: !!session.toolController(),
        hasProfile: !!session.profileSource(),
        hasNotes: !!session.noteSource(),
        hasWorkflows: !!session.workflowSource(),
        hasSessions: !!session.sessionSource(),
        preTurnHookCount: session.preTurnHooks().length,
        postTurnHookCount: session.postTurnHooks().length,
      }),
    };
  if (trimmed === "/context") return reportContext(session.context());
  if (trimmed === "/compact") return session.doCompact();
  if (trimmed === "/model" || trimmed.startsWith("/model ")) {
    return handleModelCommand(session.modelController(), trimmed);
  }
  if (trimmed === "/reasoning" || trimmed.startsWith("/reasoning ")) {
    return handleReasoningCommand(session.reasoningController(), trimmed);
  }
  if (trimmed === "/tool" || trimmed.startsWith("/tool ")) {
    const messages = session.messages();
    return handleToolCommand(
      session.toolController(),
      trimmed,
      (names, enabled) => {
        // Tools' enabled state changed; tell the model (see `toggleNotice`).
        messages.push({ role: "user", content: toggleNotice(names, enabled) });
      },
    );
  }
  if (trimmed === "/profile" || trimmed.startsWith("/profile ")) {
    return handleProfileCommand(session.profileCommands(), trimmed);
  }
  if (trimmed === "/note" || trimmed.startsWith("/note ")) {
    return handleNotesCommand(session.noteSource(), trimmed);
  }
  if (trimmed === "/workflow" || trimmed.startsWith("/workflow ")) {
    return handleWorkflowCommand(session.workflowCommands(), trimmed);
  }
  if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
    return handleResumeCommand(session.sessionCommands(), trimmed);
  }
  if (trimmed === "/save" || trimmed.startsWith("/save ")) {
    return handleSaveCommand(session.sessionCommands(), trimmed);
  }
  const abort = new AbortController();
  session.setCurrentAbort(abort);
  try {
    const messages = session.messages();
    await runHooks(session.preTurnHooks(), messages);
    messages.push({ role: "user", content: line });
    const auto = await session.maybeAutoCompact();
    const streamed = session.onToken() !== undefined;
    const turn = await runTurn(
      session.client(),
      session.tools(),
      messages,
      session.toolDefs(),
      {
        onToken: session.onToken(),
        onThinking: session.onThinking(),
        onPromptProgress: session.onPromptProgress(),
        onToolCall: session.onToolCall(),
        onMaxRounds: session.onMaxRounds(),
        abort: abort.signal,
      },
    );
    if (!turn.ok) return turn;
    await runHooks(session.postTurnHooks(), messages);
    await session.save();
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
    session.setCurrentAbort(null);
  }
}
