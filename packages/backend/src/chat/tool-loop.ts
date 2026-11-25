import type { ChatStreamEvent, Result } from "common";
import { err, estimateTokens, ok } from "common";
import type { ToolCall, UpstreamMessage } from "../openrouter";
import { openUpstream, readRound, streamFrom } from "../openrouter";
import type { Approval } from "./approvals";
import { openApproval, waitForApproval } from "./approvals";
import { isToolName, runTool, toolDefinitions } from "../tools";
import type { ReplyContext, SubagentRunner } from "./reply-context";
import type { ModelSelf } from "./model-facts";
import { PROJECT_ROOT } from "../project/workdir";
import { MAX_CHARS, cutNote } from "../process/run";

// The most rounds of tool calls one reply may take before the backend stops.
const MAX_TOOL_ROUNDS = 5;

// How many subagents one chat turn may start, and how many model calls its subagents may make
// together. The main reply is not counted.
const TURN_SUBAGENT_STARTS = 3;
const TURN_SUBAGENT_CALLS = 20;

// What the subagents of one turn may still spend. Shared by all of them.
interface TurnBudget {
  starts: number;
  calls: number;
}

// Spends one model call of the turn's budget. A call that would not fit the model's window is
// refused, as the main reply's conversation is refused before it is sent.
function spendCall(
  budget: TurnBudget,
  messages: UpstreamMessage[],
  tools: typeof toolDefinitions,
  self: ModelSelf | undefined,
): boolean {
  if (budget.calls <= 0) {
    return false;
  }
  if (self !== undefined) {
    const limit = self.contextLength - self.replyReserveTokens;
    const size =
      estimateTokens(JSON.stringify(messages)) +
      estimateTokens(JSON.stringify(tools));
    if (size > limit) {
      return false;
    }
  }
  budget.calls -= 1;
  return true;
}

// The main reply: it has a relay for its subagents' events, and the turn's budget for them.
interface MainScope {
  kind: "main";
  relay: Relay;
  budget: TurnBudget;
}

// A subagent: its model calls are spent from the turn's budget.
interface SubagentScope {
  kind: "subagent";
  budget: TurnBudget;
}

type ReplyScope = MainScope | SubagentScope;

// Events raised while a tool runs, such as a subagent's approvals, waiting to reach the client.
// The reply sends them as they arrive, rather than after the tool finishes.
class Relay {
  private queued: ChatStreamEvent[] = [];
  private wake: (() => void) | undefined;

  push(event: ChatStreamEvent): void {
    this.queued.push(event);
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  takeAll(): ChatStreamEvent[] {
    return this.queued.splice(0);
  }

  // Resolves at the next push.
  nextPush(): Promise<void> {
    return new Promise((resolve) => {
      this.wake = () => {
        resolve();
      };
    });
  }
}

// Waits for approval on one proposed change. The reply stays open until the user answers, and the
// change is written only if they approve it.
async function* awaitApproval(
  approval: Approval,
  signal?: AbortSignal,
): AsyncGenerator<ChatStreamEvent, string> {
  const pending = openApproval();
  try {
    yield {
      type: "approval",
      id: pending.id,
      title: approval.title,
      body: approval.body,
    };
    const approved = await waitForApproval(pending, signal);
    if (approved === undefined) {
      return "The user did not answer this change.";
    }
    if (!approved) {
      return "The user declined this change.";
    }
    return await approval.apply();
  } finally {
    pending.close();
  }
}

// Waits for a tool to finish, sending on the events it raises meanwhile.
async function* settle<T>(
  work: Promise<T>,
  relay: Relay,
): AsyncGenerator<ChatStreamEvent, T> {
  const state = { done: false };
  const finished = work.finally(() => {
    state.done = true;
  });
  while (!state.done) {
    yield* relay.takeAll();
    await Promise.race([finished, relay.nextPush()]);
  }
  yield* relay.takeAll();
  return await work;
}

// Runs each tool call the model made and returns the results to send back. A change that
// needs approval waits for the user first.
async function* toolResults(
  calls: ToolCall[],
  signal: AbortSignal | undefined,
  context: ReplyContext,
  relay: Relay | undefined,
  tools: typeof toolDefinitions,
): AsyncGenerator<ChatStreamEvent, UpstreamMessage[]> {
  const results: UpstreamMessage[] = [];
  for (const call of calls) {
    // A tool the user turned off is refused, even when the model names it anyway. A name that is
    // no tool at all goes to the registry, which reports it.
    if (
      isToolName(call.name) &&
      !tools.some((tool) => tool.function.name === call.name)
    ) {
      results.push({
        role: "tool",
        tool_call_id: call.id,
        content: `The tool ${call.name} is turned off.`,
      });
      continue;
    }
    const work = runTool(context, call.name, call.arguments);
    const outcome =
      relay === undefined ? await work : yield* settle(work, relay);
    let content: string;
    if (typeof outcome === "string") {
      content = outcome;
    } else {
      content = yield* awaitApproval(outcome, signal);
    }
    results.push({ role: "tool", tool_call_id: call.id, content });
  }
  return results;
}

// The assistant message that records the tool calls, as the model made them.
function assistantToolCalls(calls: ToolCall[]): UpstreamMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

// Runs a subagent on a task: a reply of its own with the same model and tools, except that it
// cannot start subagents. Its approvals go to the client through the parent reply. Only its final
// text comes back, cut to the same limit as command output.
function subagentRunner(
  apiKey: string,
  model: string,
  signal: AbortSignal | undefined,
  relay: Relay,
  budget: TurnBudget,
  context: ReplyContext,
  tools: typeof toolDefinitions,
): SubagentRunner {
  return async (task) => {
    if (budget.starts <= 0) {
      return "This turn has already started the most subagents it may. Finish the task yourself.";
    }
    budget.starts -= 1;
    const started = await openReply(
      apiKey,
      model,
      [
        {
          role: "user",
          content: `The working directory is ${context.root}.\n\n${task}`,
        },
      ],
      signal,
      tools,
      { root: context.root, self: context.self },
      { kind: "subagent", budget },
    );
    if (!started.ok) {
      return `The subagent could not start: ${started.error}`;
    }
    const reader = started.value.getReader();
    let text = "";
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        const event = next.value;
        if (event.type === "delta") {
          text += event.text;
        } else if (event.type === "approval") {
          relay.push(event);
        } else if (event.type === "error") {
          await reader.cancel();
          return `The subagent failed: ${event.message}`;
        }
      }
    } catch {
      return "The subagent failed: its reply stopped unexpectedly.";
    }
    if (text === "") {
      return "The subagent gave no answer.";
    }
    return text.length > MAX_CHARS
      ? `${text.slice(0, MAX_CHARS)}${cutNote()}`
      : text;
  };
}

