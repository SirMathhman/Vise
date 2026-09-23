// Wire-protocol shapes for the OpenAI-compatible chat API. Pure types; no
// I/O. Shared by the client and the conversation so the message shape is
// defined in exactly one place.
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

// The accumulated result of one streaming chat completion: the answer text,
// any tool calls, the model's reasoning, and usage as reported by the server.
export type ChatCompletionReply = {
  content: string;
  toolCalls: ToolCall[];
  reasoning: string;
  usage?: Usage;
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  // The model's reasoning/thinking, separate from `content` (llama.cpp's
  // OpenAI-compatible server emits it as `reasoning_content`, mirroring the
  // DeepSeek API). Present on assistant messages only. Stored so the model
  // can see its own prior reasoning on the next turn; some templates honor it,
  // others ignore it.
  reasoning_content?: string | null;
};

// The JSON Schema fragment declaring a tool's arguments, as sent in the
// request's `tools` field. Every tool defines `type: "object"` plus a
// `properties` map of argument name -> schema; `required` names the args that
// must be supplied.
export type ToolParameters = {
  type: "object";
  properties: Record<string, { type?: string; description?: string }>;
  required?: string[];
};

// The tool the model can call, as declared in the request's `tools` field.
export type Tool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: ToolParameters;
  };
};

// A tracked background process, as held by the process tracker. Type-level
// only; no I/O.
export type TrackedProcess = {
  proc: Bun.Subprocess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  finished: boolean;
};

// Structural API the tool handlers rely on for background-process
// management. Defined here (llm layer) so ToolContext does not import from
// the tools layer; the tools-layer ProcessTracker satisfies it structurally,
// so no handler changes are required to adopt it.
export type ProcessTrackerApi = {
  spawn: (command: string) => { id: string; t: TrackedProcess };
  get: (id: string) => TrackedProcess | undefined;
  remove: (id: string) => void;
  shutdown: () => Promise<void>;
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
  tracker: ProcessTrackerApi;
  depth: number;
  tools: Tool[];
  toolsEnabled: boolean;
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
    message?: {
      content?: string | null;
      tool_calls?: ToolCall[];
      reasoning_content?: string | null;
    };
  }[];
};

// Token accounting for one completion, as reported by the server. Present on
// non-streaming responses, and on the final streamed chunk when the request
// carries `stream_options: { include_usage: true }`.
export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

// The shape of one SSE chunk from /v1/chat/completions with stream: true.
// Each chunk carries a `delta` with the next content fragment and/or the
// next tool-call fragment; tool-call fragments arrive split across chunks
// and the client reassembles them by index. `usage` arrives on the final
// chunk only, alongside (not inside) `choices`, matching llama.cpp's
// stream_options.include_usage behavior.
export type ChatCompletionChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: Usage;
};

// The shape of the /v1/models response body.
export type ModelsResponse = {
  data?: { id?: string; status?: { value?: string } }[];
};

// The shape of the /props response body. `n_ctx` (the server's context
// window, in tokens) lives under default_generation_settings.
export type PropsResponse = {
  default_generation_settings?: { n_ctx?: number };
};
