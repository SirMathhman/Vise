import { afterEach, describe, expect, test } from "bun:test";
import type { ChatStreamEvent } from "common";
import { streamChatReply } from "../../src/chat/tool-loop";
import { toolDefinitions } from "../../src/tools";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Each upstream request gets the next scripted reply, and the last one repeats.
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

const callRound = (name: string, args: Record<string, string>): string[] => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}`,
  `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
];

const textRound = (text: string): string[] => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}`,
  `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
  "data: [DONE]",
];

describe("turned-off tools", () => {
  test("a turned-off tool is not offered, and a call to it is refused", async () => {
    const offered = toolDefinitions.filter(
      (tool) => tool.function.name !== "read_file",
    );
    const bodies = fakeUpstream([
      callRound("read_file", { path: "x" }),
      textRound("done"),
    ]);
    const result = await streamChatReply(
      "key",
      "openai/gpt-4o",
      [{ role: "user", content: "hi" }],
      undefined,
      offered,
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    const reader = result.value.getReader();
    const events: ChatStreamEvent[] = [];
    for (
      let next = await reader.read();
      !next.done;
      next = await reader.read()
    ) {
      events.push(next.value);
    }
    expect(bodies[0]).not.toContain('"name":"read_file"');
    expect(bodies[1]).toContain("The tool read_file is turned off.");
  });

  test("a subagent in a turn with a disabled tool cannot call that tool", async () => {
    const offered = toolDefinitions.filter(
      (tool) => tool.function.name !== "read_file",
    );
    const bodies = fakeUpstream([
      callRound("start_subagent", { task: "read it" }),
      callRound("read_file", { path: "x" }),
      textRound("sub done"),
      textRound("final"),
    ]);
    const result = await streamChatReply(
      "key",
      "openai/gpt-4o",
      [{ role: "user", content: "go" }],
      undefined,
      offered,
    );
    if (!result.ok) {
      throw new Error(result.error);
    }
    const reader = result.value.getReader();
    for (
      let next = await reader.read();
      !next.done;
      next = await reader.read()
    ) {
      // Drain the reply.
    }
    expect(bodies[1]).not.toContain('"name":"read_file"');
    expect(bodies[2]).toContain("The tool read_file is turned off.");
  });
});
