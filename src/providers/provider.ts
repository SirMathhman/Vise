import { ok, type Provider, type Result } from "../core/messages.ts";
import { type ConfiguredProvider, type OpenRouterAccount } from "./config.ts";
import { llamaCpp, type ServerProvider } from "./llama-cpp.ts";
import { DEFAULT_MODEL, openRouter } from "./openrouter.ts";
import { routed, type NamedServer } from "./router.ts";

// The provider the session uses: every provider in .vise/providers.json, each routed by its name. A session starts on
// the default model of the first OpenRouter account, or with no model when no account is listed.
export function buildProvider(configured: ConfiguredProvider[]): Result<Provider> {
  const named: NamedServer[] = configured.map((entry) => ({ name: entry.name, provider: providerOf(entry) }));
  const first = configured.find((entry): entry is OpenRouterAccount => entry.kind === "openrouter");
  const defaultModel = first === undefined ? "" : `${first.name}::${DEFAULT_MODEL}`;
  return ok(routed(named, defaultModel));
}

function providerOf(entry: ConfiguredProvider): ServerProvider {
  return entry.kind === "openrouter" ? openRouter(entry.apiKey) : llamaCpp(entry);
}
