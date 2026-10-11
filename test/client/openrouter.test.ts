import { afterEach, expect, test } from "bun:test";
import { LlmClient } from "../../src/client/llm.ts";
import { applySettings } from "../../src/config.ts";
import type { Message } from "../../src/core/errors.ts";
import type { Tool } from "../../src/core/engine.ts";

type Call = { url: string; headers: Headers; body?: string };

function mockFetch(respond: (url: string) => Response): {
  calls: Call[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const replacement = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return respond(url);
  };
  Object.assign(replacement, { preconnect: original.preconnect.bind(original) });
  globalThis.fetch = replacement as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

afterEach(() => applySettings({}));

const tool: Tool = {
  name: "t",
  description: "d",
  parameters: { type: "object", properties: {} },
} as unknown as Tool;

test("openrouter requests carry no llama.cpp fields and use its url, key and headers", async () => {
  applySettings({
    VISE_LLM_PROVIDER: "openrouter",
    VISE_OPENROUTER_API_KEY: "sk-or",
    VISE_OPENROUTER_MODEL: "vendor/m",
  });
  const mock = mockFetch((url) =>
    url.endsWith("/models")
      ? json({ data: [{ id: "vendor/m", context_length: 128000, architecture: { input_modalities: ["text", "image"] } }] })
      : json({ choices: [{ message: { content: "ok" } }] }),
  );
  try {
    const client = new LlmClient();
    expect(client.getModel()).toBe("vendor/m");
    client.setReasoningEffort("high");
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const r = await client.chat(messages, [tool], undefined, undefined, undefined, undefined, undefined, undefined, true);
    expect(r.ok).toBeTrue();
    const chat = mock.calls.find((c) => c.url.includes("/chat/completions"))!;
    expect(chat.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(chat.headers.get("authorization")).toBe("Bearer sk-or");
    const body = JSON.parse(chat.body ?? "{}");
    expect(body.grammar).toBeUndefined();
    expect(body.id_slot).toBeUndefined();
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.reasoning_effort).toBeUndefined();
    expect((await client.contextMax())).toEqual({ ok: true, value: 128000 });
    expect(await client.supportsVision()).toBe(true);
    expect(mock.calls.some((c) => c.url.includes("/slots"))).toBeFalse();
  } finally {
    mock.restore();
  }
});
