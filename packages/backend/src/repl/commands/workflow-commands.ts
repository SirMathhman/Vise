import type { Picture } from "@vise/core";
import { newNameProblem, unsupported } from "./registry.ts";
import type {
  Client,
  Tool,
  ToolCallListener,
  ToolResultListener,
  ToolRunner,
  TurnCallbacks,
} from "@vise/core";
import { runWorkflow } from "@vise/core";
import type { WorkflowEvent, WorkflowScope } from "@vise/core";
import type { Message, Result } from "@vise/core";
import type { LineResult } from "../ports.ts";
import type { RunScope } from "../turn/run-scope.ts";
import { formatWorkflowList } from "../../output/format.ts";
import type { WorkflowProfileScope } from "./workflow-profiles.ts";
import type { PreTurnHook, PostTurnHook, WorkflowSource } from "../session.ts";

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
  onToolCall(): ToolCallListener | undefined;
  onToolResult(): ToolResultListener | undefined;
  onImage(): ((image: Picture) => void) | undefined;
  onMaxRounds(): ((question: string) => Promise<boolean>) | undefined;
  /** Told the workflow's progress: each step as it starts and how the run ended. */
  onWorkflow(): ((event: WorkflowEvent) => void) | undefined;
  /** The between-rounds upkeep (compaction, saving, progress) for a turn run under `signal`. */
  roundHook(signal: AbortSignal): TurnCallbacks["onRound"];
  isToolEnabled(): (name: string) => boolean;
  /** Run the auto-compaction guard and return its `Result`. */
  maybeAutoCompact(): Promise<Result<string>>;
  /** Persist the conversation after the turn (auto-save). */
  save(): Promise<void>;
  /** Set the autosave name from the workflow's conversational request. */
  setSessionName(name: string): void;
  /** Profile switching for the run, and the way back to the profile active now. */
  profileScope(): WorkflowProfileScope;
  /** The line in flight: its signal stops the run, and every wait of the run is raced against it. */
  scope(): RunScope;
  /**
   * Run `first` as a turn under the goal tracker: the run is over only once the
   * goal is met and the todo list is finished (`said` is what was asked).
   */
  underGoal(
    said: string,
    signal: AbortSignal,
    first: () => Promise<Result<string>>,
  ): Promise<Result<string>>;
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
  scope: RunScope,
): Promise<void> {
  if (hooks.length === 0) return;
  const raced = await scope.wait(Promise.all(hooks.map((h) => h.run())));
  if (!raced.ok || !scope.live()) return;
  for (const output of raced.value) {
    if (output.trim() !== "") {
      messages.push({ role: "user", content: output });
    }
  }
}

/** `/workflow init [--global] <name>`: create a starter workflow definition. */
async function initWorkflow(source: WorkflowSource, rest: string): Promise<LineResult> {
  const initArgs = rest.trim().split(/\s+/).filter(Boolean);
  let scope: WorkflowScope = "project";
  if (initArgs[0] === "--global") {
    scope = "global";
    initArgs.shift();
  }
  if (initArgs.length !== 1 || !initArgs[0]) {
    return {
      ok: false,
      error: { kind: "malformed", body: "usage: /workflow init [--global] <name>" },
    };
  }
  const problem = newNameProblem(initArgs[0]);
  if (problem) return { ok: false, error: { kind: "malformed", body: problem } };
  const created = await source.initWorkflow(initArgs[0], scope);
  if (!created.ok) return created;
  return { ok: true, value: `initialized ${scope} workflow '${created.value}'` };
}

/**
 * Handle `/workflow` and `/workflow <name> [input]`.
 * When name is omitted: lists available workflows from both scopes.
 * `/workflow init <name>`: creates a starter workflow definition.
 * Otherwise: runs the workflow, which is a turn in flight: it runs under the
 * session's scope for the line, so Stop (or Ctrl+C) interrupts the run the
 * same way a plain prompt is interrupted.
 */
export async function handleWorkflowCommand(
  session: WorkflowCommands,
  line: string,
): Promise<LineResult> {
  const source = session.workflowSource();
  if (!source) {
    return unsupported("workflows");
  }
  const arg = line.slice("/workflow".length).trim();
  if (arg === "") {
    const listed = await source.listWorkflows();
    if (!listed.ok) return listed;
    return { ok: true, value: formatWorkflowList(listed.value) };
  }
  if (arg === "init" || arg.startsWith("init ")) {
    return initWorkflow(source, arg.slice("init".length));
  }

  const separator = arg.search(/\s/);
  const name = separator < 0 ? arg : arg.slice(0, separator);
  const request = separator < 0 ? "" : arg.slice(separator).trim();
  const loaded = await source.loadWorkflow(name);
  if (!loaded.ok) return loaded;
  const run = session.scope();
  const abort = { signal: run.signal };
  const scope = session.profileScope();
  // A run that stops early stays in the profile it was working in: putting
  // back the one you had (often a restricted planning profile) would take the
  // tools away from the "continue" you type next.
  let succeeded = false;
  try {
    const messages = session.messages();
    await runHooks(session.preTurnHooks(), messages, run);
    if (request.trim() !== "") session.setSessionName(request);
    const auto = await session.maybeAutoCompact();
    const streamed = session.onToken() !== undefined;
    const said = `Run workflow '${name}'. User request: ${request || "(none)"}`;
    const result = await session.underGoal(said, abort.signal, () =>
      runWorkflow({
        client: session.client(),
        tools: session.tools(),
        toolDefs: session.toolDefs(),
        messages,
        name,
        workflow: loaded.value,
        request,
        profiles: scope.profiles,
        onWorkflow: session.onWorkflow(),
        callbacks: {
          onToken: session.onToken(),
          onThinking: session.onThinking(),
          onToolCall: session.onToolCall(),
          onToolResult: session.onToolResult(),
          onImage: session.onImage(),
          onMaxRounds: session.onMaxRounds(),
          onRound: session.roundHook(abort.signal),
          isToolEnabled: session.isToolEnabled(),
          abort: abort.signal,
        },
      }),
    );
    if (!result.ok) return result;
    succeeded = true;
    await runHooks(session.postTurnHooks(), messages, run);
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
    if (loaded.value.steps.some((s) => s.type === "profile")) {
      // A workflow that ran to the end gives you back the profile you had.
      if (succeeded) await scope.restore(scope.active);
      else if (scope.current() !== scope.active)
        session.onWorkflow()?.({ kind: "profile", name: scope.current(), was: scope.active });
    }
  }
}
