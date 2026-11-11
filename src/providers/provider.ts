import { err, ok, type Provider, type Result } from "../core/messages.ts";
import { llamaCpp, type LlamaServer } from "./llama-cpp.ts";
import { routed } from "./router.ts";
import { KEY_VARIABLE, openRouter } from "./openrouter.ts";

// The provider the session uses: OpenRouter, with each llama.cpp server listed in .vise/providers.json routed by
// its name. OpenRouter's key comes from the environment. A new provider is added here.
export function providerFromEnv(env: Record<string, string | undefined>, servers: LlamaServer[]): Result<Provider> {
  const apiKey = env[KEY_VARIABLE];
  if (!apiKey) return err(new Error(`Set ${KEY_VARIABLE} in .env`));
  const named = servers.map((server) => ({ name: server.name, provider: llamaCpp(server) }));
  return ok(routed(named, openRouter(apiKey)));
}
