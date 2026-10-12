import { afterEach, expect, test } from "bun:test";
import { LlmClient } from "../../src/client/llm.ts";
import { applySettings } from "../../src/config.ts";
import { modelRef, parseModelRef } from "../../src/client/provider.ts";

type Call = { url: string; body?: string };

function mockFetch(respond: (url: string) => Response): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  const replacement = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
    return respond(url);
  };
  Object.assign(replacement, { preconnect: original.preconnect.bind(original) });
  globalThis.fetch = replacement as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

const json = (v: unknown): Response => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

afterEach(() => applySettings({}));

test("a model reference names its provider and round-trips", () => {
  expect(parseModelRef(modelRef("local", "qwen/x.gguf"))).toEqual({ provider: "local", model: "qwen/x.gguf" });
  expect(parseModelRef(modelRef("openrouter", "anthropic/claude"))).toEqual({ provider: "openrouter", model: "anthropic/claude" });
  expect(modelRef("local", "a/b")).toBe("a/b");
});

test("both providers' models are listed together, and a switch routes each call to its own provider", async () => {
  applySettings({
    VISE_LLM_PROVIDER: "local",
    VISE_OPENROUTER_API_KEY: "sk-or",
    VISE_LLM_URL: "http://local.test",
  });
  const mock = mockFetch((url) => {
    if (url === "http://local.test/v1/models") return json({ data: [{ id: "local-one" }] });
    if (url.endsWith("/models")) return json({ data: [{ id: "vendor/m", name: "Vendor M" }] });
    return json({ choices: [{ message: { content: "ok" } }] });
  });
  try {
    const client = new LlmClient();
    const listed = await client.listModelDetails();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.map((m) => [m.id, m.provider])).toEqual([
        ["local-one", "local"],
        ["openrouter:vendor/m", "openrouter"],
      ]);
    }
    expect(client.supportsGrammar()).toBe(true);

    client.setModel("openrouter:vendor/m");
    expect(client.supportsGrammar()).toBe(false);
    await client.chat([{ role: "user", content: "hi" }]);
    const chat = mock.calls.find((c) => c.url.endsWith("/chat/completions"));
    expect(chat?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(chat?.body ?? "{}").model).toBe("vendor/m");
  } finally {
    mock.restore();
  }
});

test("hosted models are listed only when a key is set", async () => {
  applySettings({ VISE_LLM_PROVIDER: "local", VISE_LLM_URL: "http://local.test" });
  const mock = mockFetch(() => json({ data: [{ id: "local-one" }] }));
  try {
    const listed = await new LlmClient().listModelDetails();
    expect(listed.ok && listed.value.map((m) => m.provider)).toEqual(["local"]);
    expect(mock.calls.some((c) => c.url.includes("openrouter"))).toBe(false);
  } finally {
    mock.restore();
  }
});
