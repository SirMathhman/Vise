import { expect, test } from "bun:test";
import type { Usage } from "./core/messages.ts";
import { modelContextWindow, streamChat } from "./openrouter.ts";

test("streams text deltas from server-sent events and stops at [DONE]", async () => {
  const body = [
    ": OPENROUTER PROCESSING\n\n",
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    "data: [DONE]\n\n",
    'data: {"choices":[{"delta":{"content":"late"}}]}\n\n',
  ].join("");
  let sentBody = "";
  const fakeFetch = async (_url: string, init: RequestInit) => {
    sentBody = String(init.body);
    return new Response(body, { status: 200 });
  };

  const parts: string[] = [];
  for await (const part of streamChat({
    apiKey: "key",
    model: "anthropic/claude-haiku-5.5",
    messages: [{ role: "user", content: "hi" }],
    fetch: fakeFetch,
  })) {
    parts.push(part);
  }

  expect(parts).toEqual(["Hel", "lo"]);
  expect(JSON.parse(sentBody).stream).toBe(true);
});

async function collect(body: string): Promise<string[]> {
  const fakeFetch = async () => new Response(body, { status: 200 });
  const parts: string[] = [];
  for await (const part of streamChat({
    apiKey: "key",
    model: "anthropic/claude-haiku-5.5",
    messages: [{ role: "user", content: "hi" }],
    fetch: fakeFetch,
  })) {
    parts.push(part);
  }
  return parts;
}

test("throws when an error event arrives in the stream", async () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"error":{"message":"provider failed"}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  await expect(collect(body)).rejects.toThrow("OpenRouter error: provider failed");
});

test("throws when the stream ends before [DONE]", async () => {
  const body = 'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n';
  await expect(collect(body)).rejects.toThrow("ended before it finished");
});

test("throws a clear error when an event does not match the expected shape", async () => {
  const body = 'data: {"choices":"not a list"}\n\n';
  await expect(collect(body)).rejects.toThrow("OpenRouter sent a stream event that does not match");
});

test("reports the prompt tokens from the usage event", async () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":13,"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const fakeFetch = async () => new Response(body, { status: 200 });
  const usages: Usage[] = [];
  const parts: string[] = [];
  for await (const part of streamChat({
    apiKey: "key",
    model: "anthropic/claude-haiku-5.5",
    messages: [{ role: "user", content: "hi" }],
    fetch: fakeFetch,
    onUsage: (usage) => usages.push(usage),
  })) {
    parts.push(part);
  }
  expect(parts).toEqual(["Hi"]);
  expect(usages).toEqual([{ promptTokens: 13 }]);
});

test("reads the model's context window from the model listing", async () => {
  const listing = {
    data: [
      { id: "other/model", context_length: 8 },
      { id: "anthropic/claude-haiku-5.5", context_length: 1000000 },
    ],
  };
  const fakeFetch = async () => new Response(JSON.stringify(listing), { status: 200 });
  const window = await modelContextWindow({
    model: "anthropic/claude-haiku-5.5",
    fetch: fakeFetch,
  });
  expect(window).toBe(1000000);
});

test("keeps the text and the usage when one event carries both", async () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"Hi"}}],"usage":{"prompt_tokens":7}}\n\n',
    "data: [DONE]\n\n",
  ].join("");
  const fakeFetch = async () => new Response(body, { status: 200 });
  const usages: Usage[] = [];
  const parts: string[] = [];
  for await (const part of streamChat({
    apiKey: "key",
    model: "anthropic/claude-haiku-5.5",
    messages: [{ role: "user", content: "hi" }],
    fetch: fakeFetch,
    onUsage: (usage) => usages.push(usage),
  })) {
    parts.push(part);
  }
  expect(parts).toEqual(["Hi"]);
  expect(usages).toEqual([{ promptTokens: 7 }]);
});
