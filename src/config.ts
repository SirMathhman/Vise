import { existsSync, readFileSync } from "node:fs";

export const DEFAULT_BASE_URL = "http://localhost:8080";

/**
 * The llama.cpp server base URL, from `VISE_BASE_URL` or the default
 * `http://localhost:8080`. Read at call time so the value reflects any env
 * the process was started with.
 */
export function getBaseUrl(): string {
  const url = process.env["VISE_BASE_URL"];
  return url && url.trim() ? url.trim() : DEFAULT_BASE_URL;
}

/**
 * Load `.env` from the current working directory into `process.env`.
 * Skips comments/blank lines and never overrides keys already set in the
 * environment. Safe to call once at startup; no-op when `.env` is absent.
 */
export function loadEnv(): void {
  if (!existsSync(".env")) return;
  const content = readFileSync(".env", "utf8");
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = value;
  }
}

/**
 * The configured default model name (`VISE_MODEL`), or `undefined` when not
 * set. Read at call time; empty/whitespace values are treated as unset.
 */
export function getDefaultModel(): string | undefined {
  const model = process.env["VISE_MODEL"];
  return model ? model.trim() || undefined : undefined;
}

/** The configured API key, or `undefined` when not set. */
export function getApiKey(): string | undefined {
  const apiKey = process.env["VISE_API_KEY"];
  return apiKey ? apiKey : undefined;
}

/** Auth header for an API key, or an empty object when no key is set. */
export function authHeaders(): Record<string, string> {
  const apiKey = getApiKey();
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}
