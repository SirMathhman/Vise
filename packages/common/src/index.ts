// Code shared by the frontend and the backend: types and pure helpers only.

export interface HealthResponse {
  status: "ok";
  service: string;
  time: string;
}

export interface ModelSummary {
  id: string;
  name: string;
  contextLength: number;
  /** USD per 1 million prompt tokens, or null when the price varies per request. */
  promptPricePerMillion: number | null;
  /** USD per 1 million completion tokens, or null when the price varies per request. */
  completionPricePerMillion: number | null;
}

export interface ModelsResponse {
  models: ModelSummary[];
}

export interface ErrorResponse {
  error: string;
}

export interface OpenRouterSettings {
  /** True when a key is saved in the UI or set in the environment. The key itself is never returned. */
  configured: boolean;
}

export interface SaveOpenRouterKeyRequest {
  apiKey: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  /** The whole conversation so far, ending with the user's new message. */
  messages: ChatMessage[];
}

// One event in the chat reply stream. A reply ends with exactly one "done" or "error" event.
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

// A value or an error, returned instead of thrown.
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// Checks one untrusted value against the ChatStreamEvent contract.
export function parseChatStreamEvent(
  value: unknown,
): Result<ChatStreamEvent, string> {
  if (typeof value === "object" && value !== null) {
    const event = value as Record<string, unknown>;
    if (event.type === "delta" && typeof event.text === "string") {
      const delta: ChatStreamEvent = { type: "delta", text: event.text };
      return ok(delta);
    }
    if (event.type === "done") {
      const done: ChatStreamEvent = { type: "done" };
      return ok(done);
    }
    if (event.type === "error" && typeof event.message === "string") {
      const failure: ChatStreamEvent = {
        type: "error",
        message: event.message,
      };
      return ok(failure);
    }
  }
  return err("Unexpected chat event");
}

// Checks an untrusted list of chat messages: each needs a known role and some text.
export function parseChatMessageList(
  value: unknown,
): Result<ChatMessage[], string> {
  if (!Array.isArray(value)) {
    return err("messages must be a list");
  }
  const messages: ChatMessage[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== "object" || item === null) {
      return err("each message must be an object");
    }
    const { role, content } = item as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") {
      return err("each message must be from the user or the assistant");
    }
    if (typeof content !== "string" || content.trim() === "") {
      return err("each message must have text");
    }
    messages.push({ role, content });
  }
  return ok(messages);
}

export function greet(name: string): string {
  return `Hello, ${name}!`;
}
