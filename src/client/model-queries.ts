import { modelInfo, modelRef, type ModelInfo, type Provider, type ProviderId } from "./provider.ts";
import type { Result } from "../core/errors.ts";

/**
 * Lookups that ask a provider about its models: the list, a model's window and
 * vision support, an embedding. Each is a plain function of the provider (and
 * the model id), so `LlmClient` only decides which provider and model to ask.
 */

/** One entry in the model list, with the metadata the picker shows. */
export interface ModelDetail {
  /** The model reference (see `modelRef`): the bare id for local, `openrouter:<id>` for OpenRouter. */
  id: string;
  name?: string;
  contextLength?: number;
  vision: boolean;
  provider: ProviderId;
}

interface ModelsResponse {
  data?: { id: string; name?: string; context_length?: number; architecture?: { input_modalities?: string[] } }[];
}

/** A `/slots` entry: the context window of a slot. */
interface Slot {
  n_ctx: number;
}

const networkError = (err: unknown): Result<never> => ({
  ok: false,
  error: { kind: "network", cause: err instanceof Error ? err.message : String(err) },
});

/** One provider's model list, each model under its reference. */
export async function fetchModelDetails(provider: Provider): Promise<Result<ModelDetail[]>> {
  try {
    const res = await fetch(provider.modelsUrl, { method: "GET", headers: provider.headers });
    if (!res.ok) {
      return { ok: false, error: { kind: "http", status: res.status, body: await res.text() } };
    }
    const data = (await res.json()) as ModelsResponse;
    const models = (data.data ?? []).map((m) => ({
      id: modelRef(provider.id, m.id),
      name: m.name,
      contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
      vision: m.architecture?.input_modalities?.includes("image") === true,
      provider: provider.id,
    }));
    return { ok: true, value: models };
  } catch (err) {
    return networkError(err);
  }
}

/** What a hosted provider's `/models` says about one model (window, vision); undefined when unknown. */
export async function fetchHostedInfo(provider: Provider, id: string): Promise<ModelInfo | undefined> {
  const res = await fetch(provider.modelsUrl, { headers: provider.headers });
  if (!res.ok) return undefined;
  return modelInfo(await res.json(), id);
}

/**
 * Whether a model on a llama.cpp server can see images: the router lists a
 * multimodal projector among the model's arguments, or (single model) `/props`
 * reports vision. False when that cannot be found out.
 */
export async function localSupportsVision(provider: Provider, id: string): Promise<boolean> {
  const headers = provider.headers;
  try {
    const listed = await fetch(provider.modelsUrl, { headers });
    if (listed.ok) {
      const body = (await listed.json()) as { data?: { id: string; status?: { args?: string[] } }[] };
      const args = body.data?.find((m) => m.id === id)?.status?.args;
      if (args) return args.some((a) => a === "--mmproj" || a === "-mm");
    }
    const props = await fetch(`${provider.rootUrl}/props?model=${encodeURIComponent(id)}`, { headers });
    if (!props.ok) return false;
    const info = (await props.json()) as { modalities?: { vision?: boolean } };
    return info.modalities?.vision === true;
  } catch {
    return false;
  }
}

/** A llama.cpp model's context window from `GET /slots` (`n_ctx`). */
export async function fetchSlotContext(provider: Provider, id: string): Promise<Result<number>> {
  try {
    const res = await fetch(`${provider.rootUrl}/slots?model=${encodeURIComponent(id)}`, {
      method: "GET",
      headers: provider.headers,
    });
    if (!res.ok) {
      return { ok: false, error: { kind: "http", status: res.status, body: await res.text() } };
    }
    const slots = (await res.json()) as Slot[];
    const nCtx = Array.isArray(slots) && slots.length > 0 ? slots[0]?.n_ctx : undefined;
    if (nCtx === undefined) {
      return { ok: false, error: { kind: "malformed", body: "slots response had no n_ctx" } };
    }
    return { ok: true, value: nCtx };
  } catch (err) {
    return networkError(err);
  }
}

/** An embedding of `text` from the provider's embeddings endpoint. */
export async function fetchEmbedding(provider: Provider, model: string, text: string): Promise<Result<number[]>> {
  try {
    const url =
      provider.rootUrl !== undefined
        ? `${provider.rootUrl}/v1/embeddings`
        : provider.chatUrl.replace("/chat/completions", "/embeddings");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...provider.headers },
      body: JSON.stringify({ model, input: [text] }),
    });
    if (!res.ok) {
      return { ok: false, error: { kind: "http", status: res.status, body: await res.text() } };
    }
    const data = (await res.json()) as { data?: { embedding: number[] }[] };
    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      return { ok: false, error: { kind: "malformed", body: "no embedding in response" } };
    }
    return { ok: true, value: embedding };
  } catch (err) {
    return networkError(err);
  }
}
