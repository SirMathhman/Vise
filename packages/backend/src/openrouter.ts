import type { ChatStreamEvent, ModelSummary, Result } from "common";
import { err, ok, parseJson } from "common";
import { z } from "zod";

const MODELS_URL = "https://openrouter.ai/api/v1/models";

// OpenRouter's model list. Prices are USD per token, as strings.
const OpenRouterModelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      context_length: z.number(),
      pricing: z.object({ prompt: z.string(), completion: z.string() }),
    }),
  ),
});

// OpenRouter reports a negative price (-1) for models whose price varies per request.
function perMillion(price: string): number | null {
  const value = Number(price) * 1_000_000;
  return value < 0 ? null : value;
}

/**
 * Lists the models the account can use, with prices in USD per million tokens. Returns an error when OpenRouter cannot be reached or its reply does not match the expected shape.
 *
 * @param apiKey The OpenRouter key to list the models with.
 * @returns The models, with prices in USD per million tokens, or the error that stopped the request.
 */
export async function fetchModels(
  apiKey: string,
): Promise<Result<ModelSummary[], string>> {
  let res: Response;
  try {
    res = await fetchWithTimeout(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return err("Could not reach OpenRouter");
  }
  if (!res.ok) {
    return err(`OpenRouter responded with HTTP ${String(res.status)}`);
  }

  const parsed = parseJson(OpenRouterModelsSchema, await res.text());
  if (!parsed.ok) {
    return err("OpenRouter returned a model list in an unexpected format");
  }
  return ok(
    parsed.value.data.map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length,
      promptPricePerMillion: perMillion(m.pricing.prompt),
      completionPricePerMillion: perMillion(m.pricing.completion),
    })),
  );
}

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

// How long OpenRouter may take to send the headers of a reply. Covers the wait for the reply to
// start, not the stream after it.
const UPSTREAM_TIMEOUT_MS = 60_000;

// Sends a request, and gives up when OpenRouter does not answer in time.
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// A piece of one tool call. The fragments of a call share an index.
const ToolCallFragmentSchema = z.object({
  index: z.number(),
  id: z.string().optional(),
  function: z
    .object({ name: z.string().optional(), arguments: z.string().optional() })
    .optional(),
});

// One streamed chunk from OpenRouter's chat completions endpoint.
const ChatChunkSchema = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
  // The exact tokens of the request, reported once the reply is complete.
  usage: z.object({ prompt_tokens: z.number().optional() }).optional(),
  choices: z
    .array(
      z.object({
        delta: z
          .object({
            content: z.string().nullish(),
            tool_calls: z.array(ToolCallFragmentSchema).optional(),
          })
          .optional(),
        finish_reason: z.string().nullish(),
      }),
    )
    .optional(),
});

/**
 * A tool call the model made, assembled from its streamed fragments.
 */
export interface ToolCall {
  /** The id the model gave this call. */
  id: string;
  /** The name of the tool the model called. */
  name: string;
  /** The arguments, as the JSON text the model wrote. */
  arguments: string;
}

// A text event the upstream stream yields, as it arrives.
interface UpstreamEventItem {
  kind: "event";
  event: ChatStreamEvent;
}

// The tool calls that end a round of the upstream stream.
interface UpstreamToolCallsItem {
  kind: "toolCalls";
  calls: ToolCall[];
}

// What the upstream stream yields: a text event, or the tool calls that end a round.
type UpstreamItem = UpstreamEventItem | UpstreamToolCallsItem;

// A system or user message as sent upstream.
interface PlainUpstreamMessage {
  role: "system" | "user";
  content: string;
}

// The function half of a tool call the assistant made.
interface UpstreamFunctionCall {
  name: string;
  arguments: string;
}

// One tool call the assistant made, as sent upstream.
interface UpstreamToolCall {
  id: string;
  type: "function";
  function: UpstreamFunctionCall;
}

// An assistant message as sent upstream, with any tool calls it made.
interface AssistantUpstreamMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: UpstreamToolCall[];
}

// The result of a tool call, sent back upstream.
interface ToolUpstreamMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

/**
 * A message as sent upstream. Only the backend builds system and tool messages.
 */
export type UpstreamMessage =
  PlainUpstreamMessage | AssistantUpstreamMessage | ToolUpstreamMessage;

