/**
 * Non-streaming model queries: embeddings and the model list.
 * Free functions so they can be called without an `LlmClient` instance.
 */
import { config } from "../config.ts";
import type { Result } from "../core/errors.ts";
import { activeProvider } from "./llm.ts";
import { modelInfo, type ModelInfo } from "./provider.ts";

/**
 * Get an embedding for `text` from the server via `POST /v1/embeddings`.
 * The model defaults to the chat model (or the `VISE_EMBEDDING_MODEL` setting
 * when set).
 */
export async function embedText(text: string): Promise<Result<number[]>> {
  try {
    const provider = activeProvider();
    const model = config.embeddingModel || provider.defaultModel;
    const res = await fetch(provider.embeddingsUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...provider.headers },
      body: JSON.stringify({ model, input: [text] }),
    });
    if (!res.ok) {
      const body = await res.text();
      return {
        ok: false,
        error: { kind: "http", status: res.status, body },
      };
    }
    const data = (await res.json()) as {
      data?: { embedding: number[] }[];
    };
    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      return {
        ok: false,
        error: { kind: "malformed", body: "no embedding in response" },
      };
    }
    return { ok: true, value: embedding };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "network",
        cause: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Fetch the list of available model ids from the server via `GET /v1/models`.
 */
export async function listModelIds(): Promise<Result<string[]>> {
  try {
    const provider = activeProvider();
    const res = await fetch(provider.modelsUrl, {
      method: "GET",
      headers: provider.headers,
    });
    if (!res.ok) {
      const text = await res.text();
      return {
        ok: false,
        error: { kind: "http", status: res.status, body: text },
      };
    }
    const data = (await res.json()) as ModelsResponse;
    const models = data.data?.map((m) => m.id).filter(Boolean) ?? [];
    return { ok: true, value: models };
  } catch (err) {
    return {
      ok: false,
      error: {
        kind: "network",
        cause: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

interface ModelsResponse {
  data?: { id: string }[];
}
