import type { Result } from "./result.ts";

// A call the model asked for. arguments is the JSON text the model wrote.
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: string;
  toolCalls?: ToolCall[];
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  content: string;
}

export type ChatMessage = UserMessage | AssistantMessage | ToolMessage;

// Token counts the provider reports for one request, taken from the stream. reasoningTokens is the
// exact count of thinking tokens, reported at the end of the reply; absent when the provider gives none.
export interface Usage {
  promptTokens: number;
  reasoningTokens?: number;
}

// How hard the model thinks before it answers. Absent means reasoning is off.
export type ReasoningEffort = "low" | "medium" | "high";

// Sends the messages to a model. Text arrives as ok values; a failure is one err value, and nothing follows it.
// Usage and tool calls are reported through the callbacks, tool calls once the reply ends. `tools`
// names the tools the model is offered in this request. `reasoning` turns thinking on at that effort.
// `onThinking` reports an approximate count of the thinking tokens so far, while the model thinks.
export type Reply = (
  messages: ChatMessage[],
  onUsage: (usage: Usage) => void,
  onToolCall: (call: ToolCall) => void,
  tools: string[],
  reasoning: ReasoningEffort | undefined,
  onThinking: (approximateTokens: number) => void,
) => AsyncIterable<Result<string>>;

export type ContextWindow = () => Promise<Result<number>>;
