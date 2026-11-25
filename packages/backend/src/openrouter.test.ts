import { afterEach, describe, expect, test } from "bun:test";
import { fetchModels, openUpstream, readRound } from "./openrouter";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A request that never gets an answer, and ends only when its signal aborts.
function hangingFetch(): typeof fetch {
  return ((_url: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new Error("aborted"));
      });
    })) as typeof fetch;
}

const user = [{ role: "user" as const, content: "hi" }];

describe("upstream timeouts", () => {
  test("openUpstream returns an error when OpenRouter does not answer in time", async () => {
    globalThis.fetch = hangingFetch();
    const result = await openUpstream("key", "openai/gpt-4o", user, [], 10);
    expect(result).toEqual({ ok: false, error: "Could not reach OpenRouter" });
  });

  test("fetchModels returns an error when OpenRouter does not answer in time", async () => {
    globalThis.fetch = hangingFetch();
    const result = await fetchModels("key", 10);
    expect(result).toEqual({ ok: false, error: "Could not reach OpenRouter" });
  });
});

describe("upstream errors", () => {
  test("a non-200 reply reports the status and does not echo the upstream body", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("secret upstream detail", { status: 500 }),
      )) as unknown as typeof fetch;
    const result = await openUpstream("key", "openai/gpt-4o", user, [], 1000);
    expect(result).toEqual({
      ok: false,
      error: "OpenRouter responded with HTTP 500",
    });
  });
});

describe("readRound", () => {
  test("merges tool-call fragments in order when the stream is split mid-line", async () => {
    const text = [
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]},"finish_reason":null}]}`,
      `data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.ts\\"}"}}]},"finish_reason":null}]}`,
      `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
    ].join("\n");
    const encoder = new TextEncoder();
    const bytes = encoder.encode(`${text}\n`);
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < bytes.length; at += 17) {
      pieces.push(bytes.slice(at, at + 17));
    }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) {
          controller.enqueue(piece);
        }
        controller.close();
      },
    });

    const reader = readRound(body);
    let next = await reader.next();
    while (!next.done) {
      next = await reader.next();
    }
    expect(next.value).toEqual([
      { id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' },
    ]);
  });
});
