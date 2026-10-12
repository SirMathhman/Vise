import { afterEach, expect, test } from "bun:test";
import { fetchEmbeddings } from "../../packages/backend/src/client/model-queries.ts";
import { LlmClient } from "../../packages/backend/src/client/llm.ts";
import { providerOf } from "../../packages/backend/src/client/provider.ts";
import { applySettings, config } from "../../packages/backend/src/config.ts";
import { jsonResponse, mockFetch } from "../helpers/fetch-mock.ts";

afterEach(() => applySettings({}));

test("a batch comes back in input order whatever order the server answers in", async () => {
  const mock = mockFetch(() =>
    jsonResponse({ data: [{ index: 1, embedding: [2, 2] }, { index: 0, embedding: [1, 1] }] }),
  );
  try {
    const result = await fetchEmbeddings(providerOf(config, "local"), "m", ["a", "b"]);
    expect(result).toEqual({ ok: true, value: [[1, 1], [2, 2]] });
    expect(JSON.parse(mock.calls[0]?.body ?? "{}")).toEqual({ model: "m", input: ["a", "b"] });
  } finally {
    mock.restore();
  }
});

test("a server that answers the wrong number of vectors, or an error, is a failure", async () => {
  const short = mockFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1] }] }));
  try {
    const r = await fetchEmbeddings(providerOf(config, "local"), "m", ["a", "b"]);
    expect(r.ok).toBe(false);
  } finally {
    short.restore();
  }
  const refused = mockFetch(() => jsonResponse({ error: { message: "embeddings not supported" } }, 501));
  try {
    const r = await fetchEmbeddings(providerOf(config, "local"), "m", ["a"]);
    expect(r.ok).toBe(false);
  } finally {
    refused.restore();
  }
});

test("embeddings go to the local server whatever the chat provider setting is", async () => {
  applySettings({ VISE_LLM_PROVIDER: "local", VISE_EMBEDDING_MODEL: "embedder" });
  const mock = mockFetch(() => jsonResponse({ data: [{ index: 0, embedding: [1, 2, 3] }] }));
  try {
    const result = await new LlmClient().embedMany(["hello"]);
    expect(result.ok).toBe(true);
    expect(mock.calls[0]?.url).toContain("localhost:8080");
    expect(JSON.parse(mock.calls[0]?.body ?? "{}").model).toBe("embedder");
  } finally {
    mock.restore();
  }
});
