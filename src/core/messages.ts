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
  // The reasoning items the provider sent with the tool calls, kept exactly as they came. They go back
  // with the next request, because the provider may need them to continue after a tool call.
  reasoning?: unknown[];
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
  onReasoning: (items: unknown[]) => void,
) => AsyncIterable<Result<string>>;

export type ContextWindow = () => Promise<Result<number>>;

// A model OpenRouter lists: its id, and its context window in tokens.
export interface ModelInfo {
  id: string;
  contextLength: number;
}

// The model the session uses, and the models it may switch to. `select` refuses a name that is not
// listed, and resolves with the name it chose.
export interface ModelPorts {
  current(): string;
  list(): Promise<Result<ModelInfo[]>>;
  select(name: string): Promise<Result<string>>;
}
