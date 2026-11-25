import { afterEach, describe, expect, test } from "bun:test";
import type { ChatStreamEvent } from "common";
import type { UpstreamMessage } from "../../src/openrouter";
import { streamChatReply } from "../../src/chat/tool-loop";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Replaces the upstream: each request gets the next scripted reply, and the last one repeats.
// Returns the request bodies it received.
function fakeUpstream(replies: string[][]): string[] {
  const bodies: string[] = [];
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    const lines =
      replies[Math.min(bodies.length - 1, replies.length - 1)] ?? [];
    return Promise.resolve(new Response(`${lines.join("\n")}\n`));
  }) as typeof fetch;
  return bodies;
}

const toolRound = (name: string): string[] => [
  `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"${name}","arguments":"{}"}}]},"finish_reason":null}]}`,
  `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
];

const textRound = (text: string): string[] => [
  `data: {"choices":[{"index":0,"delta":{"content":"${text}"},"finish_reason":null}]}`,
  `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
  "data: [DONE]",
];

async function collect(
  messages: UpstreamMessage[],
): Promise<ChatStreamEvent[]> {
  const result = await streamChatReply("key", "openai/gpt-4o", messages);
  if (!result.ok) {
    throw new Error(result.error);
  }
  const events: ChatStreamEvent[] = [];
  const reader = result.value.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return events;
    }
    events.push(next.value);
  }
}

describe("tool loop", () => {
  test("runs a tool the model asks for, then streams the answer", async () => {
    const bodies = fakeUpstream([toolRound("no_such_tool"), textRound("done")]);
    const events = await collect([{ role: "user", content: "hi" }]);
    expect(events).toEqual([{ type: "delta", text: "done" }, { type: "done" }]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("Unknown tool: no_such_tool");
  });

  test("stops after the round limit without running the tools of the last round", async () => {
    const bodies = fakeUpstream([toolRound("no_such_tool")]);
    const events = await collect([{ role: "user", content: "hi" }]);
    expect(events.at(-1)).toEqual({
      type: "error",
      message: "The model asked for too many tool calls in one reply",
    });
    // One request per round up to the limit: the fifth round's tools are not run.
    expect(bodies).toHaveLength(5);
  });

  test("offers no tools when the request turns them off", async () => {
    const bodies = fakeUpstream([textRound("summary")]);
    const result = await streamChatReply(
      "key",
      "openai/gpt-4o",
      [{ role: "user", content: "summarize" }],
      undefined,
      [],
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    await result.value.getReader().read();
    expect(bodies[0]).not.toContain('"tools"');
  });
});
