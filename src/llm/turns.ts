// Shared model/tool-round protocol for the main conversation and subagents.
// Owns stream calls, tool-call accumulation, argument parsing, and appending
// assistant/tool messages; presentation and turn-level hooks stay with callers.

import type { Config } from "../config.ts";
import { chatCompletionStream } from "./client.ts";
import type { ChatCompletionReply, ChatMessage, Tool } from "./types.ts";

const MAX_TOOL_ROUNDS = 100;

// Context kept free after the reasoning budget for the answer (or a tool
// call) when the budget is capped to the space left in the context window.
const ANSWER_RESERVE_TOKENS = 1024;

// A per-turn reasoning budget plus what's needed to cap it: the /think
// level's tokens, the server's context window (undefined = not reported,
// budget sent uncapped), the last token count the server reported for this
// conversation (undefined = none yet), and how many leading messages that
// count covers. Messages after `measuredAt` are estimated.
export type ReasoningBudget = {
  tokens: number;
  contextSize?: number;
  usedTokens?: number;
  measuredAt?: number;
};

// Conservative characters-per-token ratio for estimating messages the server
// hasn't counted yet (tool results, the new user message, hook output).
// Deliberately lower than the display estimate in client.ts: an undercount
// here overflows the window mid-thought, an overcount only trims the budget.
const ESTIMATE_CHARS_PER_TOKEN = 3;

// Estimated token count of messages the server hasn't reported usage for.
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? "").length + (m.reasoning_content ?? "").length;
    for (const call of m.tool_calls ?? []) {
      chars += call.function.name.length + call.function.arguments.length;
    }
  }
  return Math.ceil(chars / ESTIMATE_CHARS_PER_TOKEN);
}

// The budget to send for one round. Reasoning can run all the way to the
// budget (the random cut-off may land at N), so a budget larger than the free
// context could fill the window mid-thought and leave no room for an answer;
// it is capped at
// the free context minus ANSWER_RESERVE_TOKENS (floored at 0, which the
// server treats as "end reasoning immediately").
export function effectiveReasoningBudget(
  tokens: number,
  contextSize: number | undefined,
  usedTokens: number,
): number {
  if (!contextSize) return tokens;
  const free = contextSize - usedTokens - ANSWER_RESERVE_TOKENS;
  return Math.max(0, Math.min(tokens, free));
}

export type ToolRoundObserver = {
  // Observer callbacks are part of the caller's control path: a failure aborts
  // the run. onRoundEnd runs after every started round, including failures;
  // its own error is propagated only when there is no earlier round error.
  onRoundStart?: (round: number) => void;
  onDelta?: (delta: string, round: number) => void;
  onReasoning?: (tokens: number, round: number) => void;
  onPrefill?: (
    processed: number,
    total: number,
    cache: number,
    timeMs: number,
    round: number,
  ) => void;
  onRoundEnd?: (round: number, reply: ChatCompletionReply | undefined) => void;
};

// Runs model completions until one returns a final answer. Tool-call
// assistant messages (including reasoning_content) and tool results are
// appended to messages between rounds. The final assistant message is also
// appended when non-empty before the reply is returned. Observer failures are
// fatal, but onRoundEnd is always attempted after onRoundStart; if stream and
// cleanup both fail, the original stream/start error is preserved. The
// reasoning budget, when given, is recomputed every round against the last
// reported usage plus an estimate of every message appended since (tool
// results, and before the first round the new user message and hook output),
// so tool rounds that grow the conversation shrink the budget. Best effort:
// the estimate is approximate.
export async function runToolRounds(
  config: Config,
  model: string,
  messages: ChatMessage[],
  tools: Tool[],
  dispatch: (name: string, args: Record<string, unknown>) => Promise<string>,
  observer: ToolRoundObserver = {},
  reasoning?: ReasoningBudget,
): Promise<ChatCompletionReply> {
  let usedTokens = reasoning?.usedTokens ?? 0;
  let measuredAt =
    reasoning?.usedTokens === undefined ? 0 : (reasoning.measuredAt ?? 0);
  for (let round = 0; ; round++) {
    if (round >= MAX_TOOL_ROUNDS) {
      throw new Error("Stopped after max tool rounds without a final answer");
    }
    let reply: ChatCompletionReply | undefined;
    let roundError: unknown;
    let failed = false;
    const sentMessages = messages.length;
    const budget =
      reasoning &&
      effectiveReasoningBudget(
        reasoning.tokens,
        reasoning.contextSize,
        usedTokens + estimateTokens(messages.slice(measuredAt)),
      );
    try {
      observer.onRoundStart?.(round);
      reply = await chatCompletionStream(
        config,
        model,
        messages,
        tools,
        (delta) => observer.onDelta?.(delta, round),
        (tokens) => observer.onReasoning?.(tokens, round),
        (processed, total, cache, timeMs) =>
          observer.onPrefill?.(processed, total, cache, timeMs, round),
        budget,
      );
    } catch (err) {
      failed = true;
      roundError = err;
    }
    try {
      // Observer failures are fatal, but always run the round-end callback;
      // if both the stream and cleanup fail, preserve the primary failure.
      observer.onRoundEnd?.(round, reply);
    } catch (err) {
      if (!failed) {
        failed = true;
        roundError = err;
      }
    }
    if (failed) throw roundError;
    if (!reply) throw new Error("Model round ended without a reply");
    if (reply.usage) {
      // total_tokens covers every message sent plus this reply, which is
      // appended next as one assistant message.
      usedTokens = reply.usage.total_tokens;
      measuredAt = sentMessages + 1;
    }

    if (reply.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: reply.content || null,
        tool_calls: reply.toolCalls,
        reasoning_content: reply.reasoning || null,
      });
      for (const call of reply.toolCalls) {
        const args = JSON.parse(call.function.arguments) as Record<
          string,
          unknown
        >;
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: await dispatch(call.function.name, args),
        });
      }
      continue;
    }

    if (reply.content.length > 0) {
      messages.push({
        role: "assistant",
        content: reply.content,
        reasoning_content: reply.reasoning || null,
      });
    }
    return reply;
  }
}
