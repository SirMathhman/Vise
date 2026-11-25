import type { ModelSummary, Result } from "common";
import { err, ok, parseJson } from "common";
import { z } from "zod";

const MODELS_URL = "https://openrouter.ai/api/v1/models";

// OpenRouter's model list. Prices are USD per token, as strings.
const OpenRouterModelsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      context_length: z.number(),
      pricing: z.object({ prompt: z.string(), completion: z.string() }),
    }),
  ),
});

// OpenRouter reports a negative price (-1) for models whose price varies per request.
function perMillion(price: string): number | null {
  const value = Number(price) * 1_000_000;
  return value < 0 ? null : value;
}

/**
 * Lists the models the account can use, with prices in USD per million tokens. Returns an error when OpenRouter cannot be reached or its reply does not match the expected shape.
 *
 * @param apiKey The OpenRouter key to list the models with.
 * @returns The models, with prices in USD per million tokens, or the error that stopped the request.
 */
export async function fetchModels(
  apiKey: string,
): Promise<Result<ModelSummary[], string>> {
  let res: Response;
  try {
    res = await fetch(MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    return err("Could not reach OpenRouter");
  }
  if (!res.ok) {
    return err(`OpenRouter responded with HTTP ${String(res.status)}`);
  }

  const parsed = parseJson(OpenRouterModelsSchema, await res.text());
  if (!parsed.ok) {
    return err("OpenRouter returned a model list in an unexpected format");
  }
  return ok(
    parsed.value.data.map((m) => ({
      id: m.id,
      name: m.name,
      contextLength: m.context_length,
      promptPricePerMillion: perMillion(m.pricing.prompt),
      completionPricePerMillion: perMillion(m.pricing.completion),
    })),
  );
}