// The whole reply: text as it streams, and tool rounds in between, each answered by the
// backend before the model continues.
async function* replyEvents(
  apiKey: string,
  model: string,
  messages: UpstreamMessage[],
  first: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  tools: typeof toolDefinitions,
  context: ReplyContext,
  scope: ReplyScope,
): AsyncGenerator<ChatStreamEvent, void> {
  // Only the main reply starts subagents.
  const toolContext =
    scope.kind === "main"
      ? {
          ...context,
          subagent: subagentRunner(
            apiKey,
            model,
            signal,
            scope.relay,
            scope.budget,
            context,
            tools,
          ),
        }
      : context;
  let conversation = messages;
  let body = first;
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const calls = yield* readRound(body);
    if (calls === undefined) {
      return;
    }
    // The last allowed round may not call tools: stop before running them or asking again.
    if (round === MAX_TOOL_ROUNDS - 1) {
      break;
    }
    const relay = scope.kind === "main" ? scope.relay : undefined;
    const results = yield* toolResults(
      calls,
      signal,
      toolContext,
      relay,
      tools,
    );
    // The client has gone: do not ask the model again.
    if (signal?.aborted) {
      return;
    }
    conversation = [...conversation, assistantToolCalls(calls), ...results];
    if (
      scope.kind === "subagent" &&
      !spendCall(scope.budget, conversation, tools, context.self)
    ) {
      yield {
        type: "error",
        message: "The subagents of this turn have used their model calls.",
      };
      return;
    }
    const next = await openUpstream(apiKey, model, conversation, tools);
    if (!next.ok) {
      yield { type: "error", message: next.error };
      return;
    }
    body = next.value;
  }
  yield {
    type: "error",
    message: "The model asked for too many tool calls in one reply",
  };
}

// Sends one request and returns its reply as typed events. A subagent's first request is spent
// from the turn's budget before it is sent.
async function openReply(
  apiKey: string,
  model: string,
  messages: UpstreamMessage[],
  signal: AbortSignal | undefined,
  tools: typeof toolDefinitions,
  context: ReplyContext,
  scope: ReplyScope,
): Promise<Result<ReadableStream<ChatStreamEvent>, string>> {
  if (
    scope.kind === "subagent" &&
    !spendCall(scope.budget, messages, tools, context.self)
  ) {
    return err("The subagents of this turn have used their model calls.");
  }
  const first = await openUpstream(apiKey, model, messages, tools);
  if (!first.ok) {
    return err(first.error);
  }
  return ok(
    streamFrom(
      replyEvents(
        apiKey,
        model,
        messages,
        first.value,
        signal,
        tools,
        context,
        scope,
      ),
    ),
  );
}

/**
 * Sends the conversation and returns the reply as typed events, as they arrive. Tool
 * rounds are run here, so the client sees only the text and any approvals to answer.
 * The signal ends the reply when the client goes away.
 *
 * @param apiKey The OpenRouter key to send with each request.
 * @param model The model id to ask.
 * @param messages The conversation to send.
 * @param signal Aborts the reply when the client has gone away.
 * @param tools The tools offered in every round. Empty for none.
 * @param context What the reply passes to its tools: the project root and the model's facts.
 * @returns The reply as typed events, or the error that prevented it from starting.
 */
export function streamChatReply(
  apiKey: string,
  model: string,
  messages: UpstreamMessage[],
  signal?: AbortSignal,
  tools: typeof toolDefinitions = toolDefinitions,
  context: ReplyContext = { root: PROJECT_ROOT },
): Promise<Result<ReadableStream<ChatStreamEvent>, string>> {
  return openReply(apiKey, model, messages, signal, tools, context, {
    kind: "main",
    relay: new Relay(),
    budget: { starts: TURN_SUBAGENT_STARTS, calls: TURN_SUBAGENT_CALLS },
  });
}
