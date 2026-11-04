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

// Token counts the provider reports for one request, taken from the stream.
export interface Usage {
  promptTokens: number;
}

// Sends the messages to a model. Text arrives as ok values; a failure is one err value, and nothing follows it.
// Usage and tool calls are reported through the callbacks, tool calls once the reply ends.
export type Reply = (
  messages: ChatMessage[],
  onUsage: (usage: Usage) => void,
  onToolCall: (call: ToolCall) => void,
) => AsyncIterable<Result<string>>;

export type ContextWindow = () => Promise<Result<number>>;
