// Wire-protocol shapes for the OpenAI-compatible chat API. Pure types; no
// I/O. Shared by the client and the conversation so the message shape is
// defined in exactly one place.
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

// The tool the model can call, as declared in the request's `tools` field.
export type Tool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

// Per-call context handed to every tool handler. Carries the state a tool
// needs beyond its arguments: the active model (read at call time, not
// captured at startup), the shared background-process tracker, the
// subagent nesting depth, and the config + tool set + dispatch function a
// subagent needs to spawn its own tools. Passed by reference so the
// /model command's runtime switch is visible to every handler in flight.
export type ToolContext = {
  config: import("../config.ts").Config;
  model: string;
  tracker: import("../tools/process.ts").ProcessTracker;
  depth: number;
  tools: Tool[];
  dispatch: (
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<string>;
};

// A model the server can serve, as reported by GET /v1/models.
export type ModelInfo = { id: string; loaded: boolean };

// The shape of the /v1/chat/completions response body.
export type ChatCompletionResponse = {
  choices?: {
    message?: { content?: string | null; tool_calls?: ToolCall[] };
  }[];
};

// The shape of the /v1/models response body.
export type ModelsResponse = {
  data?: { id?: string; status?: { value?: string } }[];
};
