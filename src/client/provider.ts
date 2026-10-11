/**
 * The model provider the client talks to: the local llama.cpp server or
 * OpenRouter. Pure: built from setting values, it says where requests go, what
 * headers they carry and which llama.cpp-only features the server understands,
 * so `LlmClient` never branches on a URL.
 */
export type ProviderId = "local" | "openrouter";

/** The settings a provider is built from (a subset of `config`). */
export interface ProviderSettings {
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  openrouterUrl: string;
  openrouterApiKey: string;
  openrouterModel: string;
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
  /** GBNF grammar, logprobs, slots, prompt progress: llama.cpp only. */
  llamaCpp: boolean;
}

const trim = (url: string): string => url.replace(/\/+$/, "");

export function providerFor(s: ProviderSettings): Provider {
  if (s.llmProvider === "openrouter") {
    const base = trim(s.openrouterUrl);
    return {
      id: "openrouter",
      backend: "OpenRouter",
      defaultModel: s.openrouterModel,
      chatUrl: `${base}/chat/completions`,
      modelsUrl: `${base}/models`,
      rootUrl: undefined,
      headers: {
        authorization: `Bearer ${s.openrouterApiKey}`,
        "http-referer": "https://github.com/SirMathhman/Vise",
        "x-title": "Vise",
      },
      llamaCpp: false,
    };
  }
  const base = trim(s.llmBaseUrl);
  return {
    id: "local",
    backend: "llama.cpp",
    defaultModel: s.llmModel,
    chatUrl: `${base}/v1/chat/completions`,
    modelsUrl: `${base}/v1/models`,
    rootUrl: base,
    headers: { authorization: `Bearer ${s.llmApiKey}` },
    llamaCpp: true,
  };
}

/** Request fields that differ by provider: the reasoning level and the schema-constrained reply. */
export function reasoningFields(
  provider: Provider,
  effort: string | undefined,
): Record<string, unknown> {
  if (effort === undefined || effort === "default") return {};
  return provider.llamaCpp
    ? { reasoning_effort: effort }
    : { reasoning: { effort } };
}

export function responseFormat(
  provider: Provider,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return provider.llamaCpp
    ? { type: "json_schema", json_schema: { schema } }
    : {
        type: "json_schema",
        json_schema: { name: "vise", strict: true, schema },
      };
}

/** What `GET /models` says about one OpenRouter model. */
export interface ModelInfo {
  contextLength?: number;
  vision: boolean;
}

interface RawModel {
  id: string;
  context_length?: number;
  architecture?: { input_modalities?: string[] };
}

/** Read one model's window and image support out of an OpenRouter `/models` body. */
export function modelInfo(body: unknown, id: string): ModelInfo | undefined {
  const data = (body as { data?: RawModel[] } | null)?.data;
  const m = Array.isArray(data) ? data.find((x) => x.id === id) : undefined;
  if (!m) return undefined;
  return {
    contextLength:
      typeof m.context_length === "number" ? m.context_length : undefined,
    vision: m.architecture?.input_modalities?.includes("image") === true,
  };
}
