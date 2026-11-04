import { expect, test } from "bun:test";
import { streamChat } from "./openrouter.ts";

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
