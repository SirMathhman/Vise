// The model catalog: lists the models the server reports at GET /v1/models
// and validates a name against the catalog. No fetch of its own — it routes
// through the client's getJson, satisfying invariant #2.
import type { Config } from "../config.ts";
import { getJson } from "./client.ts";
import type { ModelInfo, ModelsResponse } from "./types.ts";

// Fetches the model catalog. Throws on transport/HTTP errors.
export async function listModels(config: Config): Promise<ModelInfo[]> {
  const data = (await getJson(config, "/v1/models")) as ModelsResponse;
  const models: ModelInfo[] = [];
  for (const m of data.data ?? []) {
    if (typeof m.id === "string") {
      models.push({ id: m.id, loaded: m.status?.value === "loaded" });
    }
  }
  return models;
}
