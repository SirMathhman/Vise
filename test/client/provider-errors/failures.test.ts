import { afterEach, expect, test } from "bun:test";
import { LlmClient } from "../../../src/client/llm.ts";
import { streamChat } from "../../../src/client/stream/stream-reader.ts";
import { applySettings } from "../../../src/config.ts";
import { httpReason } from "../../../src/output/format.ts";
import { isTransient, retryDelayMs } from "../../../src/client/retry.ts";
import { mockFetch, jsonResponse } from "../../helpers/fetch-mock.ts";

/** An SSE stream from `data:` payloads (objects are JSON-encoded). */
function sse(...events: (object | string)[]): ReadableStream<Uint8Array> {
  const text = events
    .map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`)
    .join("");
  return new Response(text).body as ReadableStream<Uint8Array>;
}

const sseResponse = (...events: (object | string)[]): Response =>
  new Response(sse(...events), { headers: { "content-type": "text/event-stream" } });

afterEach(() => applySettings({ VISE_LLM_PROVIDER: "local", VISE_LLM_RETRIES: "2" }));

test("an error sent mid-stream fails the call instead of passing for an empty reply", async () => {
  const result = await streamChat(
    sse(
      { choices: [{ delta: { content: "par" } }] },
      {
        error: { code: 502, message: "Provider disconnected unexpectedly" },
        choices: [{ delta: { content: "" }, finish_reason: "error" }],
      },
      "[DONE]",
    ),
  );
  expect(result.failure).toEqual({ status: 502, message: "Provider disconnected unexpectedly" });
});

test("what the call wrote is taken from usage when the provider sends no running count", async () => {
  const counted: number[] = [];
  await streamChat(
    sse(
      { choices: [{ delta: { content: "hello" } }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
    ),
    undefined,
    undefined,
    undefined,
    undefined,
    { text() {}, tokens: (n) => counted.push(n) },
  );
  expect(counted).toEqual([7]);
});

test("a busy provider is asked again, a bad request is not", () => {
  expect(isTransient({ kind: "http", status: 429, body: "" })).toBe(true);
  expect(isTransient({ kind: "http", status: 503, body: "" })).toBe(true);
  expect(isTransient({ kind: "http", status: 400, body: "" })).toBe(false);
  expect(isTransient({ kind: "network", cause: "x" })).toBe(false);
  expect([0, 1, 2, 5].map(retryDelayMs)).toEqual([1000, 3000, 9000, 10000]);
});

test("a 503 then a good reply is one successful chat; a 400 is reported at once", async () => {
  applySettings({ VISE_LLM_RETRIES: "1" });
  let calls = 0;
  const mock = mockFetch(() => {
    calls += 1;
    return calls === 1
      ? jsonResponse({ error: { message: "upstream busy" } }, 503)
      : sseResponse({ choices: [{ delta: { content: "ok" } }] }, "[DONE]");
  });
  try {
    const started = Date.now();
    const ok = await new LlmClient().chat([{ role: "user", content: "hi" }]);
    expect(ok.ok).toBe(true);
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  } finally {
    mock.restore();
  }
  calls = 0;
  const bad = mockFetch(() => {
    calls += 1;
    return jsonResponse({ error: { message: "bad model" } }, 400);
  });
  try {
    const failed = await new LlmClient().chat([{ role: "user", content: "hi" }]);
    expect(failed.ok).toBe(false);
    expect(calls).toBe(1);
  } finally {
    bad.restore();
  }
});

test("an error body is shown as its message, with what to do for the common statuses", () => {
  expect(httpReason(400, '{"error":{"message":"x/y is not a valid model ID","code":400},"user_id":"u"}')).toBe(
    "x/y is not a valid model ID",
  );
  expect(httpReason(401, '{"error":{"message":"No auth credentials found"}}')).toContain("API key");
  expect(httpReason(402, '{"error":"insufficient credits"}')).toContain("insufficient credits");
  expect(httpReason(500, "plain text body")).toBe("plain text body");
});
