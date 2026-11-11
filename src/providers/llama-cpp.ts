import { z } from "zod";
import { err, ok, type ModelInfo, type Provider, type Result } from "../core/messages.ts";
import { streamChat } from "./openrouter.ts";

// One llama.cpp server, as .vise/providers.json names it. Its name is the prefix of its models' names.
export interface LlamaServer {
  name: string;
  url: string;
  apiKey: string;
}

// What a server supplies. The default model belongs to the router's fallback, not to a server.
export type ServerProvider = Omit<Provider, "defaultModel">;

const PropsSchema = z.object({
  default_generation_settings: z.object({ n_ctx: z.number() }),
});

const ModelsSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

// The provider for one llama.cpp server, over its OpenAI-compatible chat API. Every request carries its key.
export function llamaCpp(server: LlamaServer): ServerProvider {
  return {
    reply: (request) =>
      streamChat({ apiKey: server.apiKey, endpoint: `${baseOf(server)}/v1/chat/completions`, ...request }),
    contextWindow: () => contextLength(server),
    listModels: () => modelsOf(server),
  };
}

function baseOf(server: LlamaServer): string {
  return server.url.replace(/\/+$/, "");
}

// Reads one path of the server as JSON. A failure names the server and the path, never the key.
async function getJson(server: LlamaServer, path: string): Promise<Result<unknown>> {
  let text: string;
  try {
    const response = await fetch(`${baseOf(server)}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${server.apiKey}` },
    });
    if (!response.ok) return err(new Error(`${server.name} returned ${response.status} for ${path}`));
    text = await response.text();
  } catch (error) {
    return err(new Error(`${server.name} request failed: ${(error as Error).message}`));
  }
  try {
    return ok(JSON.parse(text));
  } catch {
    return err(new Error(`${server.name} sent ${path} that is not JSON`));
  }
}

// The context window of the model the server runs, in tokens, from its properties.
async function contextLength(server: LlamaServer): Promise<Result<number>> {
  const props = await getJson(server, "/props");
  if (!props.ok) return err(props.error);
  const parsed = PropsSchema.safeParse(props.value);
  if (!parsed.success) return err(new Error(`${server.name} sent /props in a shape that is not known`));
  return ok(parsed.data.default_generation_settings.n_ctx);
}

// The models the server lists. A llama.cpp server runs one model, so each listed model has its context window.
async function modelsOf(server: LlamaServer): Promise<Result<ModelInfo[]>> {
  const listed = await getJson(server, "/v1/models");
  if (!listed.ok) return err(listed.error);
  const parsed = ModelsSchema.safeParse(listed.value);
  if (!parsed.success) return err(new Error(`${server.name} sent /v1/models in a shape that is not known`));
  const context = await contextLength(server);
  if (!context.ok) return err(context.error);
  return ok(parsed.data.data.map((entry) => ({ id: entry.id, contextLength: context.value })));
}
