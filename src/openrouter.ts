import { z } from "zod";
import type { ChatMessage, Usage } from "./core/messages.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
const DONE = Symbol("done");

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const StreamEventSchema = z.object({
  error: z.object({ message: z.string().optional() }).nullish(),
  choices: z
    .array(z.object({ delta: z.object({ content: z.string().nullish() }).nullish() }))
    .optional(),
  usage: z.object({ prompt_tokens: z.number().optional() }).nullish(),
});

const ModelListingSchema = z.object({
  data: z.array(z.object({ id: z.string(), context_length: z.number() })),
});

// Parses `text` as JSON and checks it against `schema`. `what` names the payload
// in the error, so a bad response says where it came from.
function decode<T>(schema: z.ZodType<T>, text: string, what: string): T {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`OpenRouter sent ${what} that is not JSON`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`OpenRouter sent ${what} that does not match the expected shape: ${result.error.message}`);
  }
  return result.data;
}

interface StreamOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  fetch?: FetchLike;
  onUsage?: (usage: Usage) => void;
}

// Yields text deltas. The request's usage goes to onUsage when the server reports it.
export async function* streamChat(options: StreamOptions): AsyncGenerator<string> {
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
interface StreamEvent {
  text?: string;
  usage?: Usage;
}

// Returns the event in a `data:` line, DONE at the end marker, or undefined for
// every other line (blank lines and comments such as `: OPENROUTER PROCESSING`).
function parseEventLine(line: string): StreamEvent | typeof DONE | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "[DONE]") return DONE;
  const event = decode(StreamEventSchema, payload, "a stream event");
  if (event.error) throw new Error(`OpenRouter error: ${event.error.message ?? "unknown error"}`);
  const promptTokens = event.usage?.prompt_tokens;
  return {
    text: event.choices?.[0]?.delta?.content ?? undefined,
    usage: typeof promptTokens === "number" ? { promptTokens } : undefined,
  };
}

interface ModelContextOptions {
  model: string;
  fetch?: FetchLike;
}

// The model's context window in tokens, from OpenRouter's model listing.
export async function modelContextWindow(options: ModelContextOptions): Promise<number> {
  const send = options.fetch ?? fetch;
  const response = await send(MODELS_ENDPOINT, { method: "GET" });
  if (!response.ok) {
    throw new Error(`OpenRouter returned ${response.status} for the model list`);
  }
  const listing = decode(ModelListingSchema, await response.text(), "a model listing");
  const model = listing.data.find((entry) => entry.id === options.model);
  if (!model) throw new Error(`OpenRouter does not list ${options.model}`);
  return model.context_length;
}
