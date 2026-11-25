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

// OpenRouter reports a negative price (-1) for models whose price varies per request.
function perMillion(price: string): number | null {
  const value = Number(price) * 1_000_000;
  return value < 0 ? null : value;
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
    promptPricePerMillion: perMillion(m.pricing.prompt),
    completionPricePerMillion: perMillion(m.pricing.completion),
  }));
}
