import { afterEach, expect, test } from "bun:test";
import { applySettings } from "../../../packages/backend/src/config.ts";
import { describeSettings } from "../../../packages/backend/src/settings/settings-file.ts";
import { handleEnvChoices } from "../../../apps/web/src/api/settings-api.ts";
import { jsonResponse, mockFetch } from "../../helpers/fetch-mock.ts";

afterEach(() => applySettings({}));

test("the embedding model setting is described as a combobox over the local models", () => {
  const field = describeSettings().fields.find((f) => f.env === "VISE_EMBEDDING_MODEL");
  expect(field?.choices).toBe("local-models");
  expect(describeSettings().fields.find((f) => f.env === "VISE_LLM_URL")?.choices).toBeUndefined();
});

test("the choices are what llama.cpp lists, embedding models first and marked", async () => {
  const mock = mockFetch(() =>
    jsonResponse({
      data: [
        // The router starts every model with --embeddings: that alone says nothing.
        { id: "zeta/chat-model", status: { args: ["--embeddings", "--ctx-size", "8192"] } },
        { id: "vendor/pooled-model", status: { args: ["--embeddings", "--pooling", "mean"] } },
        { id: "alpha/chat-model", status: { args: ["--embeddings"] } },
        { id: "BAAI/bge-m3-GGUF" },
      ],
    }),
  );
  try {
    const [reply] = await handleEnvChoices({ type: "env_choices", source: "local-models" });
    expect(mock.calls[0]?.url).toContain("localhost:8080/v1/models");
    expect(reply).toEqual({
      type: "env_choices",
      source: "local-models",
      offers: [
        { value: "BAAI/bge-m3-GGUF", label: "BAAI/bge-m3-GGUF (embedding model)" },
        { value: "vendor/pooled-model", label: "vendor/pooled-model (embedding model)" },
        { value: "alpha/chat-model", label: "alpha/chat-model" },
        { value: "zeta/chat-model", label: "zeta/chat-model" },
      ],
    });
  } finally {
    mock.restore();
  }
});

test("a server that cannot be listed gives no suggestions and says why", async () => {
  const mock = mockFetch(() => jsonResponse({ error: { message: "unavailable" } }, 503));
  try {
    const [reply] = await handleEnvChoices({ type: "env_choices", source: "local-models" });
    expect(reply?.["offers"]).toEqual([]);
    expect(String(reply?.["error"])).toContain("503");
  } finally {
    mock.restore();
  }
  const [unknown] = await handleEnvChoices({ type: "env_choices", source: "nope" });
  expect(unknown?.["error"]).toBe("unknown source");
});

test("the list is always the local server's, whatever the chat provider is", async () => {
  applySettings({ VISE_LLM_PROVIDER: "local" });
  const mock = mockFetch(() => jsonResponse({ data: [{ id: "local/model" }] }));
  try {
    await handleEnvChoices({ type: "env_choices", source: "local-models" });
    expect(mock.calls[0]?.url).toContain("localhost:8080");
  } finally {
    mock.restore();
  }
});
