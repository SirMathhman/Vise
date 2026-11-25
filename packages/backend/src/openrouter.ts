import type { ModelSummary } from "common";

const MODELS_URL = "https://openrouter.ai/api/v1/models";

// Shape of one entry in OpenRouter's response. Prices are USD per token, as strings.
interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: { prompt: string; completion: string };
}

export async function fetchModels(apiKey: string): Promise<ModelSummary[]> {
  const res = await fetch(MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter responded with HTTP ${String(res.status)}`);
  }

  const body = (await res.json()) as { data: OpenRouterModel[] };
  return body.data.map((m) => ({
    id: m.id,
    name: m.name,
    contextLength: m.context_length,
    promptPricePerMillion: Number(m.pricing.prompt) * 1_000_000,
    completionPricePerMillion: Number(m.pricing.completion) * 1_000_000,
  }));
}
