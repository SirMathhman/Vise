import {
  compactIfNeeded,
  enabledTools,
  profileCommands,
  queueHookOutput,
  recordUsage,
  type Conversation,
} from "../core/compaction.ts";
import { type ChatMessage, type ReasoningEffort, type ReplyRequest, type ToolCall, type Usage, type Result } from "../core/messages.ts";
import type { Emit } from "../protocol/protocol.ts";
import { runCalls } from "./calls.ts";
import type { SessionPorts } from "./ports.ts";

// What one request to the model produced: its text, the calls it asked for, and its usage.
interface Round {
  answer: string;
  calls: ToolCall[];
  usage?: Usage;
  failure?: Error;
  // The reasoning items of the reply, kept to send back with its tool calls.
  reasoning?: unknown[];
}

// What one request of a turn needs: the history it sends, where the events go, and the tools and
// thinking setting it uses.
interface RoundInput {
  history: ChatMessage[];
  reply(request: ReplyRequest): AsyncIterable<Result<string>>;
  emit: Emit;
  offered: string[];
  reasoning: ReasoningEffort | undefined;
}

// Asks the model once. Text and thinking are emitted as they arrive. The thinking count is shown only
// while the model thinks, before its answer starts.
async function streamRound(input: RoundInput): Promise<Round> {
  const { history, reply, emit, offered, reasoning } = input;
  const round: Round = { answer: "", calls: [] };
  let approximate = 0;
  // Ends the thinking count with the provider's exact count when it reported one, or the estimate.
  const finishThinking = () => {
    const exact = round.usage?.reasoningTokens;
    emit({
      kind: "thinkingDone",
      tokens: exact ?? approximate,
      exact: exact !== undefined,
    });
  };
  try {
    const request = {
      messages: history,
      onUsage: (usage: Usage) => {
        round.usage = usage;
      },
      onToolCall: (call: ToolCall) => {
        round.calls.push(call);
      },
      tools: offered,
      reasoning,
      onThinking: (count: number) => {
        // Thinking that comes after the answer has started is not shown; the model thinks first.
        if (round.answer !== "") return;
        approximate = count;
        emit({ kind: "thinking", approximate: count });
      },
      onReasoning: (items: unknown[]) => {
        round.reasoning = items;
      },
    };
    for await (const chunk of reply(request)) {
      if (!chunk.ok) {
        finishThinking();
        return { ...round, failure: chunk.error };
      }
      round.answer += chunk.value;
      emit({ kind: "text", text: chunk.value });
    }
  } catch (error) {
    finishThinking();
    return {
      ...round,
      failure: error instanceof Error ? error : new Error(String(error)),
    };
  }
  finishThinking();
  return round;
}

// What a turn needs from the session.
export interface TurnContext {
  ports: SessionPorts;
  emit: Emit;
  finished(): boolean;
  approve(preview: string): Promise<boolean>;
}

// What a turn leaves behind: the conversation to keep, and whether the session must stop.
export interface TurnResult {
  conversation: Conversation;
  stop: boolean;
}

// Runs one message as a turn. The turn-start hooks run first, and their output waits for the message;
// a failure of one stops this turn before it begins. The turn-end hooks run after the turn, whatever
// its outcome, and a failure of one stops the session.
export async function runMessageTurn(
  text: string,
  conversation: Conversation,
  context: TurnContext,
): Promise<TurnResult> {
  const { ports, emit, finished, approve } = context;
  const { reply, contextWindow, tools, instructions } = ports;
  const started = await ports.hooks(
    "turnStart",
    profileCommands(conversation, "turnStart"),
  );
  if (!started.ok) {
    emit({
      kind: "error",
      message: `turn-start hook failed: ${started.error.message}`,
    });
    return { conversation, stop: false };
  }
  emit({ kind: "hookOutput", text: started.value });
  const compacted = await compactIfNeeded(
    queueHookOutput(conversation, started.value),
    reply,
    contextWindow,
  );
  if (compacted.notice) emit({ kind: "notice", text: compacted.notice });
  let current = compacted.conversation;
  // The instructions go in front of the first user message, so roles still alternate and compaction
  // drops them with the rest of the old history. A pending profile and pending hook output go in
  // front of the message after them, and are kept until a turn succeeds.
  const turnStart = current.history.length;
  const first = current.history.length === 0 ? instructions : undefined;
  const profile = current.pendingProfile;
  const pending = current.pendingOutput;
  const parts = [first, profile, pending, text].filter(
    (part): part is string => part !== undefined,
  );
  current.history.push({ role: "user", content: parts.join("\n\n") });
  current = { ...current, pendingProfile: undefined, pendingOutput: undefined };
  // Each round asks the model. The first round answers the message just received; a round that
  // asked for tools is followed by another only while the session has not ended.
  for (;;) {
    const round = await streamRound({
      history: current.history,
      reply,
      emit,
      offered: enabledTools(current),
      reasoning: current.thinking,
    });
    if (round.failure) {
      current.history.splice(turnStart);
      current = { ...current, pendingProfile: profile, pendingOutput: pending };
      emit({ kind: "replyEnd" });
      emit({ kind: "error", message: round.failure.message });
      break;
    }
    current.history.push({
      role: "assistant",
      content: round.answer,
      toolCalls: round.calls.length > 0 ? round.calls : undefined,
      reasoning: round.calls.length > 0 ? round.reasoning : undefined,
    });
    // Only a completed request reports its size; a failed one leaves the stored size alone.
    if (round.usage) current = recordUsage(current, round.usage);
    if (round.calls.length === 0) {
      emit({ kind: "replyEnd" });
      break;
    }
    const results = await runCalls({
      calls: round.calls,
      tools,
      approve,
      finished,
      offered: enabledTools(current),
      emit,
      subagents: ports,
      disabledTools: current.disabledTools ?? [],
    });
    current.history.push(...results);
    if (finished()) break;
  }
  const ended = await ports.hooks(
    "turnEnd",
    profileCommands(current, "turnEnd"),
  );
  if (!ended.ok) {
    emit({
      kind: "error",
      message: `turn-end hook failed: ${ended.error.message}`,
    });
    return { conversation: current, stop: true };
  }
  emit({ kind: "hookOutput", text: ended.value });
  return { conversation: queueHookOutput(current, ended.value), stop: false };
}
