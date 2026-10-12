import { describe, expect, test } from "bun:test";
import { mockFetch, type FetchCall } from "../helpers/fetch-mock.ts";
import { LlmClient } from "../../packages/backend/src/client/llm.ts";
import type { Message, PromptProgress } from "@vise/core";
import { loadSettingsFile } from "../../packages/backend/src/settings/settings-file.ts";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const isSlotList = (url: string): boolean =>
  url.includes("/slots?") && !url.includes("/slots/");
const isChat = (call: FetchCall): boolean => call.url.includes("/chat/");
const chatReply = (): Response =>
  jsonResponse({ choices: [{ message: { content: "ok" } }] });

/** A non-streamed, tool-less model call (the simplest request the client makes). */
async function ask(client: LlmClient): Promise<void> {
  const messages: Message[] = [{ role: "user", content: "hi" }];
  const result = await client.chat(
    messages, undefined, undefined, undefined, undefined, undefined, undefined, undefined, true,
  );
  expect(result.ok).toBeTrue();
}

/** The `id_slot` each chat request asked for (undefined: let the server choose). */
const pinned = (calls: FetchCall[]): (number | undefined)[] =>
  calls.filter(isChat).map((c) => JSON.parse(c.body ?? "{}").id_slot);

describe("llama.cpp side slot (edge)", () => {
  test("side work is pinned to the least recently used slot other than the main one", async () => {
    const mock = mockFetch((url) =>
      isSlotList(url)
        ? jsonResponse([
            { id: 0, n_ctx: 100, id_task: 50 },
            { id: 1, n_ctx: 100, id_task: 90 }, // used last: the main conversation
            { id: 2, n_ctx: 100, id_task: 10 },
          ])
        : chatReply(),
    );
    try {
      const client = new LlmClient();
      await ask(client);
      await client.withSideSlot(() => ask(client));
      await ask(client);
      expect(pinned(mock.calls)).toEqual([undefined, 2, undefined]);
      // Nothing is saved to or restored from a file.
      expect(mock.calls.some((c) => c.url.includes("action="))).toBeFalse();
      expect(mock.calls.some((c) => c.method === "POST" && !isChat(c))).toBeFalse();
    } finally {
      mock.restore();
    }
  });

  test("nested side work shares the slot, reads the slots once, and the pin ends even when the work throws", async () => {
    const mock = mockFetch((url) =>
      isSlotList(url)
        ? jsonResponse([
            { id: 0, n_ctx: 100, id_task: 5 },
            { id: 1, n_ctx: 100, id_task: 9 },
          ])
        : chatReply(),
    );
    try {
      const client = new LlmClient();
      await expect(
        client.withSideSlot(async () => {
          await client.withSideSlot(() => ask(client));
          await ask(client);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      await ask(client);
      expect(pinned(mock.calls)).toEqual([0, 0, undefined]);
      expect(mock.calls.filter((c) => isSlotList(c.url))).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

  test("side work avoids the slot a tool-calling reply ran on, even when another call ran after it", async () => {
    // Slot 0 ran the reply (task 7); a later call went to slot 1 (task 9), the slot used last.
    const call = `<tool_call>{"name":"run_subagent","arguments":{}}</tool_call>`;
    const mock = mockFetch((url) =>
      isSlotList(url)
        ? jsonResponse([
            { id: 0, n_ctx: 100, id_task: 9 },
            { id: 1, n_ctx: 100, id_task: 5 },
          ])
        : jsonResponse({ choices: [{ message: { content: call } }] }),
    );
    try {
      const client = new LlmClient();
      const tools = [{ type: "function" as const, function: { name: "run_subagent", description: "d", parameters: { type: "object", properties: {} } } }];
      const reply = await client.chat(
        [{ role: "user", content: "hi" }], tools, undefined, undefined, undefined, undefined, undefined, undefined, true,
      );
      expect(reply.ok).toBeTrue();
      // The reply's slot (0, the highest task then) is remembered; now slot 1 looks used last.
      mock.restore();
      const after = mockFetch((url) =>
        isSlotList(url)
          ? jsonResponse([
              { id: 0, n_ctx: 100, id_task: 7 },
              { id: 1, n_ctx: 100, id_task: 12 },
            ])
          : chatReply(),
      );
      try {
        await client.withSideSlot(() => ask(client));
        expect(pinned(after.calls)).toEqual([1]);
      } finally {
        after.restore();
      }
    } finally {
      mock.restore();
    }
  });

  test("with a single slot the work runs unpinned, leaving the server's prompt cache to keep the main context", async () => {
    const mock = mockFetch((url) =>
      isSlotList(url) ? jsonResponse([{ id: 0, n_ctx: 100, id_task: 3 }]) : chatReply(),
    );
    try {
      const client = new LlmClient();
      await client.withSideSlot(() => ask(client));
      expect(pinned(mock.calls)).toEqual([undefined]);
      expect(mock.calls.some((c) => c.method === "POST" && !isChat(c))).toBeFalse();
    } finally {
      mock.restore();
    }
  });

  test("runs unpinned when the slots are unavailable, unreadable or do not say which was used last", async () => {
    for (const slots of [
      () => jsonResponse({ error: "slots disabled" }, 501),
      () => jsonResponse({ not: "a list" }),
      () => jsonResponse([{ id: 0, n_ctx: 1 }, { id: 1, n_ctx: 1 }]),
    ]) {
      const mock = mockFetch((url) => (isSlotList(url) ? slots() : chatReply()));
      try {
        const client = new LlmClient();
        await client.withSideSlot(() => ask(client));
        expect(pinned(mock.calls)).toEqual([undefined]);
      } finally {
        mock.restore();
      }
    }
  });

  test("does not block the work when the slot endpoint hangs", async () => {
    const mock = mockFetch((url, init) =>
      isSlotList(url)
        ? new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          })
        : chatReply(),
    );
    try {
      const client = new LlmClient(5);
      await client.withSideSlot(() => ask(client));
      expect(pinned(mock.calls)).toEqual([undefined]);
    } finally {
      mock.restore();
    }
  });
});

/** ~20k tokens of text unique to `seed`. */
const longText = (seed: string): string =>
  Array.from(
    { length: 400 },
    (_, i) => `${seed} entry ${i}: the quick brown fox ${seed}-${(i * 7919) % 10007} jumps over lazy dog number ${i}.`,
  ).join("\n");

/** Send `text` and stop as soon as the model starts answering; resolves to how much of the prompt was read from the cache. */
async function prefill(
  client: LlmClient,
  text: string,
): Promise<{ total: number; cached: number }> {
  const stop = new AbortController();
  let last: PromptProgress | undefined;
  await client.chat(
    [{ role: "user", content: text }],
    undefined,
    () => stop.abort(),
    () => stop.abort(),
    (p) => (last = p),
    undefined,
    stop.signal,
  );
  return { total: last?.total ?? 0, cached: last?.cache ?? 0 };
}

// Needs the real llama.cpp server (2+ slots) and is slow: VISE_LIVE_KV=1 bun test test/client/slot-cache.test.ts
describe("live KV cache across side work", () => {
  test.skipIf(!process.env["VISE_LIVE_KV"])(
    "a long context asked again after unrelated side work is mostly read from the cache",
    async () => {
      loadSettingsFile();
      const client = new LlmClient();
      const stamp = Date.now();
      const main = longText(`main${stamp}`);
      expect((await prefill(client, main)).total).toBeGreaterThan(10_000);

      await client.withSideSlot(async () => {
        for (const name of ["one", "two", "three"]) {
          await prefill(client, longText(`${name}${stamp}`));
        }
      });

      const again = await prefill(client, `${main}\nOne more line.`);
      const read = again.total - again.cached;
      // Low prompt processing: a small fraction of the context, not all of it.
      expect(read).toBeLessThan(again.total * 0.2);
    },
    600_000,
  );
});
