import type { ChatMessage, ContextWindow, Reply, Usage } from "./messages.ts";
import { err, ok, type Result } from "./result.ts";

const KEEP_RECENT = 6;
const COMPACT_REQUEST = "Summarize this convo";
const COMPACT_AT = 0.8;

// What the frontend keeps between messages. promptTokens is the size the model
// reported for the last completed request. compacted is true from a compaction
// until a request reports a size again.
export interface Conversation {
  history: ChatMessage[];
  promptTokens?: number;
  compacted: boolean;
}

// A transition's result: the conversation to keep, and a line to show the user, if any.
export interface Step {
  conversation: Conversation;
  notice?: string;
}

// The history sent to the model to produce a summary: the whole history, then the request.
export function compactionRequest(history: ChatMessage[]): ChatMessage[] {
  return [...history, { role: "user", content: COMPACT_REQUEST }];
}

// The new history: the summary, then the most recent messages. If the first kept
// message is also a user message, it is merged with the summary so roles alternate.
export function compactedHistory(summary: string, history: ChatMessage[]): ChatMessage[] {
  const [first, ...rest] = history.slice(-KEEP_RECENT);
  if (first?.role === "user") {
    return [{ role: "user", content: `${summary}\n\n${first.content}` }, ...rest];
  }
  return [{ role: "user", content: summary }, ...history.slice(-KEEP_RECENT)];
}

// True when the last prompt used most of the model's context window.
export function needsCompaction(promptTokens: number, contextLength: number): boolean {
  return promptTokens >= contextLength * COMPACT_AT;
}

// Replaces the history with a summary of it. On failure the conversation is returned
// unchanged inside the err, so the caller keeps what it had.
export async function compact(conversation: Conversation, reply: Reply): Promise<Result<Conversation>> {
  if (conversation.history.length === 0) return err(new Error("nothing to compact"));
  let summary = "";
  try {
    for await (const chunk of reply(compactionRequest(conversation.history), () => {})) {
      if (!chunk.ok) return chunk;
      summary += chunk.value;
    }
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  return ok({ history: compactedHistory(summary, conversation.history), compacted: true });
}

// Keeps the size of a completed request. A compaction is not needed to read it.
export function recordUsage(conversation: Conversation, usage: Usage): Conversation {
  return { ...conversation, promptTokens: usage.promptTokens, compacted: false };
}

// Compacts because the user asked for it (/compact).
export async function compactNow(conversation: Conversation, reply: Reply): Promise<Step> {
  const result = await compact(conversation, reply);
  if (result.ok) return { conversation: result.value, notice: "history compacted" };
  return { conversation, notice: `error: compaction failed: ${result.error.message}` };
}

// Compacts before a message when the last prompt used most of the window. Without a
// size from a completed request there is nothing to compare, so nothing happens.
export async function compactIfNeeded(
  conversation: Conversation,
  reply: Reply,
  contextWindow: ContextWindow,
): Promise<Step> {
  if (conversation.promptTokens === undefined) return { conversation };
  const window = await contextWindow();
  if (!window.ok) {
    return { conversation, notice: `error: could not check the context window: ${window.error.message}` };
  }
  if (!needsCompaction(conversation.promptTokens, window.value)) return { conversation };
  return compactNow(conversation, reply);
}
