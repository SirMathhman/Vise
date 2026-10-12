import { modelInfo, modelRef, type ModelInfo, type Provider, type ProviderId } from "./provider.ts";
import type { Result } from "../core/errors.ts";

/**
 * Lookups that ask a provider about its models: the list, a model's window and
 * vision support, an embedding. Each is a plain function of the provider (and
 * the model id), so `LlmClient` only decides which provider and model to ask.
 */

/** One entry in the model list, with the metadata the picker shows. */
export interface ModelDetail {
  /** The model reference (see `modelRef`): the bare id for local, `<provider>:<id>` otherwise. */
  id: string;
  name?: string;
  contextLength?: number;
  vision: boolean;
  /** Looks like an embedding model: it has a pooling type set, or its name says so (see `looksLikeEmbedder`). */
  embedding: boolean;
  provider: ProviderId;
}

interface ModelsResponse {
  data?: {
    id: string;
    name?: string;
    context_length?: number;
    architecture?: { input_modalities?: string[] };
    /** llama.cpp's router lists each model's server arguments here. */
    status?: { args?: string[] };
  }[];
}

/** A `/slots` entry: the context window of a slot. */
interface Slot {
  n_ctx: number;
}

const networkError = (err: unknown): Result<never> => ({
  ok: false,
  error: { kind: "network", cause: err instanceof Error ? err.message : String(err) },
});

/**
 * Whether a model listed by llama.cpp is meant for embeddings. The router puts
 * `--embeddings` on every model, so that says nothing; what does is a pooling
 * type (`--pooling mean`, which only an embedder is started with) or a name
 * such as `nomic-embed-text` or `bge-m3`. A hint for the settings page, not a rule.
 */
export function looksLikeEmbedder(id: string, args: string[]): boolean {
  const at = args.indexOf("--pooling");
  const pooled = at >= 0 && args[at + 1] !== undefined && args[at + 1] !== "none";
  return pooled || /embed|(^|[/_-])(bge|e5|gte|minilm|mxbai|snowflake-arctic)([/_.-]|$)/i.test(id);
}

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
      embedding: looksLikeEmbedder(m.id, m.status?.args ?? []),
      provider: provider.id,
    }));
    return { ok: true, value: models };
  } catch (err) {
    return networkError(err);
  }
}

/** What a provider's `/models` says about one model (window, vision); undefined when unknown. */
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

/**
 * Embeddings of `texts` (one vector each, in the order given) from the
 * provider's embeddings endpoint, one request for the whole batch.
 */
export async function fetchEmbeddings(
  provider: Provider,
  model: string,
  texts: string[],
): Promise<Result<number[][]>> {
  if (texts.length === 0) return { ok: true, value: [] };
  try {
    const url =
      provider.rootUrl !== undefined
        ? `${provider.rootUrl}/v1/embeddings`
        : provider.chatUrl.replace("/chat/completions", "/embeddings");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...provider.headers },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!res.ok) {
      return { ok: false, error: { kind: "http", status: res.status, body: await res.text() } };
    }
    const data = (await res.json()) as { data?: { index?: number; embedding?: number[] }[] };
    // The answer may come in any order: `index` says which input a vector is for.
    const ordered = [...(data.data ?? [])].sort((x, y) => (x.index ?? 0) - (y.index ?? 0));
    const vectors = ordered.map((d) => d.embedding);
    if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v) || v.length === 0)) {
      return {
        ok: false,
        error: { kind: "malformed", body: `expected ${texts.length} embeddings, the server sent ${vectors.length}` },
      };
    }
    return { ok: true, value: vectors as number[][] };
  } catch (err) {
    return networkError(err);
  }
}
