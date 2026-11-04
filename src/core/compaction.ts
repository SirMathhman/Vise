import type { ChatMessage, Reply } from "./messages.ts";
import { err, ok, type Result } from "./result.ts";

const KEEP_RECENT = 6;
const COMPACT_REQUEST = "Summarize this convo";
const COMPACT_AT = 0.8;

// What the frontend keeps between messages. promptTokens is the size the model
// reported for the last request. compacted is true from a compaction until a
// request reports a size again.
export interface Conversation {
  history: ChatMessage[];
  promptTokens?: number;
  compacted: boolean;
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
