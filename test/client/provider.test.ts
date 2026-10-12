import { describe, expect, test } from "bun:test";
import {
  modelInfo,
  providerFor,
  reasoningFields,
  responseFormat,
  type ProviderSettings,
} from "../../src/client/provider.ts";
import { streamChat } from "../../src/client/llm.ts";

const base: ProviderSettings = {
  llmProvider: "local",
  llmBaseUrl: "http://localhost:8080/",
  llmApiKey: "k1",
  llmModel: "m1",
  openrouterUrl: "https://openrouter.ai/api/v1/",
  openrouterApiKey: "k2",
  openrouterModel: "vendor/m2",
};

describe("providerFor", () => {
  test("local adds /v1 and keeps llama.cpp features", () => {
    const p = providerFor(base);
    expect(p.chatUrl).toBe("http://localhost:8080/v1/chat/completions");
    expect(p.modelsUrl).toBe("http://localhost:8080/v1/models");
    expect(p.rootUrl).toBe("http://localhost:8080");
    expect(p.headers.authorization).toBe("Bearer k1");
    expect(p.capabilities.grammar).toBe(true);
    expect(p.capabilities.slots).toBe(true);
    expect(p.defaultModel).toBe("m1");
  });

  test("openrouter uses its own url, key and model, no slots", () => {
    const p = providerFor({ ...base, llmProvider: "openrouter" });
    expect(p.chatUrl).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(p.modelsUrl).toBe("https://openrouter.ai/api/v1/models");
    expect(p.rootUrl).toBeUndefined();
    expect(p.headers.authorization).toBe("Bearer k2");
    expect(p.headers["x-title"]).toBe("Vise");
    expect(p.capabilities.grammar).toBe(false);
    expect(p.capabilities.namedSchema).toBe(true);
    expect(p.defaultModel).toBe("vendor/m2");
  });

  test("an unknown provider falls back to local", () => {
    expect(providerFor({ ...base, llmProvider: "x" }).id).toBe("local");
  });
});

describe("request shaping", () => {
  const local = providerFor(base);
  const hosted = providerFor({ ...base, llmProvider: "openrouter" });

  test("reasoning effort field", () => {
    expect(reasoningFields(local, "high")).toEqual({ reasoning_effort: "high" });
    expect(reasoningFields(hosted, "high")).toEqual({
      reasoning: { effort: "high" },
    });
    expect(reasoningFields(hosted, "default")).toEqual({});
    expect(reasoningFields(hosted, undefined)).toEqual({});
  });

  test("response_format needs a name on openrouter", () => {
    const schema = { type: "object" };
    expect(responseFormat(local, schema)).toEqual({
      type: "json_schema",
      json_schema: { schema },
    });
    expect(responseFormat(hosted, schema)).toEqual({
      type: "json_schema",
      json_schema: { name: "vise", strict: true, schema },
    });
  });
});

describe("modelInfo", () => {
  const body = {
    data: [
      {
        id: "a/b",
        context_length: 200000,
        architecture: { input_modalities: ["text", "image"] },
      },
      { id: "c/d" },
    ],
  };
  test("reads window and vision", () => {
    expect(modelInfo(body, "a/b")).toEqual({
      contextLength: 200000,
      vision: true,
    });
    expect(modelInfo(body, "c/d")).toEqual({
      contextLength: undefined,
      vision: false,
    });
    expect(modelInfo(body, "nope")).toBeUndefined();
    expect(modelInfo(null, "a/b")).toBeUndefined();
  });
});

describe("stream reader", () => {
  test("shows OpenRouter's `reasoning` deltas as thinking", async () => {
    const sse = [
      ': OPENROUTER PROCESSING',
      'data: {"choices":[{"delta":{"reasoning":"hmm"}}]}',
      'data: {"choices":[{"delta":{"content":"hi"}}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const stream = new Response(sse).body!;
    const thinking: string[] = [];
    const out = await streamChat(stream, undefined, (t) => thinking.push(t));
    expect(thinking).toEqual(["hmm"]);
    expect(out.message.content).toBe("hi");
  });
});
