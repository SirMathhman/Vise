import { z } from "zod";
import type { ChatMessage, Usage } from "./core/messages.ts";
import { err, ok, type Result } from "./core/result.ts";

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
function decode<T>(schema: z.ZodType<T>, text: string, what: string): Result<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err(new Error(`OpenRouter sent ${what} that is not JSON`));
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    return err(
      new Error(`OpenRouter sent ${what} that does not match the expected shape: ${result.error.message}`),
    );
  }
  return ok(result.data);
}

// Marks the last message as a prompt-cache breakpoint. The next request starts with the
// same messages, so the provider can reuse the cached prefix. The stored history is unchanged.
function withCacheBreakpoint(messages: ChatMessage[]): unknown[] {
  return messages.map((message, index) =>
    index === messages.length - 1
      ? { role: message.role, content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }] }
      : message,
  );
}

interface StreamOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  fetch?: FetchLike;
  onUsage?: (usage: Usage) => void;
}

// Yields each text delta as ok. A failure is yielded once as err, and nothing follows it.
export async function* streamChat(options: StreamOptions): AsyncGenerator<Result<string>> {
  const body = await postChat(options);
  if (!body.ok) {
    yield err(body.error);
    return;
  }
  for await (const line of lines(body.value)) {
    if (!line.ok) {
      yield err(line.error);
      return;
    }
    const event = parseEventLine(line.value);
    if (!event.ok) {
      yield err(event.error);
      return;
    }
    if (event.value === DONE) return;
    if (event.value?.usage) options.onUsage?.(event.value.usage);
    if (event.value?.text) yield ok(event.value.text);
  }
  yield err(new Error("OpenRouter stream ended before it finished"));
}

async function postChat(options: StreamOptions): Promise<Result<ReadableStream<Uint8Array>>> {
  const send = options.fetch ?? fetch;
  try {
    const response = await send(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        messages: withCacheBreakpoint(options.messages),
        stream: true,
      }),
    });
    if (!response.ok) {
      return err(new Error(`OpenRouter returned ${response.status}: ${await response.text()}`));
    }
    if (!response.body) return err(new Error("OpenRouter returned no body"));
    return ok(response.body);
  } catch (error) {
    return err(new Error(`OpenRouter request failed: ${(error as Error).message}`));
  }
}

// Splits the body into lines. The last item is whatever followed the final newline.
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<Result<string>> {
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        yield ok(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    yield err(new Error(`OpenRouter stream failed: ${(error as Error).message}`));
    return;
  }
  yield ok(buffer);
}

// What one `data:` line carries. A single event can have both.
interface StreamEvent {
  text?: string;
  usage?: Usage;
}

// Returns the event in a `data:` line, DONE at the end marker, or undefined for
// every other line (blank lines and comments such as `: OPENROUTER PROCESSING`).
function parseEventLine(line: string): Result<StreamEvent | typeof DONE | undefined> {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return ok(undefined);
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "[DONE]") return ok(DONE);
  const decoded = decode(StreamEventSchema, payload, "a stream event");
  if (!decoded.ok) return err(decoded.error);
  const event = decoded.value;
  if (event.error) return err(new Error(`OpenRouter error: ${event.error.message ?? "unknown error"}`));
  const promptTokens = event.usage?.prompt_tokens;
  return ok({
    text: event.choices?.[0]?.delta?.content ?? undefined,
    usage: typeof promptTokens === "number" ? { promptTokens } : undefined,
  });
}

interface ModelContextOptions {
  model: string;
  fetch?: FetchLike;
}

// The model's context window in tokens, from OpenRouter's model listing.
export async function modelContextWindow(options: ModelContextOptions): Promise<Result<number>> {
  const send = options.fetch ?? fetch;
  let text: string;
  try {
    const response = await send(MODELS_ENDPOINT, { method: "GET" });
    if (!response.ok) return err(new Error(`OpenRouter returned ${response.status} for the model list`));
    text = await response.text();
  } catch (error) {
    return err(new Error(`OpenRouter model list request failed: ${(error as Error).message}`));
  }
  const listing = decode(ModelListingSchema, text, "a model listing");
  if (!listing.ok) return err(listing.error);
  const model = listing.value.data.find((entry) => entry.id === options.model);
  if (!model) return err(new Error(`OpenRouter does not list ${options.model}`));
  return ok(model.context_length);
}
