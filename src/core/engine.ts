import type {
  AssistantMessage,
  Message,
  PromptProgress,
  Result,
} from "./errors.ts";

/**
 * Definition of a single tool function, as presented to the model. The core
 * owns this type; the edge provides the `Tool[]` definitions and the
 * `ToolRunner` implementation.
 */
export interface Tool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  /**
   * Deferred tools are listed in the prompt by name and summary only; the
   * model fetches the full signature with `search_tools`. They stay callable.
   */
  deferred?: boolean;
  /** Group the tool belongs to (files, shell, browser, ...); shown in the prompt index and searchable. */
  category?: string;
}

/**
 * The core depends only on this type, not on a concrete transport, so it can
 * be tested with a stub. The edge provides the implementation (currently
 * `LlmClient` in `client/llm.ts`).
 */
export interface Client {
  chat(
    messages: Message[],
    tools?: Tool[],
    onToken?: (token: string) => void,
    onThinking?: (token: string) => void,
    onPromptProgress?: (progress: PromptProgress) => void,
    responseSchema?: Record<string, unknown>,
    signal?: AbortSignal,
    isToolEnabled?: (name: string) => boolean,
    act?: boolean,
  ): Promise<Result<AssistantMessage>>;
}

/**
 * Executes a tool invocation with the given name and arguments, returning a
 * string result (or an error string). The edge provides the implementation;
 * the core depends only on this interface so it can be tested with a stub.
 */
export interface ToolRunner {
  run(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface TurnCallbacks {
  onToken?: (token: string) => void;
  onThinking?: (token: string) => void;
  onPromptProgress?: (progress: PromptProgress) => void;
  onToolCall?: (name: string, depth?: number) => void;
  /**
   * Plain-text stream of a subagent's reply. A frontend that can style it
   * itself (the web UI) supplies this; when absent the subagent handler
   * falls back to a dimmed, indented copy sent through `onToken`.
   */
  onSubagentToken?: (token: string) => void;
  onMaxRounds?: () => Promise<boolean>;
  /**
   * Whether a tool is currently enabled. The client restricts generation so
   * disabled tools cannot be called, without altering the tool definitions
   * (and therefore the prompt). When absent, every tool is allowed.
   */
  isToolEnabled?: (name: string) => boolean;
  /**
   * Burst mode: think once to plan, then run tool calls without thinking in
   * between. The loop returns to thinking when a tool errors, when the model
   * signals the plan is done, or when its tool choice is uncertain.
   */
  burst?: boolean;
  /** Notified when burst mode enters (true) or leaves (false) an act round. */
  onBurst?: (active: boolean) => void;
  /**
   * Aborts the turn when the user interrupts (e.g. Ctrl+C). The edge sets the
   * signal on interrupt; the core threads it to the in-flight model call and
   * stops the tool loop between rounds. When absent, turns run to completion.
   */
  abort?: AbortSignal;
}

/**
 * Controls which tools are enabled. The full set of tool definitions is
 * always sent to the model regardless of enabled state — disabling a tool
 * does not change the definitions offered to the model; it only makes the
 * `ToolRunner` reject invocations of that tool. The edge provides the
 * implementation (currently `ToolSet` in `tools.ts`); the core depends only
 * on this interface so it can be tested with a stub.
 */
export interface ToolController {
  /** All known tools with their enabled state, in definition order. */
  list(): {
    name: string;
    enabled: boolean;
    category?: string;
    /** Starts disabled and is never switched on by a category toggle, only by name. */
    optIn?: boolean;
  }[];
  /** Enable or disable a tool by name. */
  set(name: string, enabled: boolean): void;
  /** Whether a tool is currently enabled. */
  isEnabled(name: string): boolean;
}

const MAX_TOOL_ROUNDS = 100;

/**
 * Burst mode: the plan round's reasoning is kept in history (capped to this
 * many trailing characters) so act rounds, which cannot think, can follow it.
 */
const PLAN_MAX_CHARS = 4000;

/** Burst mode: below this tool-choice probability, think again. */
export const BURST_MIN_CONFIDENCE = 0.5;

/**
 * The text appended to the conversation to request a summary of it. Kept
 * as a constant so the compaction prompt is stable and greppable.
 */
export const SUMMARIZE_PROMPT = "Summarize this conversation";

/**
 * A partition of the conversation for compaction. `toSummarize` is the older
 * portion that will be replaced by a summary; `recent` is the tail of
 * complete turns that is preserved verbatim.
 */
export interface CompactionSplit {
  toSummarize: Message[];
  recent: Message[];
}

/**
 * Split the conversation into the portion to summarize and the most recent
 * `recentTurns` complete turns to keep. A "turn" starts at a user message and
 * runs through the assistant/tool messages that follow it up to the next user
 * message, so the kept tail is always a self-contained, API-valid sequence
 * (no dangling tool_call/tool references). The leading system message is
 * always preserved by the caller and is not part of either half here; pass in
 * the conversation with the system message already removed.
 *
 * Pure: no I/O, depends only on the `Message` type. If there are no user
 * turns at all, everything goes to `toSummarize` and `recent` is empty.
 */
export function splitForCompaction(
  messages: Message[],
  recentTurns: number,
): CompactionSplit {
  // Find the indexes of every user message; these are turn boundaries.
  const boundaries: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.role === "user") boundaries.push(i);
  }
  if (boundaries.length === 0) {
    return { toSummarize: messages.slice(), recent: [] };
  }
  const keepFromIndex =
    boundaries.length <= recentTurns
      ? boundaries[0]
      : boundaries[boundaries.length - recentTurns];
  return {
    toSummarize: messages.slice(0, keepFromIndex),
    recent: messages.slice(keepFromIndex),
  };
}

