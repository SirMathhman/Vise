import type { ChatMessage, ChatStreamEvent, Result } from "common";
import { err, ok, parseJson } from "common";
import { z } from "zod";
import { toolDefinitions } from "../tools";

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

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

// A tool call the model made, assembled from its streamed fragments.
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

// What the upstream stream yields: a text event, or the tool calls that end a round.
type UpstreamItem =
  | { kind: "event"; event: ChatStreamEvent }
  | { kind: "toolCalls"; calls: ToolCall[] };

// A message as sent upstream. Only the backend builds system and tool messages.
export type UpstreamMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

// Puts the backend's own instructions in front of the conversation. The client never
// sends these, so it cannot change the model's instructions.
export function withSystemContext(
  messages: ChatMessage[],
  directory: string,
): UpstreamMessage[] {
  return [
    { role: "system", content: `The working directory is ${directory}.` },
    ...messages,
  ];
}

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

// Streams one round as text events. Returns the tool calls that end it, or undefined
// when the reply is over.
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

// Turns one OpenRouter body into typed events, with no tool calls. Every stream ends
// with exactly one "done" or "error" event.
export function chatEvents(
  body: ReadableStream<Uint8Array>,
): ReadableStream<ChatStreamEvent> {
  return streamFrom(textOnly(body));
}

async function* textOnly(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent, void> {
  const calls = yield* readRound(body);
  if (calls !== undefined) {
    yield {
      type: "error",
      message: "The model asked for a tool, which this stream does not handle",
    };
  }
}

// Turns a generator of events into a stream that a client can read.
export function streamFrom(
  events: AsyncGenerator<ChatStreamEvent, void>,
): ReadableStream<ChatStreamEvent> {
  return new ReadableStream<ChatStreamEvent>({
    async pull(controller) {
      const next = await events.next();
      if (next.done) {
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });
}

// Sends a request upstream, offering the backend's tools, and returns the raw body.
export async function openUpstream(
  apiKey: string,
  model: string,
  messages: UpstreamMessage[],
): Promise<Result<ReadableStream<Uint8Array>, string>> {
  let res: Response;
  try {
    res = await fetch(CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        tools: toolDefinitions,
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
