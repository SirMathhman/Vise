// The model catalog: lists the models the server reports at GET /v1/models
// and validates a name against the catalog. No fetch of its own — it uses
// the same auth and base URL the client uses, but is a distinct request so
// it lives here, not beside a chat completion.
import type { Config } from "../config.ts";
import type { ModelInfo, ModelsResponse } from "./types.ts";

// Fetches the model catalog. Throws on transport/HTTP errors.
export async function listModels(config: Config): Promise<ModelInfo[]> {
  const res = await fetch(`${config.baseUrl}/v1/models`, {
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  const data = (await res.json()) as ModelsResponse;
  const models: ModelInfo[] = [];
  for (const m of data.data ?? []) {
    if (typeof m.id === "string") {
      models.push({ id: m.id, loaded: m.status?.value === "loaded" });
    }
  }
  return models;
}
