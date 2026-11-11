import { err, ok, type ModelInfo, type Provider, type Result } from "../core/messages.ts";
import type { ServerProvider } from "./llama-cpp.ts";

// A provider, under its name. Its models are named <name>::<id>.
export interface NamedServer {
  name: string;
  provider: ServerProvider;
}

interface Target {
  provider: ServerProvider;
  model: string;
}

// Every provider as one. A model named <name>::<id> goes to the provider called <name>, which is given <id>. A model
// whose name matches no provider is refused, so a model saved before the names changed must be chosen again.
export function routed(servers: NamedServer[], defaultModel: string): Provider {
  return {
    defaultModel,
    reply: (request) => {
      const target = targetOf(servers, request.model);
      if (target === undefined) return refused(request.model);
      return target.provider.reply({ ...request, model: target.model });
    },
    contextWindow: async (model) => {
      const target = targetOf(servers, model);
      if (target === undefined) return err(unknownModel(model));
      return target.provider.contextWindow(target.model);
    },
    listModels: () => listAll(servers),
  };
}

function unknownModel(model: string): Error {
  return new Error(`no provider is named for ${model}; choose a model with /model`);
}

async function* refused(model: string): AsyncGenerator<Result<string>> {
  yield err(unknownModel(model));
}

function targetOf(servers: NamedServer[], model: string): Target | undefined {
  for (const server of servers) {
    const prefix = `${server.name}::`;
    if (model.startsWith(prefix)) return { provider: server.provider, model: model.slice(prefix.length) };
  }
  return undefined;
}

// Every provider's models, each named with its provider. A provider that fails fails the list, so the failure is
// seen rather than hidden.
async function listAll(servers: NamedServer[]): Promise<Result<ModelInfo[]>> {
  const models: ModelInfo[] = [];
  for (const server of servers) {
    const listed = await server.provider.listModels();
    if (!listed.ok) return err(listed.error);
    for (const model of listed.value) {
      models.push({ id: `${server.name}::${model.id}`, contextLength: model.contextLength });
    }
  }
  return ok(models);
}
