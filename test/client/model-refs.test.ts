import { afterEach, expect, test } from "bun:test";
import { mockFetch } from "../helpers/fetch-mock.ts";
import { LlmClient } from "../../packages/backend/src/client/llm.ts";
import { applySettings } from "../../packages/backend/src/config.ts";
import { modelRef, parseModelRef } from "../../packages/backend/src/client/provider.ts";

const json = (v: unknown): Response => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

afterEach(() => applySettings({}));

test("a model reference round-trips, and a stale prefixed one never selects a remote provider", () => {
  expect(parseModelRef(modelRef("local", "qwen/x.gguf"))).toEqual({ provider: "local", model: "qwen/x.gguf" });
  expect(modelRef("local", "a/b")).toBe("a/b");
  expect(parseModelRef("openrouter:vendor/m").provider).toBe("local");
});

test("models are listed from the local server only, and every call goes there", async () => {
  applySettings({ VISE_LLM_PROVIDER: "openrouter", VISE_LLM_URL: "http://local.test" });
  const mock = mockFetch((url) => {
    if (url === "http://local.test/v1/models") return json({ data: [{ id: "local-one" }] });
    return json({ choices: [{ message: { content: "ok" } }] });
  });
  try {
    const client = new LlmClient();
    const listed = await client.listModelDetails();
    expect(listed.ok && listed.value.map((m) => [m.id, m.provider])).toEqual([["local-one", "local"]]);
    client.setModel("openrouter:vendor/m");
    await client.chat([{ role: "user", content: "hi" }]);
    expect(mock.calls.every((c) => c.url.startsWith("http://local.test"))).toBe(true);
  } finally {
    mock.restore();
  }
});
