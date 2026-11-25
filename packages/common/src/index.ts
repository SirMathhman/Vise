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

export function greet(name: string): string {
  return `Hello, ${name}!`;
}
