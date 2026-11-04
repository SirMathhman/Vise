import type { ChatMessage } from "./core/messages.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const DONE = Symbol("done");

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export async function* streamChat(options: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  fetch?: FetchLike;
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
      const delta = parseEventLine(line);
      if (delta === DONE) return;
      if (delta) yield delta;
      newline = buffer.indexOf("\n");
    }
  }
  const last = parseEventLine(buffer);
  if (last === DONE) return;
  if (last) yield last;
  throw new Error("OpenRouter stream ended before it finished");
}

// Returns the text delta in a `data:` line, DONE at the end marker, or
// undefined for every other line (blank lines and comments such as
// `: OPENROUTER PROCESSING`).
function parseEventLine(line: string): string | typeof DONE | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "[DONE]") return DONE;
  const event = JSON.parse(payload);
  if (event.error) throw new Error(`OpenRouter error: ${event.error.message ?? "unknown error"}`);
  return event.choices?.[0]?.delta?.content ?? undefined;
}
