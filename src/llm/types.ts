// Wire-protocol shapes for the OpenAI-compatible chat API. Pure types; no
// I/O. Shared by the client and the conversation so the message shape is
// defined in exactly one place.
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

// The accumulated result of one streaming chat completion: the answer text,
// any tool calls, the model's reasoning, usage as reported by the server,
// and the prefill-phase timings when the server reports them.
export type ChatCompletionReply = {
  content: string;
  toolCalls: ToolCall[];
  reasoning: string;
  usage?: Usage;
  prefill?: PrefillTimings;
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
  properties: Record<
    string,
    {
      type?: string;
      description?: string;
      enum?: string[];
      items?: { type?: string };
    }
  >;
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

export type AskQuestionRequest = {
  question: string;
  type: "freeform" | "multiple_choice" | "multiple_select";
  options?: string[];
};

// Thrown by a tool handler for an expected failure (e.g. a subagent whose
// server connection dropped). runTool reports the call as failed and hands
// the message to the model as the result; any other error aborts the turn.
export class ToolFailure extends Error {}

export type ToolCallObserver = {
  onToolCallStart?: (
    name: string,
    args: Record<string, unknown>,
    depth: number,
  ) => void;
  onToolCallEnd?: (
    name: string,
    durationMs: number,
    status: "done" | "failed" | "disabled" | "unknown",
    depth: number,
    // Why a failed call failed; set only when status is "failed".
    error?: string,
  ) => void;
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
  askQuestion?: (request: AskQuestionRequest) => Promise<string>;
  toolCallObserver?: ToolCallObserver;
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

// Phase timings reported by llama.cpp's server on the final chunk of a
// streamed completion (and on non-streaming responses). `prompt_*` fields
// describe the prefill (prompt-processing) phase, which runs before any
// token is generated: `prompt_n` is the number of prompt tokens processed,
// `cache_n` is the subset reused from the KV cache (not re-prefilled),
// `prompt_ms` is wall time, and `prompt_per_second` is the prefill
// throughput. All fields are optional: a server that doesn't report timings
// (older builds) simply omits the object.
export type PrefillTimings = {
  prompt_n?: number;
  cache_n?: number;
  prompt_ms?: number;
  prompt_per_second?: number;
};

// Live prefill (prompt-processing) progress, streamed by llama.cpp's server
// on early chunks (before any content/reasoning) when the request carries
// `return_progress: true`. `total` is the full prompt token count, `cache` is
// the subset reused from the KV cache, `processed` has advanced from `cache`
// toward `total` as new tokens are prefilled, and `time_ms` is the wall time
// so far. `processed - cache` over `total - cache` is the timed progress.
// Absent when the server doesn't honor `return_progress` (older builds).
export type PromptProgress = {
  total: number;
  cache: number;
  processed: number;
  time_ms: number;
};

// The shape of one SSE chunk from /v1/chat/completions with stream: true.
// Each chunk carries a `delta` with the next content fragment and/or the
// next tool-call fragment; tool-call fragments arrive split across chunks
// and the client reassembles them by index. `usage` and `timings` arrive on
// the final chunk only, alongside (not inside) `choices`, matching llama.cpp's
// stream_options.include_usage behavior. `prompt_progress` arrives on early
// chunks while prefill runs when `return_progress: true` is set.
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
  timings?: PrefillTimings;
  prompt_progress?: PromptProgress;
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
