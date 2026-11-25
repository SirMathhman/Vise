import type { ChatStreamEvent, Result } from "common";
import { err, ok } from "common";
import type { ToolCall, UpstreamMessage } from "../openrouter";
import { openUpstream, readRound, streamFrom } from "../openrouter";
import type { Approval } from "./approvals";
import { openApproval, waitForApproval } from "./approvals";
import { runTool, toolDefinitions } from "../tools";
import type { ReplyContext, SubagentRunner } from "./reply-context";
import { PROJECT_ROOT } from "../project/workdir";
import { MAX_CHARS, cutNote } from "../process/run";

// The most rounds of tool calls one reply may take before the backend stops.
const MAX_TOOL_ROUNDS = 5;

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
): AsyncGenerator<ChatStreamEvent, UpstreamMessage[]> {
  const results: UpstreamMessage[] = [];
  for (const call of calls) {
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
  context: ReplyContext,
): SubagentRunner {
  return async (task) => {
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
      toolDefinitions,
      { root: context.root, self: context.self },
      undefined,
    );
    if (!started.ok) {
      return `The subagent could not start: ${started.error}`;
    }
    const reader = started.value.getReader();
    let text = "";
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
        return `The subagent failed: ${event.message}`;
      }
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
  relay: Relay | undefined,
): AsyncGenerator<ChatStreamEvent, void> {
  // Only the main reply, which has a relay, may start subagents.
  const toolContext =
    relay === undefined
      ? context
      : {
          ...context,
          subagent: subagentRunner(apiKey, model, signal, relay, context),
        };
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
    const results = yield* toolResults(calls, signal, toolContext, relay);
    // The client has gone: do not ask the model again.
    if (signal?.aborted) {
      return;
    }
    conversation = [...conversation, assistantToolCalls(calls), ...results];
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

// Sends one request and returns its reply as typed events. The relay is set only for the main
// reply.
async function openReply(
  apiKey: string,
  model: string,
  messages: UpstreamMessage[],
  signal: AbortSignal | undefined,
  tools: typeof toolDefinitions,
  context: ReplyContext,
  relay: Relay | undefined,
): Promise<Result<ReadableStream<ChatStreamEvent>, string>> {
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
        relay,
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
  return openReply(
    apiKey,
    model,
    messages,
    signal,
    tools,
    context,
    new Relay(),
  );
}
