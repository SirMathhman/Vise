import type { ModelSummary } from "common";

const MODELS_URL = "https://openrouter.ai/api/v1/models";

// Shape of one entry in OpenRouter's response. Prices are USD per token, as strings.
interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

function isOpenRouterModel(value: unknown): value is OpenRouterModel {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const m = value as Record<string, unknown>;
  const pricing = m.pricing as Record<string, unknown> | null | undefined;
  return (
    typeof m.id === "string" &&
    typeof m.name === "string" &&
    typeof m.context_length === "number" &&
    typeof pricing === "object" &&
    pricing !== null &&
    typeof pricing.prompt === "string" &&
    typeof pricing.completion === "string"
  );
}

function isOpenRouterModelList(
  value: unknown,
): value is { data: OpenRouterModel[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    Array.isArray(value.data) &&
    (value.data as unknown[]).every(isOpenRouterModel)
  );
}

export async function fetchModels(apiKey: string): Promise<ModelSummary[]> {
  const res = await fetch(MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter responded with HTTP ${String(res.status)}`);
  }

  const body: unknown = await res.json();
  if (!isOpenRouterModelList(body)) {
    throw new Error("OpenRouter returned a model list in an unexpected format");
  }
  return body.data.map((m) => ({
    id: m.id,
    name: m.name,
    contextLength: m.context_length,
    promptPricePerMillion: Number(m.pricing.prompt) * 1_000_000,
    completionPricePerMillion: Number(m.pricing.completion) * 1_000_000,
  }));
}
