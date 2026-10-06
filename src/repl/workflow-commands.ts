import type { Client, Tool, ToolRunner } from "../core/engine.ts";
import { runWorkflow } from "../core/workflow.ts";
import type { WorkflowScope } from "../core/workflow.ts";
import type {
  Message,
  PromptProgress,
  Result,
  ViseError,
} from "../core/errors.ts";
import { formatWorkflowList } from "../output/format.ts";
import type { PreTurnHook, PostTurnHook, WorkflowSource } from "./session.ts";

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
 * The subset of Session state the `/workflow` command needs, exposed to this
 * module so the handler can be a plain module-level function (matching the
 * `commands.ts` / `session-commands.ts` pattern) rather than a private method
 * on the class. The Session implements it with closures over its own fields.
 */
export interface WorkflowCommands {
  /** The edge-owned workflow source, or undefined when unsupported. */
  workflowSource(): WorkflowSource | undefined;
  client(): Client;
  tools(): ToolRunner;
  toolDefs(): Tool[];
  /** The live messages array (mutated in place by `runWorkflow`). */
  messages(): Message[];
  preTurnHooks(): PreTurnHook[];
  postTurnHooks(): PostTurnHook[];
  onToken(): ((token: string) => void) | undefined;
  onThinking(): ((token: string) => void) | undefined;
  onPromptProgress(): ((progress: PromptProgress) => void) | undefined;
  onToolCall(): ((name: string, depth?: number) => void) | undefined;
  onMaxRounds(): (() => Promise<boolean>) | undefined;
  /** Run the auto-compaction guard and return its `Result`. */
  maybeAutoCompact(): Promise<Result<string>>;
  /** Persist the conversation after the turn (auto-save). */
  save(): Promise<void>;
  /** Set the autosave name from the workflow's conversational request. */
  setSessionName(name: string): void;
  /** Store the per-turn AbortController (the source of truth for interrupt). */
  setCurrentAbort(controller: AbortController | null): void;
}

/**
 * Run all hooks in the given list in parallel and push each non-blank
 * output as a user message, in config order. Shared by the pre-turn and
 * post-turn paths so the parallel execution, non-blank filter, and
 * injection logic live in one place.
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
 * Handle `/workflow` and `/workflow <name> [input]`.
 * When name is omitted: lists available workflows from both scopes.
 * `/workflow init <name>`: creates a starter workflow definition.
 * Otherwise: runs the workflow, which is a turn in flight — a per-turn
 * `AbortController` is created here and its signal passed into
 * `runWorkflow`, so a Ctrl+C interrupts the run the same way a plain prompt
 * is interrupted.
 */
export async function handleWorkflowCommand(
  session: WorkflowCommands,
  line: string,
): Promise<LineResult> {
  const source = session.workflowSource();
  if (!source) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: "workflows not supported by the current client",
      },
    };
  }
  const arg = line.slice("/workflow".length).trim();
  if (arg === "") {
    const listed = await source.listWorkflows();
    if (!listed.ok) return listed;
    return { ok: true, value: formatWorkflowList(listed.value) };
  }
  if (arg === "init" || arg.startsWith("init ")) {
    const initArgs = arg
      .slice("init".length)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    let scope: WorkflowScope = "project";
    if (initArgs[0] === "--global") {
      scope = "global";
      initArgs.shift();
    }
    if (initArgs.length !== 1 || !initArgs[0]) {
      return {
        ok: false,
        error: {
          kind: "malformed",
          body: "usage: /workflow init [--global] <name>",
        },
      };
    }
    const created = await source.initWorkflow(initArgs[0], scope);
    if (!created.ok) return created;
    return {
      ok: true,
      value: `initialized ${scope} workflow '${created.value}'`,
    };
  }

  const separator = arg.search(/\s/);
  const name = separator < 0 ? arg : arg.slice(0, separator);
  const request = separator < 0 ? "" : arg.slice(separator).trim();
  const loaded = await source.loadWorkflow(name);
  if (!loaded.ok) return loaded;
  // A workflow run is a turn in flight, so a Ctrl+C interrupts it the same
  // way a plain prompt is interrupted. The per-turn controller is created
  // here (not in `handleLine`, which returned control before the command was
  // dispatched) and cleared in a `finally`.
  const abort = new AbortController();
  session.setCurrentAbort(abort);
  try {
    const messages = session.messages();
    await runHooks(session.preTurnHooks(), messages);
    if (request.trim() !== "") session.setSessionName(request);
    const auto = await session.maybeAutoCompact();
    const streamed = session.onToken() !== undefined;
    const result = await runWorkflow({
      client: session.client(),
      tools: session.tools(),
      toolDefs: session.toolDefs(),
      messages,
      name,
      workflow: loaded.value,
      request,
      callbacks: {
        onToken: session.onToken(),
        onThinking: session.onThinking(),
        onPromptProgress: session.onPromptProgress(),
        onToolCall: session.onToolCall(),
        onMaxRounds: session.onMaxRounds(),
        abort: abort.signal,
      },
    });
    if (!result.ok) return result;
    await runHooks(session.postTurnHooks(), messages);
    await session.save();
    if (auto.ok) {
      return { ok: true, value: result.value, streamed };
    }
    return {
      ok: true,
      value: result.value,
      streamed,
      compactionWarning: auto.error,
    };
  } finally {
    session.setCurrentAbort(null);
  }
}
