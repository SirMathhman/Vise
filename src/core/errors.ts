export interface ToolCall {
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

export type ViseError =
  | { kind: "http"; status: number; body: string }
  | { kind: "network"; cause: string }
  | { kind: "malformed"; body: string };

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ViseError };
