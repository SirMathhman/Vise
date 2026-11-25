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

// Drops the oldest messages until the conversation fits. The newest message and a leading
// system message are always kept.
export function trimToBudget(messages: ChatMessage[]): ChatMessage[] {
  const pinned = messages[0]?.role === "system" ? messages.slice(0, 1) : [];
  const rest = messages.slice(pinned.length);
  let start = 0;
  while (
    start < rest.length - 1 &&
    !fitsBudget([...pinned, ...rest.slice(start)])
  ) {
    start += 1;
  }
  return [...pinned, ...rest.slice(start)];
}

export function greet(name: string): string {
  return `Hello, ${name}!`;
}
