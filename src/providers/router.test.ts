import { expect, test } from "bun:test";
import { ok, type ProviderRequest, type Result } from "../core/messages.ts";
import type { ServerProvider } from "./llama-cpp.ts";
import { routed } from "./router.ts";

// A provider that records the model names it is asked for.
function recording(label: string, calls: string[]): ServerProvider {
  return {
    reply: (request) => {
      calls.push(`${label}:${request.model}`);
      return (async function* () {
        yield ok("x");
      })();
    },
    contextWindow: async (model) => {
      calls.push(`${label}.context:${model}`);
      return ok(100);
    },
    listModels: async () => ok([{ id: "m", contextLength: 100 }]),
  };
}

// Reads a reply to its end, so the provider has been called.
async function collect(stream: AsyncIterable<Result<string>>): Promise<Result<string>[]> {
  const parts: Result<string>[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

function requestFor(model: string): ProviderRequest {
  return { model, messages: [], tools: [], extraTools: [] } as unknown as ProviderRequest;
}

test("a model named for a provider goes to it with the bare name; a name no provider has is refused", async () => {
  const calls: string[] = [];
  const provider = routed([{ name: "local", provider: recording("local", calls) }], "local::tiny");
  await collect(provider.reply(requestFor("local::tiny")));
  const refused = await collect(provider.reply(requestFor("anthropic/claude")));
  expect(calls).toEqual(["local:tiny"]);
  expect(refused.length).toBe(1);
  expect(refused[0]?.ok).toBe(false);
  expect(provider.defaultModel).toBe("local::tiny");
});

test("the context window is asked of the provider that owns the model, and a name no provider has is refused", async () => {
  const calls: string[] = [];
  const provider = routed([{ name: "local", provider: recording("local", calls) }], "");
  expect(await provider.contextWindow("local::tiny")).toEqual(ok(100));
  expect(calls).toEqual(["local.context:tiny"]);
  expect((await provider.contextWindow("anthropic/claude")).ok).toBe(false);
});

test("the list has every provider's models, each named with its provider", async () => {
  const calls: string[] = [];
  const provider = routed([{ name: "local", provider: recording("local", calls) }], "");
  expect(await provider.listModels()).toEqual({ ok: true, value: [{ id: "local::m", contextLength: 100 }] });
});
