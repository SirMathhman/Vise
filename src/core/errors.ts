export interface ToolCall {
  type: "function";
  id: string;
  function: { name: string; arguments: string };
}

/**
 * A picture the model can see, by reference: the id (a SHA-256) of its bytes in
 * the image store, so conversations and saved sessions stay small. `label` is
 * what to call it when shown to the user.
 */
export interface Picture {
  id: string;
  /** The type of the bytes (`image/png`, `image/jpeg`, `image/gif` or `image/webp`). */
  mime: string;
  label: string;
  /** Size of the picture file in bytes. */
  bytes: number;
  width?: number;
  height?: number;
}

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Pictures that came with this message (a screenshot a tool took, an image the user attached). */
  images?: Picture[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** The model's reply for a single round trip. */
export interface AssistantMessage {
  content: string;
  tool_calls?: ToolCall[];
  /** The model's reasoning text, when the client captured it (tool mode). */
  reasoning?: string;
  /** Burst mode: the model signalled that its plan is complete. */
  done?: boolean;
  /**
   * Burst mode: lowest probability (0..1) among the tokens that chose each
   * called tool's name. Undefined when no probabilities were requested.
   */
  confidence?: number;
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
  | { kind: "malformed"; body: string }
  | { kind: "interrupted" };

export type Result<T> =
  { ok: true; value: T } | { ok: false; error: ViseError };
