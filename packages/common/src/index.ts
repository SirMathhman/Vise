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

export interface ChatRequest {
  model: string;
  message: string;
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

// Splits text into pages of at most pageSize characters, so long text fits a bounded area.
// Empty text is one empty page.
export function pageText(text: string, pageSize: number): string[] {
  if (text.length === 0) {
    return [""];
  }
  const pages: string[] = [];
  for (let start = 0; start < text.length; start += pageSize) {
    pages.push(text.slice(start, start + pageSize));
  }
  return pages;
}

export function greet(name: string): string {
  return `Hello, ${name}!`;
}
