import { expect, test } from "bun:test";
import { ok, type Provider, type ProviderRequest } from "../core/messages.ts";
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

function fallbackOf(calls: string[]): Provider {
  return { ...recording("openrouter", calls), defaultModel: "anthropic/claude" };
}

// Reads a reply to its end, so the provider has been called.
async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const part of stream) void part;
}

function requestFor(model: string): ProviderRequest {
  return { model, messages: [], tools: [], extraTools: [] } as unknown as ProviderRequest;
}

test("a model named for a server goes to that server with the bare name; any other goes to the fallback unchanged", async () => {
  const calls: string[] = [];
  const provider = routed([{ name: "local", provider: recording("local", calls) }], fallbackOf(calls));
  await drain(provider.reply(requestFor("local::tiny")));
  await drain(provider.reply(requestFor("anthropic/claude")));
  expect(calls).toEqual(["local:tiny", "openrouter:anthropic/claude"]);
  expect(provider.defaultModel).toBe("anthropic/claude");
});

test("the context window is asked of the server that owns the model", async () => {
  const calls: string[] = [];
  const provider = routed([{ name: "local", provider: recording("local", calls) }], fallbackOf(calls));
  expect(await provider.contextWindow("local::tiny")).toEqual(ok(100));
  expect(calls).toEqual(["local.context:tiny"]);
});

test("the list has every server's models named with their server, then the fallback's", async () => {
  const calls: string[] = [];
  const provider = routed([{ name: "local", provider: recording("local", calls) }], fallbackOf(calls));
  const listed = await provider.listModels();
  expect(listed).toEqual({
    ok: true,
    value: [
      { id: "local::m", contextLength: 100 },
      { id: "m", contextLength: 100 },
    ],
  });
});
