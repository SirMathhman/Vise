// The single module that knows the wire protocol and the only place
// fetch() is called. Everything else talks to the model through this module.
import type { Config } from "../config.ts";
import type {
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
