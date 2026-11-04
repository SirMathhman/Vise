import type { ChatMessage, Usage } from "./core/messages.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
const DONE = Symbol("done");

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// Yields text deltas. The request's usage goes to onUsage when the server reports it.
export async function* streamChat(options: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  fetch?: FetchLike;
  onUsage?: (usage: Usage) => void;
}): AsyncGenerator<string> {
  const send = options.fetch ?? fetch;
  const response = await send(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.model,
      messages: options.messages,
      stream: true,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenRouter returned ${response.status}: ${await response.text()}`);
  }
  if (!response.body) throw new Error("OpenRouter returned no body");

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const event = parseEventLine(line);
      if (event === DONE) return;
      if (event?.usage) options.onUsage?.(event.usage);
      if (event?.text) yield event.text;
      newline = buffer.indexOf("\n");
    }
  }
  const last = parseEventLine(buffer);
  if (last === DONE) return;
  if (last?.usage) options.onUsage?.(last.usage);
  if (last?.text) yield last.text;
  throw new Error("OpenRouter stream ended before it finished");
}

// What one `data:` line carries. A single event can have both.
type StreamEvent = { text?: string; usage?: Usage };

// Returns the event in a `data:` line, DONE at the end marker, or undefined for
// every other line (blank lines and comments such as `: OPENROUTER PROCESSING`).
function parseEventLine(line: string): StreamEvent | typeof DONE | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "[DONE]") return DONE;
  const event = JSON.parse(payload);
  if (event.error) throw new Error(`OpenRouter error: ${event.error.message ?? "unknown error"}`);
  const promptTokens = event.usage?.prompt_tokens;
  return {
    text: event.choices?.[0]?.delta?.content ?? undefined,
    usage: typeof promptTokens === "number" ? { promptTokens } : undefined,
  };
}

// The model's context window in tokens, from OpenRouter's model listing.
export async function modelContextWindow(options: {
  model: string;
  fetch?: FetchLike;
}): Promise<number> {
  const send = options.fetch ?? fetch;
  const response = await send(MODELS_ENDPOINT, { method: "GET" });
  if (!response.ok) {
    throw new Error(`OpenRouter returned ${response.status} for the model list`);
  }
  const listing = (await response.json()) as { data: { id: string; context_length: number }[] };
  const model = listing.data.find((entry) => entry.id === options.model);
  if (!model) throw new Error(`OpenRouter does not list ${options.model}`);
  return model.context_length;
}
