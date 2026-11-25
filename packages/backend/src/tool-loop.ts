import type { ChatStreamEvent, Result } from "common";
import { err, ok } from "common";
import type { ToolCall, UpstreamMessage } from "./chat";
import { openUpstream, readRound, streamFrom } from "./chat";
import type { Approval } from "./approvals";
import { openApproval } from "./approvals";
import { runTool } from "./tools";
import { PROJECT_ROOT } from "./workdir";

// The most rounds of tool calls one reply may take before the backend stops.
const MAX_TOOL_ROUNDS = 5;

// Waits for the user on one proposed change. The reply stays open until they answer, and
// the change is written only if they approve it.
async function* awaitApproval(
  approval: Approval,
): AsyncGenerator<ChatStreamEvent, string> {
  const pending = openApproval();
  try {
    yield {
      type: "approval",
      id: pending.id,
      title: approval.title,
      body: approval.body,
    };
    const approved = await pending.decided;
    if (!approved) {
      return "The user declined this change.";
    }
    return await approval.apply();
  } finally {
    pending.close();
  }
}

// Runs each tool call the model made and returns the results to send back. A change that
// needs approval waits for the user first.
async function* toolResults(
  calls: ToolCall[],
): AsyncGenerator<ChatStreamEvent, UpstreamMessage[]> {
  const results: UpstreamMessage[] = [];
  for (const call of calls) {
    const outcome = await runTool(PROJECT_ROOT, call.name, call.arguments);
    let content: string;
    if (typeof outcome === "string") {
      content = outcome;
    } else {
      content = yield* awaitApproval(outcome);
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

// The whole reply: text as it streams, and tool rounds in between, each answered by the
// backend before the model continues.
async function* replyEvents(
  apiKey: string,
  model: string,
  messages: UpstreamMessage[],
  first: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent, void> {
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
    const results = yield* toolResults(calls);
    conversation = [...conversation, assistantToolCalls(calls), ...results];
    const next = await openUpstream(apiKey, model, conversation);
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

// Sends the conversation and returns the reply as typed events, as they arrive. Tool
// rounds are run here, so the client sees only the text and any approvals to answer.
export async function streamChatReply(
  apiKey: string,
  model: string,
  messages: UpstreamMessage[],
): Promise<Result<ReadableStream<ChatStreamEvent>, string>> {
  const first = await openUpstream(apiKey, model, messages);
  if (!first.ok) {
    return err(first.error);
  }
  return ok(streamFrom(replyEvents(apiKey, model, messages, first.value)));
}
