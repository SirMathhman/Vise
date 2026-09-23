// The single module that knows the wire protocol and the only place
// fetch() is called. Everything else talks to the model through this module.
import type { Config } from "../config.ts";
import type {
  ChatCompletionChunk,
  ChatCompletionReply,
  ChatCompletionResponse,
  ChatMessage,
  PrefillTimings,
  PropsResponse,
  Tool,
  ToolCall,
  Usage,
} from "./types.ts";

type ClientConfig = Pick<Config, "baseUrl" | "apiKey">;

// Headers shared by every request to the server.
const authHeaders = (apiKey: string | undefined): Record<string, string> =>
  apiKey ? { Authorization: `Bearer ${apiKey}` } : {};

// Generic GET that returns parsed JSON. The only fetch call for non-chat
// endpoints. Throws on transport/HTTP errors.
export async function getJson(
  config: ClientConfig,
  path: string,
): Promise<unknown> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    headers: authHeaders(config.apiKey),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}

// The result of a single embedding: a flat vector of floats, or a list of
// per-token embedding vectors (when unpooled, as returned by llama.cpp).
export type EmbeddingResult = {
  embedding: number[] | number[][];
};

// POSTs a list of texts to the server's /embeddings endpoint and returns
// one EmbeddingResult per input, in order. The single fetch site for
// embedding requests (the LLM client is the only module that calls fetch,
// invariant 2).
export async function embeddings(
  config: ClientConfig,
  model: string,
  input: string[],
): Promise<EmbeddingResult[]> {
  const res = await fetch(`${config.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(config.apiKey),
    },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  const body = (await res.json()) as
    | EmbeddingResult[]
    | { data?: EmbeddingResult[] };
  if (Array.isArray(body)) {
    return body;
  }
  return body.data ?? [];
}

// Fetches the server's context window size (n_ctx) from GET /props. Returns
// undefined if the server doesn't report it (older servers, or a field
// rename), rather than throwing, since this is advisory display data.
export async function getContextSize(
  config: ClientConfig,
): Promise<number | undefined> {
  const props = (await getJson(config, "/props")) as PropsResponse;
  return props.default_generation_settings?.n_ctx;
}

// Sends the conversation and returns the model's reply. Throws on
// transport/HTTP errors. The active model is passed at request time, not
// captured at startup, so a switch takes effect on the next turn.
// `reasoningBudget`, when set, is sent as a per-request reasoning_budget_tokens
// in exact mode (see chatCompletionStream); when unset, the server's own
// --reasoning-budget applies.
export async function chatCompletion(
  config: ClientConfig,
  model: string,
  messages: ChatMessage[],
  tools: Tool[],
  reasoningBudget?: number,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(config.apiKey),
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      ...(reasoningBudget !== undefined
        ? {
            reasoning_budget_tokens: reasoningBudget,
            reasoning_budget_exact: true,
          }
        : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as ChatCompletionResponse;
  const msg = data.choices?.[0]?.message;
  return { content: msg?.content ?? "", toolCalls: msg?.tool_calls ?? [] };
}

// Rough tokens-per-character ratio used to estimate a live reasoning-token
// count from the streamed reasoning text. The server only reports exact token
// counts on the final chunk (and only for the whole completion), so a live
// per-delta count is inherently an estimate; this is a deliberate, cheap
// approximation for display, not an accounting.
const REASONING_CHARS_PER_TOKEN = 4;

// Sends the conversation as a streaming request (stream: true) and returns
// the model's reply. Throws on transport/HTTP errors, same as
// chatCompletion. Content deltas are passed to onDelta as they arrive, so
// the caller can render them to the terminal in real time; reasoning
// (thinking) deltas are passed to onReasoning as a running token estimate so
// the caller can show a bounded "thinking" indicator. Tool calls are
// reassembled from the split delta fragments by index and returned in full.
// The full reasoning text is returned so the caller can preserve it on the
// assistant message (llama.cpp's server accepts reasoning_content back on
// assistant messages). `stream_options.include_usage` asks the server to
// attach token counts to the final chunk; `usage` is undefined if the server
// doesn't honor it. `return_progress` asks the server to stream live
// prefill progress on early chunks; each arrives via onPrefill as
// (processed, total, cache, timeMs) and is never called if the server
// doesn't honor it (older builds). `reasoningBudget`, when set, is sent as a
// per-request reasoning_budget_tokens in exact mode (llama.cpp fork: the
// model thinks exactly the budget before the end is forced); when unset, the
// server's own --reasoning-budget applies.
export async function chatCompletionStream(
  config: ClientConfig,
  model: string,
  messages: ChatMessage[],
  tools: Tool[],
  onDelta: (content: string) => void,
  onReasoning: (tokens: number) => void,
  onPrefill?: (
    processed: number,
    total: number,
    cache: number,
    timeMs: number,
  ) => void,
  reasoningBudget?: number,
): Promise<ChatCompletionReply> {
  const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(config.apiKey),
    },
    body: JSON.stringify({
      model,
      messages,
      tools,
      stream: true,
      stream_options: { include_usage: true },
      return_progress: true,
      ...(reasoningBudget !== undefined
        ? {
            reasoning_budget_tokens: reasoningBudget,
            reasoning_budget_exact: true,
          }
        : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  if (!res.body) throw new Error("server sent no response body");

  const content: string[] = [];
  const reasoning: string[] = [];
  let reasoningLength = 0;
  const toolCalls: ToolCall[] = [];
  let usage: Usage | undefined;
  let prefill: PrefillTimings | undefined;
  const decoder = new TextDecoder();
  let buffer = "";
  // Processes one "data: ..." SSE line, appending the content delta to the
  // result and forwarding it to onDelta, accumulating the reasoning delta and
  // forwarding a running token estimate to onReasoning, reassembling
  // tool-call fragments by index into toolCalls, and capturing usage and the
  // prefill timings from the final chunk.
  const processLine = (line: string): void => {
    const data = line.slice("data:".length).trim();
    if (data.length === 0 || data === "[DONE]") return;
    const chunk = JSON.parse(data) as ChatCompletionChunk;
    if (chunk.usage) usage = chunk.usage;
    if (chunk.timings) prefill = chunk.timings;
    if (chunk.prompt_progress && onPrefill) {
      onPrefill(
        chunk.prompt_progress.processed,
        chunk.prompt_progress.total,
        chunk.prompt_progress.cache,
        chunk.prompt_progress.time_ms,
      );
    }
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.reasoning_content) {
      reasoning.push(delta.reasoning_content);
      reasoningLength += delta.reasoning_content.length;
      onReasoning(Math.round(reasoningLength / REASONING_CHARS_PER_TOKEN));
    }
    if (delta?.content) {
      content.push(delta.content);
      onDelta(delta.content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const existing = toolCalls[tc.index];
      if (existing) {
        existing.id += tc.id ?? "";
        existing.function.name += tc.function?.name ?? "";
        existing.function.arguments += tc.function?.arguments ?? "";
      } else {
        toolCalls[tc.index] = {
          id: tc.id ?? "",
          type: "function",
          function: {
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "",
          },
        };
      }
    }
  };
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.startsWith("data:")) processLine(line);
    }
  }
  const remaining = buffer.trim();
  if (remaining.startsWith("data:")) processLine(remaining);
  return {
    content: content.join(""),
    toolCalls,
    reasoning: reasoning.join(""),
    usage,
    prefill,
  };
}
