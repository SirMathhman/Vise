import { describe, expect, test } from "bun:test";
import { LlmClient } from "../src/client/llm.ts";

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

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("llama.cpp subagent slot cache (edge)", () => {
  test("saves populated slots by nesting depth and restores them in reverse nesting order", async () => {
    const mock = mockFetch((url) => {
      if (url.includes("/slots?") && !url.includes("/slots/")) {
        return jsonResponse([
          { id: 0, n_prompt_tokens: 32, is_processing: false },
          { id: 1, n_prompt_tokens: 0, is_processing: false },
          { id: 2, n_prompt_tokens: 20, is_processing: true },
        ]);
      }
      if (url.includes("action=save")) return jsonResponse({ n_saved: 32 });
      if (url.includes("action=restore"))
        return jsonResponse({ n_restored: 32 });
      return jsonResponse({}, 404);
    });
    try {
      const client = new LlmClient();
      const nested = async () =>
        client.withPreservedSlotCache(async () => "nested");
      const result = await client.withPreservedSlotCache(async () => nested());
      expect(result).toBe("nested");

      const actions = mock.calls.filter((call) => call.url.includes("action="));
      expect(
        actions.map((call) => call.url.match(/action=(save|restore)/)?.[1]),
      ).toEqual(["save", "save", "restore", "restore"]);
      expect(
        actions.map((call) => JSON.parse(call.body ?? "{}").filename),
      ).toEqual([
        `vise-${process.pid}-subagent-0-slot-0.bin`,
        `vise-${process.pid}-subagent-1-slot-0.bin`,
        `vise-${process.pid}-subagent-1-slot-0.bin`,
        `vise-${process.pid}-subagent-0-slot-0.bin`,
      ]);
      expect(
        actions.every((call) => JSON.parse(call.body ?? "{}").model),
      ).toBeTrue();
      expect(
        mock.calls
          .filter((call) => call.url.includes("/slots?"))
          .every(
            (call) =>
              call.url.includes("model=") &&
              call.url.includes("include_slots=true"),
          ),
      ).toBeTrue();
    } finally {
      mock.restore();
    }
  });

  test("runs the subagent operation if slot snapshots are unavailable", async () => {
    const mock = mockFetch(() =>
      jsonResponse({ error: "slot saving disabled" }, 501),
    );
    try {
      const client = new LlmClient();
      let ran = false;
      const result = await client.withPreservedSlotCache(async () => {
        ran = true;
        return "completed";
      });
      expect(ran).toBeTrue();
      expect(result).toBe("completed");
      expect(mock.calls).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  test("does not block subagent execution when the slot endpoint hangs", async () => {
    const mock = mockFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    try {
      const client = new LlmClient(5);
      let ran = false;
      const result = await client.withPreservedSlotCache(async () => {
        ran = true;
        return "completed";
      });
      expect(ran).toBeTrue();
      expect(result).toBe("completed");
      expect(mock.calls).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  test("does not block subagent completion when slot restoration hangs", async () => {
    const mock = mockFetch((url, init) => {
      if (url.includes("/slots?") && !url.includes("/slots/")) {
        return jsonResponse([
          { id: 0, n_prompt_tokens: 32, is_processing: false },
        ]);
      }
      if (url.includes("action=save")) return jsonResponse({ n_saved: 32 });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    });
    try {
      const client = new LlmClient(5);
      const result = await client.withPreservedSlotCache(
        async () => "completed",
      );
      expect(result).toBe("completed");
      expect(
        mock.calls.some((call) => call.url.includes("action=restore")),
      ).toBeTrue();
    } finally {
      mock.restore();
    }
  });
});
