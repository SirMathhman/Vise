import type { ChatMessage } from "./messages.ts";

const KEEP_RECENT = 6;
const COMPACT_REQUEST = "Summarize this convo";
const COMPACT_AT = 0.8;

// The history sent to the model to produce a summary: the whole history, then the request.
export function compactionRequest(history: ChatMessage[]): ChatMessage[] {
  return [...history, { role: "user", content: COMPACT_REQUEST }];
}

// The new history: the summary, then the most recent messages.
export function compactedHistory(summary: string, history: ChatMessage[]): ChatMessage[] {
  return [{ role: "user", content: summary }, ...history.slice(-KEEP_RECENT)];
}

// True when the last prompt used most of the model's context window.
export function needsCompaction(promptTokens: number, contextLength: number): boolean {
  return promptTokens >= contextLength * COMPACT_AT;
}
