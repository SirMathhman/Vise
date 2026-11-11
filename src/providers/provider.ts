import { err, ok, type Provider, type Result } from "../core/messages.ts";
import { KEY_VARIABLE, openRouter } from "./openrouter.ts";

// The provider the session uses, built from the environment. OpenRouter is the only one. A new provider is added
// here, with its own key variable.
export function providerFromEnv(env: Record<string, string | undefined>): Result<Provider> {
  const apiKey = env[KEY_VARIABLE];
  if (!apiKey) return err(new Error(`Set ${KEY_VARIABLE} in .env`));
  return ok(openRouter(apiKey));
}
