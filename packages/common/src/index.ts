// Code shared by the frontend and the backend: wire schemas, types, and pure helpers.
import type { ChatMessage } from "./wire";

export * from "./parse";
export * from "./result";
export * from "./wire";

/**
 * Tokens kept free in a model's context window, so the model has room to answer.
 */
export const RESERVED_REPLY_TOKENS = 4_000;

/**
 * The tokens a conversation may use with a model whose window holds contextLength tokens.
 *
 * @param contextLength The model's context window, in tokens.
 * @returns The tokens available to the conversation.
 */
export function conversationLimit(contextLength: number): number {
  return Math.max(0, contextLength - RESERVED_REPLY_TOKENS);
}

/**
 * An estimate of the tokens a piece of text takes: about four characters per token.
 *
 * @param text The text to measure.
 * @returns The estimated token count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * The estimated tokens a conversation uses, and that as a fraction of the limit.
 *
 * @param messages The conversation.
 * @param limit The tokens the conversation may use.
 * @returns The estimated tokens used, and that as a fraction of the limit.
 */
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

/**
 * Whether a conversation is within the limit.
 *
 * @param messages The conversation.
 * @param limit The tokens the conversation may use.
 * @returns True when the conversation is within the limit.
 */
export function fitsBudget(messages: ChatMessage[], limit: number): boolean {
  return budgetUsage(messages, limit).tokens <= limit;
}

/**
 * Drops the oldest messages until the conversation fits. The newest message is always kept.
 *
 * @param messages The conversation, oldest first.
 * @param limit The tokens the conversation may use.
 * @returns The most recent part of the conversation that fits.
 */
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

/**
 * The label that opens a compaction summary.
 */
export const SUMMARY_PREFIX = "Summary of the earlier conversation: ";

/**
 * Whether a message is a compaction summary, going by its label.
 *
 * @param message The message to check.
 * @returns True when the message is a compaction summary.
 */
export function isSummaryMessage(message: ChatMessage): boolean {
  return message.role === "user" && message.content.startsWith(SUMMARY_PREFIX);
}

/**
 * Replaces the older conversation with a summary. Earlier summaries are dropped, since the new
 * one covers them; the most recent of the other messages are kept after it.
 *
 * @param history The conversation so far.
 * @param summary The summary of the older part.
 * @param keepRecent How many of the most recent messages to keep.
 * @returns The new conversation, starting with the summary.
 */
export function compactConversation(
  history: ChatMessage[],
  summary: string,
  keepRecent: number,
): ChatMessage[] {
  const recent = history
    .filter((message) => !isSummaryMessage(message))
    .slice(-keepRecent);
  return [{ role: "user", content: `${SUMMARY_PREFIX}${summary}` }, ...recent];
}

/**
 * Returns a greeting for the given name.
 *
 * @param name The name to greet.
 * @returns The greeting.
 */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
