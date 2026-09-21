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
