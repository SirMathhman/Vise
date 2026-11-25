// Code shared by the frontend and the backend: wire schemas, types, and pure helpers.
import type { ChatMessage } from "./wire";

export * from "./parse";
export * from "./result";
export * from "./wire";

// Tokens kept free in a model's context window, so the model has room to answer.
export const RESERVED_REPLY_TOKENS = 4_000;

// The tokens a conversation may use with a model whose window holds contextLength tokens.
export function conversationLimit(contextLength: number): number {
  return Math.max(0, contextLength - RESERVED_REPLY_TOKENS);
}

// An estimate of the tokens a piece of text takes: about four characters per token.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// The estimated tokens a conversation uses, and that as a fraction of the limit.
export function budgetUsage(
  messages: ChatMessage[],
  limit: number,
): { tokens: number; ratio: number } {
  const tokens = messages.reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0,
  );
  return { tokens, ratio: limit > 0 ? tokens / limit : 1 };
}

// Whether a conversation is within the limit.
export function fitsBudget(messages: ChatMessage[], limit: number): boolean {
  return budgetUsage(messages, limit).tokens <= limit;
}

// Drops the oldest messages until the conversation fits. The newest message is always kept.
export function trimToBudget(
  messages: ChatMessage[],
  limit: number,
): ChatMessage[] {
  let start = 0;
  while (
    start < messages.length - 1 &&
    !fitsBudget(messages.slice(start), limit)
  ) {
    start += 1;
  }
  return messages.slice(start);
}

export function greet(name: string): string {
  return `Hello, ${name}!`;
}