// Yields the complete lines of an SSE body, and cancels it when the consumer stops.
async function* sseLines(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      pending += decoder.decode(chunk.value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      yield* lines;
    }
    yield pending + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// The data after "data:" in one SSE line, or undefined for blank lines and comments.
function ssePayload(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return undefined;
  }
  const payload = trimmed.slice("data:".length).trim();
  return payload === "" ? undefined : payload;
}

// Adds one fragment to the tool call it belongs to.
function mergeFragment(
  calls: Map<number, ToolCall>,
  fragment: z.infer<typeof ToolCallFragmentSchema>,
): void {
  const call = calls.get(fragment.index) ?? { id: "", name: "", arguments: "" };
  calls.set(fragment.index, {
    id: fragment.id ?? call.id,
    name: fragment.function?.name ?? call.name,
    arguments: call.arguments + (fragment.function?.arguments ?? ""),
  });
}

// Reads one round of the upstream stream: text as it arrives, then either a terminal
// event or the tool calls that end the round.
async function* upstreamItems(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<UpstreamItem> {
  const calls = new Map<number, ToolCall>();
  try {
    for await (const line of sseLines(body)) {
      const payload = ssePayload(line);
      if (payload === undefined) {
        continue;
      }
      if (payload === "[DONE]") {
        yield { kind: "event", event: { type: "done" } };
        return;
      }
      const parsed = parseJson(ChatChunkSchema, payload);
      if (!parsed.ok) {
        yield {
          kind: "event",
          event: {
            type: "error",
            message:
              parsed.error.kind === "notJson"
                ? "OpenRouter sent a stream chunk that is not JSON"
                : "OpenRouter sent a stream chunk in an unexpected format",
          },
        };
        return;
      }
      const chunk = parsed.value;
      if (chunk.error) {
        yield {
          kind: "event",
          event: {
            type: "error",
            message: chunk.error.message ?? "OpenRouter stream failed",
          },
        };
        return;
      }
      if (chunk.usage?.prompt_tokens !== undefined) {
        yield {
          kind: "event",
          event: { type: "usage", promptTokens: chunk.usage.prompt_tokens },
        };
      }
      const choice = chunk.choices?.[0];
      for (const fragment of choice?.delta?.tool_calls ?? []) {
        mergeFragment(calls, fragment);
      }
      const text = choice?.delta?.content;
      if (text) {
        yield { kind: "event", event: { type: "delta", text } };
      }
      if (choice?.finish_reason === "tool_calls") {
        yield { kind: "toolCalls", calls: [...calls.values()] };
        return;
      }
    }
    yield {
      kind: "event",
      event: {
        type: "error",
        message: "The reply ended before it was finished",
      },
    };
  } catch (failure) {
    yield {
      kind: "event",
      event: {
        type: "error",
        message: failure instanceof Error ? failure.message : String(failure),
      },
    };
  }
}

/**
 * Streams one round as text events. Returns the tool calls that end it, or undefined
 * when the reply is over.
 *
 * @param body The raw body of the upstream stream.
 * @returns Each line of the body, one at a time.
 */
export async function* readRound(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent, ToolCall[] | undefined> {
  for await (const item of upstreamItems(body)) {
    if (item.kind === "toolCalls") {
      return item.calls;
    }
    yield item.event;
    if (item.event.type === "done" || item.event.type === "error") {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Sends a request upstream, and returns the raw body. The model is offered the given tools;
 * an empty list offers none.
 *
 * @param apiKey The OpenRouter key to send with the request.
 * @param model The model id to ask.
 * @param messages The conversation to send.
 * @param tools The tools the model may be offered. Empty for none.
 * @returns The raw body to read, or the error that prevented the request.
 */
export async function openUpstream(
  apiKey: string,
  model: string,
  messages: UpstreamMessage[],
  tools: readonly object[],
): Promise<Result<ReadableStream<Uint8Array>, string>> {
  let res: Response;
  try {
    res = await fetchWithTimeout(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(tools.length > 0 ? { tools } : {}),
      }),
    });
  } catch {
    return err("Could not reach OpenRouter");
  }
  if (!res.ok || !res.body) {
    return err(`OpenRouter responded with HTTP ${String(res.status)}`);
  }
  return ok(res.body);
}
