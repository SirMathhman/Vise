import { describe, expect, test } from "bun:test";
import { LlmClient, REASONING_EFFORTS } from "../../src/client/llm.ts";
import { handleReasoningCommand } from "../../src/repl/commands/commands.ts";
import type { ReasoningController } from "../../src/repl/session.ts";

type FetchCall = { url: string; method: string; body?: string };

function mockFetch(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  const replacement = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    return respond(url, init);
  };
  Object.assign(replacement, {
    preconnect: original.preconnect.bind(original),
  });
  globalThis.fetch = replacement as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Build a minimal SSE stream response that `LlmClient.chat` will parse. */
function sseResponse(): Response {
  const encoder = new TextEncoder();
  const chunks = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":7}}\n\n',
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("LlmClient reasoning_effort body emission", () => {
  test("omits reasoning_effort when unset", async () => {
    const { calls, restore } = mockFetch(() => sseResponse());
    const client = new LlmClient();
    await client.chat([{ role: "user", content: "hello" }]);
    restore();

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeUndefined();
  });

  test("omits reasoning_effort when set to 'default'", async () => {
    const { calls, restore } = mockFetch(() => sseResponse());
    const client = new LlmClient();
    client.setReasoningEffort("default");
    await client.chat([{ role: "user", content: "hello" }]);
    restore();

    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(body.reasoning_effort).toBeUndefined();
  });

  test("emits reasoning_effort for a non-default level", async () => {
    const { calls, restore } = mockFetch(() => sseResponse());
    const client = new LlmClient();
    client.setReasoningEffort("high");
    await client.chat([{ role: "user", content: "hello" }]);
    restore();

    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("high");
  });

  test("emits reasoning_effort for 'none' (disables reasoning)", async () => {
    const { calls, restore } = mockFetch(() => sseResponse());
    const client = new LlmClient();
    client.setReasoningEffort("none");
    await client.chat([{ role: "user", content: "hello" }]);
    restore();

    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    expect(body.reasoning_effort).toBe("none");
  });

  test("clears the field after setReasoningEffort(undefined)", async () => {
    const { calls, restore } = mockFetch(() => sseResponse());
    const client = new LlmClient();
    client.setReasoningEffort("high");
    await client.chat([{ role: "user", content: "hello" }]);
    client.setReasoningEffort(undefined);
    await client.chat([{ role: "user", content: "hello" }]);
    restore();

    const second = JSON.parse(calls[1]!.body!) as Record<string, unknown>;
    expect(second.reasoning_effort).toBeUndefined();
  });
});

describe("REASONING_EFFORTS constant", () => {
  test("contains exactly the 8 known levels", () => {
    expect(REASONING_EFFORTS).toEqual([
      "default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });
});

describe("handleReasoningCommand", () => {
  function makeController(initial: string | undefined = undefined) {
    let value: string | undefined = initial;
    return {
      getReasoningEffort: () => value,
      setReasoningEffort: (v: string | undefined) => {
        value = v;
      },
      getValue: () => value,
    };
  }

  test("lists available levels with active marker", () => {
    const controller = makeController("high");
    const result = handleReasoningCommand(
      controller as unknown as ReasoningController,
      "/reasoning",
    );
    expect(result.ok).toBeTrue();
    if (result.ok) {
      const lines = result.value.split("\n");
      expect(lines).toHaveLength(8);
      expect(lines[5]).toBe("* high (active)");
      expect(lines[0]).toBe("  default");
    }
  });

  test("lists with 'default' active when nothing is set", () => {
    const controller = makeController(undefined);
    const result = handleReasoningCommand(
      controller as unknown as ReasoningController,
      "/reasoning",
    );
    expect(result.ok).toBeTrue();
    if (result.ok) {
      const lines = result.value.split("\n");
      expect(lines[0]).toBe("* default (active)");
    }
  });

  test("sets a valid level", () => {
    const controller = makeController();
    const result = handleReasoningCommand(
      controller as unknown as ReasoningController,
      "/reasoning low",
    );
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.value).toBe("reasoning effort set to low");
    }
    expect(controller.getValue()).toBe("low");
  });

  test("sets 'default' which clears the field", () => {
    const controller = makeController("high");
    const result = handleReasoningCommand(
      controller as unknown as ReasoningController,
      "/reasoning default",
    );
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.value).toBe(
        "reasoning effort set to default (template default)",
      );
    }
    expect(controller.getValue()).toBeUndefined();
  });

  test("rejects an unknown level with a helpful error", () => {
    const controller = makeController();
    const result = handleReasoningCommand(
      controller as unknown as ReasoningController,
      "/reasoning extreme",
    );
    expect(result.ok).toBeFalse();
    if (!result.ok && result.error.kind === "malformed") {
      expect(result.error.body).toContain("unknown reasoning effort 'extreme'");
    }
    expect(controller.getValue()).toBeUndefined();
  });

  test("is case-insensitive", () => {
    const controller = makeController();
    const result = handleReasoningCommand(
      controller as unknown as ReasoningController,
      "/reasoning HIGH",
    );
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.value).toBe("reasoning effort set to high");
    }
    expect(controller.getValue()).toBe("high");
  });

  test("errors when no controller is provided", () => {
    const result = handleReasoningCommand(undefined, "/reasoning");
    expect(result.ok).toBeFalse();
    if (!result.ok && result.error.kind === "malformed") {
      expect(result.error.body).toContain("not supported");
    }
  });
});
