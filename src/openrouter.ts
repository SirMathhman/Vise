import { z } from "zod";
import type { ChatMessage, ToolCall, Usage } from "./core/messages.ts";
import { err, ok, type Result } from "./core/result.ts";
import { listFilesSpec, readFileSpec } from "./core/tools.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models";
const DONE = Symbol("done");

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const StreamEventSchema = z.object({
  error: z.object({ message: z.string().optional() }).nullish(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number(),
                  id: z.string().nullish(),
                  function: z.object({ name: z.string().nullish(), arguments: z.string().nullish() }).nullish(),
                }),
              )
              .nullish(),
          })
          .nullish(),
      }),
    )
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

// Converts the history to the provider's format. The last message is marked as a
// prompt-cache breakpoint when it is text, so the next request can reuse the prefix.
// The stored history is unchanged.
function wireMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((message, index) => toWire(message, index === messages.length - 1));
}

function toWire(message: ChatMessage, last: boolean): unknown {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant" && message.toolCalls) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  if (!last) return { role: message.role, content: message.content };
  return {
    role: message.role,
    content: [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }],
  };
}

interface StreamOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  fetch?: FetchLike;
  onUsage?: (usage: Usage) => void;
  onToolCall?: (call: ToolCall) => void;
}

// Yields each text delta as ok. The request's usage goes to onUsage when the server reports it,
// and each tool call goes to onToolCall once the reply has ended. A failure is yielded once as err,
// and nothing follows it.
export async function* streamChat(options: StreamOptions): AsyncGenerator<Result<string>> {
  const body = await postChat(options);
  if (!body.ok) {
    yield err(body.error);
    return;
  }
  const calls = new Map<number, ToolCall>();
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
    if (event.value === DONE) {
      emitToolCalls(calls, options.onToolCall);
      return;
    }
    if (event.value?.usage) options.onUsage?.(event.value.usage);
    if (event.value?.text) yield ok(event.value.text);
    for (const delta of event.value?.toolCalls ?? []) accumulate(calls, delta);
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
        messages: wireMessages(options.messages),
        tools: [listFilesSpec, readFileSpec],
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

// One piece of a tool call. The model sends the name and id once, and the arguments in pieces.
interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

// What one `data:` line carries. A single event can have several of these.
interface StreamEvent {
  text?: string;
  usage?: Usage;
  toolCalls?: ToolCallDelta[];
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
  const delta = event.choices?.[0]?.delta;
  return ok({
    text: delta?.content ?? undefined,
    usage: typeof promptTokens === "number" ? { promptTokens } : undefined,
    toolCalls: delta?.tool_calls?.map((call) => ({
      index: call.index,
      id: call.id ?? undefined,
      name: call.function?.name ?? undefined,
      arguments: call.function?.arguments ?? undefined,
    })),
  });
}

// Joins a tool call's pieces by index. The arguments arrive as text fragments that concatenate.
function accumulate(calls: Map<number, ToolCall>, delta: ToolCallDelta): void {
  const call = calls.get(delta.index) ?? { id: "", name: "", arguments: "" };
  if (delta.id) call.id = delta.id;
  if (delta.name) call.name = delta.name;
  call.arguments += delta.arguments ?? "";
  calls.set(delta.index, call);
}

function emitToolCalls(calls: Map<number, ToolCall>, onToolCall: ((call: ToolCall) => void) | undefined): void {
  for (const index of [...calls.keys()].sort((a, b) => a - b)) {
    const call = calls.get(index);
    if (call) onToolCall?.(call);
  }
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