/**
 * Produce a summary of the conversation's older portion. Sends the older
 * messages plus the `SUMMARIZE_PROMPT` to the model and returns the model's
 * summary text. Pure: no I/O beyond the `Client` and no `node:` imports.
 */
export async function summarize(
  client: Client,
  toSummarize: Message[],
): Promise<Result<string>> {
  const result = await client.chat([
    ...toSummarize,
    { role: "user", content: SUMMARIZE_PROMPT },
  ]);
  if (!result.ok) return result;
  return { ok: true, value: result.value.content };
}

/**
 * Pure core pipeline: takes the accumulated conversation and a user line,
 * runs the model, dispatches any tool calls through `tools`, and returns the
 * assistant's final content. Mutates `messages` (appending assistant and
 * tool messages). No `node:` imports, no I/O — depends only on `Client` and
 * `ToolRunner`, so it is testable with stubs.
 *
 * `onMaxRounds` is called when the loop reaches `MAX_TOOL_ROUNDS` rounds. If
 * it returns `true` the counter resets and the loop continues; if `false` the
 * turn ends with an error. When omitted (subagents), the turn ends silently.
 */
export async function runTurn(
  client: Client,
  tools: ToolRunner,
  messages: Message[],
  toolDefs: Tool[],
  callbacks: TurnCallbacks = {},
): Promise<Result<string>> {
  let rounds = 0;
  // True while a burst-mode plan is being executed without thinking.
  let act = false;
  let announced = false;
  const setBurst = (on: boolean): void => {
    if (on !== announced) callbacks.onBurst?.((announced = on));
  };
  while (true) {
    if (rounds >= MAX_TOOL_ROUNDS) {
      if (callbacks.onMaxRounds) {
        const keepGoing = await callbacks.onMaxRounds();
        if (keepGoing) {
          rounds = 0;
          continue;
        }
      }
      return {
        ok: false,
        error: { kind: "malformed", body: "exceeded maximum tool rounds" },
      };
    }
    if (callbacks.abort?.aborted) {
      return { ok: false, error: { kind: "interrupted" } };
    }
    rounds += 1;
    const result = await client.chat(
      messages,
      toolDefs,
      callbacks.onToken,
      callbacks.onThinking,
      callbacks.onPromptProgress,
      undefined,
      callbacks.abort,
      callbacks.isToolEnabled,
      act,
    );
    if (callbacks.abort?.aborted) {
      return { ok: false, error: { kind: "interrupted" } };
    }
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const reply = result.value;
    if (
      act &&
      (reply.done ||
        !reply.tool_calls?.length ||
        (reply.confidence ?? 1) < BURST_MIN_CONFIDENCE)
    ) {
      // Plan complete or choice uncertain: discard the reply and think.
      act = false;
      setBurst(false);
      continue;
    }
    if (act) setBurst(true);
    if (reply.tool_calls && reply.tool_calls.length > 0) {
      const plan = callbacks.burst && !act ? reply.reasoning?.trim() : "";
      messages.push({
        role: "assistant",
        content: plan
          ? `<plan>
${plan.slice(-PLAN_MAX_CHARS)}
</plan>
${reply.content}`
          : reply.content,
        tool_calls: reply.tool_calls,
      });
      let failed = false;
      for (const tc of reply.tool_calls) {
        callbacks.onToolCall?.(tc.function.name, 0);
        let output: string;
        try {
          const args = JSON.parse(tc.function.arguments) as Record<
            string,
            unknown
          >;
          output = await tools.run(tc.function.name, args);
        } catch {
          output = `error: failed to execute ${tc.function.name}`;
        }
        failed ||= output.startsWith("error:");
        messages.push({ role: "tool", content: output, tool_call_id: tc.id });
      }
      act = !!callbacks.burst && !failed;
      if (!act) setBurst(false);
    } else {
      messages.push({ role: "assistant", content: reply.content });
      return { ok: true, value: reply.content };
    }
  }
}

/**
 * Run a subagent: a fresh conversation, isolated from the parent's, carrying
 * its own system message and profile. The subagent runs the same tool loop as
 * the parent (it receives the same `ToolRunner` and `Tool[]`, so it may in
 * turn call `run_subagent` and spawn its own subagents). Returns the
 * subagent's final assistant text.
 *
 * Pure: no `node:` imports, no I/O beyond the `Client` and `ToolRunner`. The
 * `profileText` is the subagent's defining instructions; it is appended as a
 * user message (never into the system message), the same convention the
 * session uses for `/profile <name>`.
 */
export async function runSubagent(
  client: Client,
  tools: ToolRunner,
  toolDefs: Tool[],
  systemMessage: Message,
  profileText: string,
  task: string,
  callbacks: TurnCallbacks = {},
): Promise<Result<string>> {
  const messages: Message[] = [systemMessage];
  if (profileText.trim() !== "") {
    messages.push({ role: "user", content: profileText });
  }
  messages.push({ role: "user", content: task });
  return runTurn(client, tools, messages, toolDefs, callbacks);
}
