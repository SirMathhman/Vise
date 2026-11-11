import { err, ok, type Provider, type Result } from "../core/messages.ts";
import { KEY_VARIABLE, openRouter } from "./openrouter.ts";

// The variables that hold a provider's key. A child process never receives them (src/tools/process/child-env.ts).
export const PROVIDER_KEY_VARIABLES: readonly string[] = [KEY_VARIABLE];

// The provider the session uses, built from the environment. OpenRouter is the only one. A new provider is added
// here, with its own key variable.
export function providerFromEnv(env: Record<string, string | undefined>): Result<Provider> {
  const apiKey = env[KEY_VARIABLE];
  if (!apiKey) return err(new Error(`Set ${KEY_VARIABLE} in .env`));
  return ok(openRouter(apiKey));
}
