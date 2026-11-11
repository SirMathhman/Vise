import { err, ok, type ModelInfo, type Provider, type Result } from "../core/messages.ts";
import type { ServerProvider } from "./llama-cpp.ts";

// A server's provider, under the server's name. Its models are named <name>/<id>.
export interface NamedServer {
  name: string;
  provider: ServerProvider;
}

interface Target {
  provider: ServerProvider;
  model: string;
}

// Several providers as one. A model named <name>/<id> goes to the server called <name>, and that server is
// given <id>. Any other model goes to the fallback, under its own name.
export function routed(servers: NamedServer[], fallback: Provider): Provider {
  return {
    defaultModel: fallback.defaultModel,
    reply: (request) => {
      const target = targetOf(servers, request.model);
      if (target === undefined) return fallback.reply(request);
      return target.provider.reply({ ...request, model: target.model });
    },
    contextWindow: (model) => {
      const target = targetOf(servers, model);
      if (target === undefined) return fallback.contextWindow(model);
      return target.provider.contextWindow(target.model);
    },
    listModels: () => listAll(servers, fallback),
  };
}

function targetOf(servers: NamedServer[], model: string): Target | undefined {
  for (const server of servers) {
    const prefix = `${server.name}/`;
    if (model.startsWith(prefix)) return { provider: server.provider, model: model.slice(prefix.length) };
  }
  return undefined;
}

// Every server's models, named with their server, then the fallback's. A server that fails fails the list, so
// the failure is seen rather than hidden.
async function listAll(servers: NamedServer[], fallback: Provider): Promise<Result<ModelInfo[]>> {
  const models: ModelInfo[] = [];
  for (const server of servers) {
    const listed = await server.provider.listModels();
    if (!listed.ok) return err(listed.error);
    for (const model of listed.value) {
      models.push({ id: `${server.name}/${model.id}`, contextLength: model.contextLength });
    }
  }
  const fromFallback = await fallback.listModels();
  if (!fromFallback.ok) return err(fromFallback.error);
  return ok([...models, ...fromFallback.value]);
}
