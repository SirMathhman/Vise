import { describe, test, expect } from "bun:test";
import { streamChat } from "../src/client/llm.ts";
import type { AssistantMessage, Result } from "../src/core/errors.ts";

/** Build a ReadableStream from an array of SSE line chunks (each a Uint8Array). */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

describe("streamChat (edge)", () => {
  test("accumulates tool_calls by index across chunks", async () => {
    // Each `data:` line is a complete JSON payload; a single tool call's
    // parts arrive across four chunks (id, name, then arguments split in two).
    // Build each chunk with JSON.stringify so the escaping is unambiguous.
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "" } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "list_directory", arguments: "" } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp"}' } }] } }] })}\n\n`,
    ];
    const result = await streamChat(sseStream(chunks));
    const message: AssistantMessage = result.message;
    expect(message.tool_calls).toHaveLength(1);
    expect(message.tool_calls?.[0]?.id).toBe("call_1");
    expect(message.tool_calls?.[0]?.function.name).toBe("list_directory");
    expect(message.tool_calls?.[0]?.function.arguments).toBe('{"path":"/tmp"}');
  });

  test("captures usage.prompt_tokens from the final chunk", async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[]}\n\n',
      // Final chunk: usage present, no choices.
      'data: {"choices":[]}\n\n'.replace('{"choices":[]}', '{"choices":[],"usage":{"prompt_tokens":42}}'),
    ];
    const result = await streamChat(sseStream(chunks));
    expect(result.usage).toBe(42);
  });

  test("returns sawData=false for a stream with no data lines", async () => {
    const chunks = ["\n\n", "  \n\n", "\n"];
    const result = await streamChat(sseStream(chunks));
    expect(result.sawData).toBeFalse();
  });

  test("invokes onToken per content delta and accumulates content", async () => {
    const seen: string[] = [];
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const result = await streamChat(sseStream(chunks), (t) => seen.push(t));
    expect(result.message.content).toBe("Hello");
    expect(seen).toEqual(["Hel", "lo"]);
  });
});
