// The single module that knows the wire protocol and the only place
// fetch() is called. Everything else talks to the model through this module.
import type { Config } from "../config.ts";
import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  Tool,
  ToolCall,
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

// Sends the conversation and returns the model's reply. Throws on
// transport/HTTP errors. The active model is passed at request time, not
// captured at startup, so a switch takes effect on the next turn.
export async function chatCompletion(
  config: ClientConfig,
  model: string,
  messages: ChatMessage[],
  tools: Tool[],
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(config.apiKey),
    },
    body: JSON.stringify({ model, messages, tools }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as ChatCompletionResponse;
  const msg = data.choices?.[0]?.message;
  return { content: msg?.content ?? "", toolCalls: msg?.tool_calls ?? [] };
}

// Sends the conversation as a streaming request (stream: true) and returns
// the model's reply. Throws on transport/HTTP errors, same as
// chatCompletion. Content deltas are passed to onDelta as they arrive, so
// the caller can render them to the terminal in real time; tool calls are
// reassembled from the split delta fragments by index and returned in full.
export async function chatCompletionStream(
  config: ClientConfig,
  model: string,
  messages: ChatMessage[],
  tools: Tool[],
  onDelta: (content: string) => void,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await fetch(`${config.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(config.apiKey),
    },
    body: JSON.stringify({ model, messages, tools, stream: true }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  if (!res.body) throw new Error("server sent no response body");

  const content: string[] = [];
  const toolCalls: ToolCall[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  // Processes one "data: ..." SSE line, appending the content delta to the
  // result and forwarding it to onDelta, and reassembling tool-call
  // fragments by index into toolCalls.
  const processLine = (line: string): void => {
    const data = line.slice("data:".length).trim();
    if (data.length === 0 || data === "[DONE]") return;
    const chunk = JSON.parse(data) as ChatCompletionChunk;
    const delta = chunk.choices?.[0]?.delta;
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
  return { content: content.join(""), toolCalls };
}
