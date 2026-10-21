import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LlmClient } from "../../packages/backend/src/client/llm.ts";
import { detectBackend, providerFor } from "../../packages/backend/src/client/provider.ts";
import { applySettings } from "../../packages/backend/src/config.ts";
import { jsonResponse, mockFetch } from "../helpers/fetch-mock.ts";
import { streamChat } from "../../packages/backend/src/client/stream/stream-reader.ts";
import type { PromptProgress } from "@vise/core";

const settings = (url: string) => ({
  llmProvider: "local",
  llmBaseUrl: url,
  llmApiKey: "",
  llmModel: "m",
});

beforeEach(() => {
  process.env.VISE_BACKEND_DETECT = "1";
});
afterEach(() => {
  process.env.VISE_BACKEND_DETECT = "0";
  applySettings({});
});

const sse = (...events: (object | string)[]): Response =>
  new Response(
    events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
const say = (content: string): Response => sse({ choices: [{ delta: { content } }] }, "[DONE]");

const CALL = '<tool_call>\n{"name":"add","arguments":{"a":1,"b":2}}\n</tool_call>';
const BROKEN = '<tool_call>\n{"name":"add","arguments":{"a":1,'; // cut off: nothing to read
const tools = [
  {
    type: "function" as const,
    function: { name: "add", description: "", parameters: { type: "object" } },
  },
];

describe("backend detection", () => {
  test("a server that says it is Strata gets Strata's capabilities", async () => {
    const mock = mockFetch(() => jsonResponse({ service: "strata", model: "q" }));
    try {
      await detectBackend("http://strata.test:1/");
      const p = providerFor(settings("http://strata.test:1"));
      expect(p.backend).toBe("strata");
      expect(p.capabilities.grammar).toBe(false);
      expect(p.capabilities.slots).toBe(false);
      expect(p.capabilities.namedSchema).toBe(true);
      await detectBackend("http://strata.test:1");
      expect(mock.calls.map((c) => c.url)).toEqual(["http://strata.test:1/v1/status"]);
    } finally {
      mock.restore();
    }
  });

  test("a Strata build that constrains decoding to a grammar gets the grammar capability", async () => {
    const mock = mockFetch(() =>
      jsonResponse({ service: "strata", model: "q", grammar: { constrained_decoding: true } }),
    );
    try {
      await detectBackend("http://strata-grammar.test:1");
      const p = providerFor(settings("http://strata-grammar.test:1"));
      expect(p.backend).toBe("strata");
      expect(p.capabilities.grammar).toBe(true);
      expect(p.capabilities.schemaDecoding).toBe(false);
    } finally {
      mock.restore();
    }
  });

  test("anything else is llama.cpp, and an unreachable server is asked again next time", async () => {
    const other = mockFetch(() => new Response("not found", { status: 404 }));
    try {
      await detectBackend("http://llama.test:1");
      expect(providerFor(settings("http://llama.test:1")).capabilities.grammar).toBe(true);
    } finally {
      other.restore();
    }
    let n = 0;
    const down = mockFetch(() => {
      n++;
      throw new Error("connection refused");
    });
    try {
      await detectBackend("http://down.test:1");
      await detectBackend("http://down.test:1");
      expect(n).toBe(2);
      expect(providerFor(settings("http://down.test:1")).backend).toBe("llama.cpp");
    } finally {
      down.restore();
    }
  });
});

describe("a tool call written badly (no grammar to prevent it)", () => {
  const chatOn = async (url: string, replies: string[]) => {
    applySettings({ VISE_LLM_URL: url, VISE_LLM_RETRIES: "0" });
    let n = 0;
    const mock = mockFetch((u) => {
      if (u.endsWith("/v1/status")) return jsonResponse({ service: "strata" });
      return say(replies[Math.min(n++, replies.length - 1)] ?? "");
    });
    const shown: string[] = [];
    try {
      const result = await new LlmClient().chat(
        [{ role: "user", content: "add 1 and 2" }],
        tools,
        (t) => shown.push(t),
      );
      return {
        result,
        shown: shown.join(""),
        requests: mock.calls.filter((c) => c.url.endsWith("/chat/completions")).length,
      };
    } finally {
      mock.restore();
    }
  };

  test("is asked again once, and the second reply's call is used", async () => {
    let n = 0;
    applySettings({ VISE_LLM_URL: "http://s1.test:1", VISE_LLM_RETRIES: "0" });
    const mock = mockFetch((u) => {
      if (u.endsWith("/v1/status")) return jsonResponse({ service: "strata" });
      return say(n++ === 0 ? BROKEN : CALL);
    });
    const shown: string[] = [];
    try {
      const r = await new LlmClient().chat([{ role: "user", content: "add" }], tools, (t) =>
        shown.push(t),
      );
      if (!r.ok) throw new Error("expected ok");
      expect(r.value.tool_calls?.[0]?.function.name).toBe("add");
      expect(mock.calls.filter((c) => c.url.endsWith("/chat/completions"))).toHaveLength(2);
      expect(shown.join("")).toContain("asking again");
    } finally {
      mock.restore();
    }
  });

  test("is asked again only once, then handed back with a warning", async () => {
    const { result, shown, requests } = await chatOn("http://s2.test:1", [BROKEN]);
    expect(requests).toBe(2);
    expect(result.ok).toBe(true);
    expect(shown).toContain("could not be read either");
  });

  test("a good call is not asked again", async () => {
    const { result, requests } = await chatOn("http://s3.test:1", [CALL]);
    expect(requests).toBe(1);
    expect(result.ok && result.value.tool_calls?.length).toBe(1);
  });

  test("llama.cpp (grammar on) is never asked again", async () => {
    applySettings({ VISE_LLM_URL: "http://l1.test:1", VISE_LLM_RETRIES: "0" });
    const mock = mockFetch((u) =>
      u.endsWith("/v1/status") ? new Response("no", { status: 404 }) : say(BROKEN),
    );
    try {
      await new LlmClient().chat([{ role: "user", content: "add" }], tools);
      expect(mock.calls.filter((c) => c.url.endsWith("/chat/completions"))).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });
});

describe("what Strata does not do", () => {
  const SCHEMA = { type: "object", properties: { verdict: { enum: ["yes", "no"] } } };

  test("a schema goes at the end of the question, not in response_format, and the JSON is taken out of the reply", async () => {
    applySettings({ VISE_LLM_URL: "http://sch.test:1", VISE_LLM_RETRIES: "0" });
    const mock = mockFetch((u) =>
      u.endsWith("/v1/status")
        ? jsonResponse({ service: "strata", model: "q" })
        : say('```json\n{"verdict":"yes"}\n```'),
    );
    try {
      const messages = [
        { role: "user" as const, content: "do it" },
        { role: "user" as const, content: "[goal check] done?" },
      ];
      const r = await new LlmClient().chat(
        messages,
        tools,
        undefined,
        undefined,
        undefined,
        SCHEMA,
      );
      if (!r.ok) throw new Error("expected ok");
      expect(r.value.content).toBe('{"verdict":"yes"}');
      const sent = mock.calls.find((c) => c.url.endsWith("/chat/completions"));
      const body = JSON.parse(sent?.body ?? "{}") as {
        response_format?: unknown;
        messages: { content: string }[];
      };
      expect(body.response_format).toBeUndefined();
      const last = body.messages[body.messages.length - 1]?.content ?? "";
      expect(last.startsWith("[goal check] done?")).toBe(true);
      expect(last).toContain(JSON.stringify(SCHEMA));
      // The conversation before the question is untouched, so the server's cache still covers it.
      expect(body.messages.some((m) => m.content === "do it")).toBe(true);
      expect(messages[1]?.content).toBe("[goal check] done?");
    } finally {
      mock.restore();
    }
  });

  test("the default model is the one Strata serves, until the user picks another", async () => {
    applySettings({ VISE_LLM_URL: "http://served.test:1", VISE_LLM_MODEL: "router/model" });
    const mock = mockFetch(() => jsonResponse({ service: "strata", model: "served-q" }));
    try {
      await detectBackend("http://served.test:1");
      const client = new LlmClient();
      expect(client.getModel()).toBe("served-q");
      client.setModel("other");
      expect(client.getModel()).toBe("other");
    } finally {
      mock.restore();
    }
  });

  test("embeddings are refused with the reason, without a request", async () => {
    applySettings({ VISE_LLM_URL: "http://emb.test:1" });
    const mock = mockFetch(() => jsonResponse({ service: "strata", model: "q" }));
    try {
      const r = await new LlmClient().embedMany(["a"]);
      expect(r.ok).toBe(false);
      if (!r.ok && r.error.kind === "malformed")
        expect(r.error.body).toContain("no embeddings endpoint");
      expect(mock.calls.some((c) => c.url.endsWith("/embeddings"))).toBe(false);
    } finally {
      mock.restore();
    }
  });
});

test("prompt progress that stops short of the total (Strata) is finished once the call writes", async () => {
  const res = sse(
    {
      choices: [{ delta: {} }],
      prompt_progress: { total: 20000, cache: 0, processed: 8192, time_ms: 2700 },
    },
    {
      choices: [{ delta: {} }],
      prompt_progress: { total: 20000, cache: 0, processed: 16384, time_ms: 5300 },
    },
    { choices: [{ delta: { reasoning_content: "hm" } }] },
    { choices: [{ delta: { content: "ok" } }] },
    "[DONE]",
  );
  const seen: PromptProgress[] = [];
  await streamChat(res.body!, undefined, undefined, (p) => seen.push(p));
  expect(seen.map((p) => p.processed)).toEqual([8192, 16384, 20000]);
  expect(seen[2]?.time_ms).toBeGreaterThanOrEqual(5300);
});
