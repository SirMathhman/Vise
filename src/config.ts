// Typed, env-derived settings. Read-only everywhere except the model
// selector, which owns the mutable `model` field. No I/O beyond reading
// env, no fetch.
export type Config = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  preSessionCmd?: string;
};

export function loadConfig(): Config {
  return {
    baseUrl: process.env.LLM_BASE_URL ?? "http://localhost:8080",
    model: process.env.LLM_MODEL ?? "local",
    apiKey: process.env.LLM_API_KEY,
    preSessionCmd: process.env.PRE_SESSION_CMD,
  };
}
