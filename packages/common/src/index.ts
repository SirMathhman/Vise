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
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
  return (
    messages.length <= MAX_CONVERSATION_MESSAGES &&
    chars <= MAX_CONVERSATION_CHARS
  );
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
