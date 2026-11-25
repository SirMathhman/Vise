import { describe, expect, test } from "bun:test";
import type { ChatStreamEvent } from "common";
import { chatEvents } from "../../src/chat/chat";

const encoder = new TextEncoder();

function bodyOf(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(encoder.encode(part));
      }
      controller.close();
    },
  });
}

async function collect(parts: string[]): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  const reader = chatEvents(bodyOf(parts)).getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return events;
    }
    events.push(next.value);
  }
}

describe("chatEvents", () => {
  test("streams text deltas and ends with done, skipping comments and empty deltas", async () => {
    const events = await collect([
      ": OPENROUTER PROCESSING\n\n",
      'data: {"choices":[{"index":0,"delta":{"content":"Hel","role":"assistant"}}]}\n\ndata: {"choi',
      'ces":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"stop"}],"usage":{"total_tokens":3}}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "done" },
    ]);
  });

  test("reports an error chunk as an error event and ends there", async () => {
    const events = await collect([
      'data: {"choices":[{"index":0,"delta":{"content":"Par"}}]}\n\n',
      'data: {"error":{"code":502,"message":"Provider disconnected unexpectedly"}}\n\n',
    ]);
    expect(events).toEqual([
      { type: "delta", text: "Par" },
      { type: "error", message: "Provider disconnected unexpectedly" },
    ]);
  });

  test("reports a reply cut off before [DONE] as an error", async () => {
    const events = await collect([
      'data: {"choices":[{"index":0,"delta":{"content":"Par"}}]}\n\n',
    ]);
    expect(events).toEqual([
      { type: "delta", text: "Par" },
      { type: "error", message: "The reply ended before it was finished" },
    ]);
  });

  test("reports a chunk in an unexpected shape as an error", async () => {
    const events = await collect(['data: {"choices":"nope"}\n\n']);
    expect(events).toEqual([
      {
        type: "error",
        message: "OpenRouter sent a stream chunk in an unexpected format",
      },
    ]);
  });

  test("reports a chunk that is not JSON as an error", async () => {
    const events = await collect(["data: {oops\n\n"]);
    expect(events).toEqual([
      {
        type: "error",
        message: "OpenRouter sent a stream chunk that is not JSON",
      },
    ]);
  });
});
