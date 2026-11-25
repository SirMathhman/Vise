// Code shared by the frontend and the backend: wire schemas, types, and pure helpers.
import type { ChatMessage } from "./wire";

export * from "./parse";
export * from "./result";
export * from "./wire";

// The size limit for one conversation, shared by the browser and the backend.
export const MAX_CONVERSATION_MESSAGES = 40;
export const MAX_CONVERSATION_CHARS = 20000;

// Whether a conversation is within the size limit.
export function fitsBudget(messages: ChatMessage[]): boolean {
  const usage = budgetUsage(messages);
  return (
    usage.messages <= MAX_CONVERSATION_MESSAGES &&
    usage.chars <= MAX_CONVERSATION_CHARS
  );
}

// How much of the budget a conversation uses: its characters and messages, and the larger of
// the two as a fraction of its limit.
export function budgetUsage(messages: ChatMessage[]): {
  chars: number;
  messages: number;
  ratio: number;
} {
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return {
    chars,
    messages: messages.length,
    ratio: Math.max(
      chars / MAX_CONVERSATION_CHARS,
      messages.length / MAX_CONVERSATION_MESSAGES,
    ),
  };
}

// Drops the oldest messages until the conversation fits. The newest message is always kept.
export function trimToBudget(messages: ChatMessage[]): ChatMessage[] {
  let start = 0;
  while (start < messages.length - 1 && !fitsBudget(messages.slice(start))) {
    start += 1;
  }
  return messages.slice(start);
}

export function greet(name: string): string {
  return `Hello, ${name}!`;
}
