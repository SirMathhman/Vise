/**
 * The model provider the client talks to: today the local llama.cpp server.
 * Pure: built from setting values, it says where requests go, what headers they
 * carry and which llama.cpp-only features the server understands, so
 * `LlmClient` never branches on a URL. Another OpenAI-compatible engine (vLLM)
 * is added by extending `ProviderId`, `providerOf` and a capabilities profile.
 */
export type ProviderId = "local";

/** The settings a provider is built from (a subset of `config`). */
export interface ProviderSettings {
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
}

export interface Provider {
  id: ProviderId;
  /** Label reported by the `self` tool. */
  backend: string;
  defaultModel: string;
  chatUrl: string;
  modelsUrl: string;
  /** `GET` of the server's own state (`/slots`, `/props`); undefined when it has none. */
  rootUrl: string | undefined;
  headers: Record<string, string>;
  /** What the server understands beyond the plain chat API (the llama.cpp extras). */
  capabilities: ProviderCapabilities;
}

/** Features a request or a lookup may use, each asked by its own name so a new provider sets what it has. */
export interface ProviderCapabilities {
  /** A GBNF `grammar` constrains tool calls (also what burst mode needs). */
  grammar: boolean;
  /** `/slots` and `id_slot`: requests can be pinned to a cache slot. */
  slots: boolean;
  /** Streamed prompt progress and per-token timings. */
  progress: boolean;
  /** `dry_*` / `repeat_penalty` sampling fields. */
  antiRepeat: boolean;
  /** The server reports its own state (`/slots`, `/props`): context window and vision are read there, not from `/models`. */
  serverState: boolean;
  /** `reasoning_effort` is a top-level field (else `reasoning: { effort }`). */
  flatReasoning: boolean;
  /** The `json_schema` response format needs a name and `strict`. */
  namedSchema: boolean;
}

const LLAMA_CPP: ProviderCapabilities = {
  grammar: true,
  slots: true,
  progress: true,
  antiRepeat: true,
  serverState: true,
  flatReasoning: true,
  namedSchema: false,
};

const trim = (url: string): string => url.replace(/\/+$/, "");

/** The provider the settings name as the default (the one a session starts on). */
export function defaultProviderId(_s: ProviderSettings): ProviderId {
  return "local";
}

/**
 * A model reference names its provider: `<provider>:<id>` for a non-local
 * provider, a bare id for local. No other provider exists yet, so every
 * reference is local; a stale prefixed reference is kept as an (unknown) id.
 */
export function modelRef(_provider: ProviderId, model: string): string {
  return model;
}

/** Which provider a model reference belongs to, and the id the provider calls it by. */
export function parseModelRef(ref: string): { provider: ProviderId; model: string } {
  return { provider: "local", model: ref };
}

export function providerFor(s: ProviderSettings): Provider {
  return providerOf(s, defaultProviderId(s));
}

/** The provider with the given id, built from the settings. */
export function providerOf(s: ProviderSettings, id: ProviderId): Provider {
  void id;
  const base = trim(s.llmBaseUrl);
  return {
    id: "local",
    backend: "llama.cpp",
    defaultModel: s.llmModel,
    chatUrl: `${base}/v1/chat/completions`,
    modelsUrl: `${base}/v1/models`,
    rootUrl: base,
    headers: { authorization: `Bearer ${s.llmApiKey}` },
    capabilities: LLAMA_CPP,
  };
}

/** Request fields that differ by provider: the reasoning level and the schema-constrained reply. */
export function reasoningFields(
  provider: Provider,
  effort: string | undefined,
): Record<string, unknown> {
  if (effort === undefined || effort === "default") return {};
  return provider.capabilities.flatReasoning
    ? { reasoning_effort: effort }
    : { reasoning: { effort } };
}

export function responseFormat(
  provider: Provider,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return provider.capabilities.namedSchema
    ? {
        type: "json_schema",
        json_schema: { name: "vise", strict: true, schema },
      }
    : { type: "json_schema", json_schema: { schema } };
}

/** What `GET /models` says about one model. */
export interface ModelInfo {
  contextLength?: number;
  vision: boolean;
}

interface RawModel {
  id: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
}

/** Read one model's window and image support out of a provider's `/models` body. */
export function modelInfo(body: unknown, id: string): ModelInfo | undefined {
  const data = (body as { data?: RawModel[] } | null)?.data;
  const m = Array.isArray(data) ? data.find((x) => x.id === id) : undefined;
  if (!m) return undefined;
  return {
    contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
    vision: m.architecture?.input_modalities?.includes("image") === true,
  };
}
