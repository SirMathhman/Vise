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
  /** USD per 1 million prompt tokens. */
  promptPricePerMillion: number;
  /** USD per 1 million completion tokens. */
  completionPricePerMillion: number;
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

export function greet(name: string): string {
  return `Hello, ${name}!`;
}
