export interface ToolCall {
  type: "function";
  id: string;
  function: { name: string; arguments: string };
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** The model's reply for a single round trip. */
export interface AssistantMessage {
  content: string;
  tool_calls?: ToolCall[];
}

/**
 * Prompt-processing progress, reported in every streaming chunk when the
 * request sets llama.cpp's `return_progress` flag. `processed` advances as
 * prompt tokens are computed; `cache` is the portion served from the KV
 * cache, and `total` is the full prompt length.
 */
export interface PromptProgress {
  total: number;
  cache: number;
  processed: number;
  time_ms: number;
}

export type ViseError =
  | { kind: "http"; status: number; body: string }
  | { kind: "network"; cause: string }
  | { kind: "malformed"; body: string };

export type Result<T> = { ok: true; value: T } | { ok: false; error: ViseError };
