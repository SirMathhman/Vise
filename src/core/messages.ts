import type { Result } from "./result.ts";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// Token counts the provider reports for one request, taken from the stream.
export interface Usage {
  promptTokens: number;
}

// Sends the messages to a model. Text arrives as ok values; a failure is one err value, and nothing follows it.
export type Reply = (
  messages: ChatMessage[],
  onUsage: (usage: Usage) => void,
) => AsyncIterable<Result<string>>;

export type ContextWindow = () => Promise<Result<number>>;
