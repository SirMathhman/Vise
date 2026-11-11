import { expect, test } from "bun:test";
import type { ProviderRequest } from "../core/messages.ts";
import { llamaCpp } from "./llama-cpp.ts";

// A llama.cpp stand-in on a free port. It answers only the right key, and serves one model.
function fakeLlama() {
  return Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.headers.get("authorization") !== "Bearer secret") {
        return new Response('{"error":"no key"}', { status: 401 });
      }
      if (path === "/props") return Response.json({ default_generation_settings: { n_ctx: 4096 } });
      if (path === "/v1/models") return Response.json({ data: [{ id: "tiny" }] });
      if (path === "/v1/chat/completions") {
        return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
          status: 200,
        });
      }
      return new Response("missing", { status: 404 });
    },
  });
}

function requestFor(model: string): ProviderRequest {
  return {
    model,
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    extraTools: [],
    reasoning: undefined,
    onUsage() {},
    onToolCall() {},
    onThinking() {},
    onReasoning() {},
  } as ProviderRequest;
}

test("lists the model the server runs with its context window, and streams a reply, with its key", async () => {
  const server = fakeLlama();
  try {
    const url = String(server.url).replace(/\/$/, "");
    const provider = llamaCpp({ name: "local", url, apiKey: "secret" });
    expect(await provider.listModels()).toEqual({ ok: true, value: [{ id: "tiny", contextLength: 4096 }] });
    expect(await provider.contextWindow("tiny")).toEqual({ ok: true, value: 4096 });
    const replies: string[] = [];
    for await (const part of provider.reply(requestFor("tiny"))) {
      if (part.ok) replies.push(part.value);
    }
    expect(replies.join("")).toBe("hi");
  } finally {
    server.stop();
  }
});

test("a wrong key is refused, and the error names the server, not the key", async () => {
  const server = fakeLlama();
  try {
    const url = String(server.url).replace(/\/$/, "");
    const result = await llamaCpp({ name: "local", url, apiKey: "wrong" }).listModels();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("local");
      expect(result.error.message).not.toContain("wrong");
    }
  } finally {
    server.stop();
  }
});
