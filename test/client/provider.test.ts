import { describe, expect, test } from "bun:test";
import {
  modelInfo,
  providerFor,
  reasoningFields,
  responseFormat,
  type ProviderSettings,
} from "../../packages/backend/src/client/provider.ts";
import { streamChat } from "../../packages/backend/src/client/llm.ts";

const base: ProviderSettings = {
  llmProvider: "local",
  llmBaseUrl: "http://localhost:8080/",
  llmApiKey: "k1",
  llmModel: "m1",
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

  test("an unknown provider falls back to local", () => {
    expect(providerFor({ ...base, llmProvider: "x" }).id).toBe("local");
  });
});

describe("request shaping", () => {
  const local = providerFor(base);
  // A provider with none of the llama.cpp extras (what an OpenAI-compatible engine may look like).
  const hosted = {
    ...local,
    capabilities: { ...local.capabilities, flatReasoning: false, namedSchema: true },
  };

  test("reasoning effort field", () => {
    expect(reasoningFields(local, "high")).toEqual({ reasoning_effort: "high" });
    expect(reasoningFields(hosted, "high")).toEqual({
      reasoning: { effort: "high" },
    });
    expect(reasoningFields(hosted, "default")).toEqual({});
    expect(reasoningFields(hosted, undefined)).toEqual({});
  });

  test("response_format needs a name when the provider asks for one", () => {
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
  test("shows `reasoning` deltas as thinking", async () => {
    const sse = [
      ": PROCESSING",
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
