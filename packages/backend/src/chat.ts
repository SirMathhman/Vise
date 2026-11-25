import type { ChatStreamEvent, Result } from "common";
import { err, ok } from "common";

const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

// Shape of one streamed chunk from OpenRouter's chat completions endpoint.
interface ChatChunk {
  error?: { message?: string };
  choices?: { delta?: { content?: string | null } }[];
}

function isChoice(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const delta = (value as Record<string, unknown>).delta;
  if (delta === undefined) {
    return true;
  }
  if (typeof delta !== "object" || delta === null) {
    return false;
  }
  const content = (delta as Record<string, unknown>).content;
  return (
    content === undefined || content === null || typeof content === "string"
  );
}

function isChatChunk(value: unknown): value is ChatChunk {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const chunk = value as Record<string, unknown>;
  if (chunk.error !== undefined) {
    const error = chunk.error as Record<string, unknown> | null;
    if (typeof error !== "object" || error === null) {
      return false;
    }
    if (error.message !== undefined && typeof error.message !== "string") {
      return false;
    }
  }
  if (chunk.choices !== undefined) {
    if (!Array.isArray(chunk.choices)) {
      return false;
    }
    return (chunk.choices as unknown[]).every(isChoice);
  }
  return true;
}

// Returns the event carried by one validated chunk, or undefined when it has no text.
function eventFromChunk(chunk: ChatChunk): ChatStreamEvent | undefined {
  if (chunk.error) {
    return {
      type: "error",
      message: chunk.error.message ?? "OpenRouter stream failed",
    };
  }
  const text = chunk.choices?.[0]?.delta?.content;
  return text ? { type: "delta", text } : undefined;
}

// Returns the event in one SSE line. Blank lines and ": keep-alive" comments yield no event.
function eventFromSseLine(
  line: string,
): Result<ChatStreamEvent | undefined, string> {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return ok(undefined);
  }
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "") {
    return ok(undefined);
  }
  if (payload === "[DONE]") {
    const done: ChatStreamEvent = { type: "done" };
    return ok(done);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return err("OpenRouter sent a stream chunk that is not JSON");
  }
  if (!isChatChunk(parsed)) {
    return err("OpenRouter sent a stream chunk in an unexpected format");
  }
  return ok(eventFromChunk(parsed));
}

// Turns OpenRouter's SSE body into typed events. The stream always ends with exactly one
// "done" or "error" event, so a reply cut off mid-stream is reported as an error.
export function chatEvents(
  body: ReadableStream<Uint8Array>,
): ReadableStream<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  // Enqueues the events for complete lines. Reports how many were enqueued and
  // whether a terminal event was among them.
  function enqueueLines(
    lines: string[],
    controller: ReadableStreamDefaultController<ChatStreamEvent>,
  ): { count: number; terminal: boolean } {
    let count = 0;
    for (const line of lines) {
      const result = eventFromSseLine(line);
      const event: ChatStreamEvent | undefined = result.ok
        ? result.value
        : { type: "error", message: result.error };
      if (!event) {
        continue;
      }
      controller.enqueue(event);
      count += 1;
      if (event.type !== "delta") {
        return { count, terminal: true };
      }
    }
    return { count, terminal: false };
  }

  return new ReadableStream<ChatStreamEvent>({
    // pull must enqueue something before it returns, or the stream stalls,
    // so it keeps reading until an event is ready.
    async pull(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            const result = enqueueLines(
              (pending + decoder.decode()).split("\n"),
              controller,
            );
            pending = "";
            if (!result.terminal) {
              controller.enqueue({
                type: "error",
                message: "The reply ended before it was finished",
              });
            }
            controller.close();
            return;
          }
          pending += decoder.decode(value, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          const result = enqueueLines(lines, controller);
          if (result.terminal) {
            controller.close();
            await reader.cancel();
            return;
          }
          if (result.count > 0) {
            return;
          }
        }
      } catch (failure) {
        controller.enqueue({
          type: "error",
          message: failure instanceof Error ? failure.message : String(failure),
        });
        controller.close();
        await reader.cancel().catch(() => undefined);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

// Sends one user message and returns the reply as typed events, as they arrive.
export async function streamChatReply(
  apiKey: string,
  model: string,
  message: string,
): Promise<Result<ReadableStream<ChatStreamEvent>, string>> {
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
        messages: [{ role: "user", content: message }],
        stream: true,
      }),
    });
  } catch {
    return err("Could not reach OpenRouter");
  }
  if (!res.ok || !res.body) {
    return err(`OpenRouter responded with HTTP ${String(res.status)}`);
  }
  return ok(chatEvents(res.body));
}
