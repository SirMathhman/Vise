import type { AssistantMessage, Message } from "@vise/core";

/**
 * The model provider the client talks to: the local server, llama.cpp or Strata (see `detectBackend`).
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
  /** The `json_schema` response format carries a `name` and `strict` (OpenAI's shape; Strata and hosted engines require it, llama.cpp ignores both). */
  namedSchema: boolean;
  /** A `response_format` schema constrains decoding. Without it the schema is asked for in the prompt and the reply checked by the caller (see `schemaPrompt`). */
  schemaDecoding: boolean;
  /** `POST /v1/embeddings` exists. */
  embeddings: boolean;
}

const LLAMA_CPP: ProviderCapabilities = {
  grammar: true,
  slots: true,
  progress: true,
  antiRepeat: true,
  serverState: true,
  flatReasoning: true,
  namedSchema: true,
  schemaDecoding: true,
  embeddings: true,
};

/**
 * Strata (an OpenAI-compatible engine for large MoE models) takes the extra llama.cpp fields without
 * complaint but acts on none of them: no grammar decoding (it validates after the fact), one sequence
 * so no slots, no `dry_*`. It does report `/props` and `/slots`, and answers `return_progress`.
 * A `response_format` is only validated after the fact, and Strata puts its own schema instructions near
 * the start of the prompt, which throws away the cached conversation for that call and the one after it
 * (it keeps one cache): so the schema goes in the question at the end instead. It has no embeddings.
 */
const STRATA: ProviderCapabilities = {
  grammar: false,
  slots: false,
  progress: true,
  antiRepeat: false,
  serverState: true,
  flatReasoning: true,
  namedSchema: true,
  schemaDecoding: false,
  embeddings: false,
};

type Backend = "llama.cpp" | "strata";

/** What each server (by base URL) turned out to be; absent until `detectBackend` has asked. */
const backends = new Map<string, Backend>();
const probes = new Map<string, Promise<void>>();
/** The one model a Strata server serves (`/v1/status` `model`), per base URL. */
const servedModels = new Map<string, string>();

const trim = (url: string): string => url.replace(/\/+$/, "");

/**
 * Ask the server what it is (`GET /v1/status` names Strata) once per base URL, so `providerOf` can give
 * it the right capabilities. Anything else, or no answer, means llama.cpp. A server that cannot be
 * reached is not remembered, so the next call asks again. Tests set `VISE_BACKEND_DETECT=0` to skip it.
 */
export function detectBackend(baseUrl: string): Promise<void> {
  const base = trim(baseUrl);
  if (process.env.VISE_BACKEND_DETECT === "0" || backends.has(base)) return Promise.resolve();
  const running = probes.get(base);
  if (running) return running;
  const probe = (async () => {
    try {
      const res = await fetch(`${base}/v1/status`, { signal: AbortSignal.timeout(2_000) });
      const body: unknown = res.ok ? await res.json().catch(() => undefined) : undefined;
      const status = body as { service?: unknown; model?: unknown } | null | undefined;
      backends.set(base, status?.service === "strata" ? "strata" : "llama.cpp");
      if (status?.service === "strata" && typeof status.model === "string" && status.model !== "") {
        servedModels.set(base, status.model);
      }
    } catch {
      // Unreachable now: assume llama.cpp for this call and ask again next time.
    } finally {
      probes.delete(base);
    }
  })();
  probes.set(base, probe);
  return probe;
}

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
  const backend = backends.get(base) ?? "llama.cpp";
  return {
    id: "local",
    backend,
    // Strata serves exactly one model: a default named for llama.cpp's router would mean nothing there.
    defaultModel: (backend === "strata" ? servedModels.get(base) : undefined) ?? s.llmModel,
    chatUrl: `${base}/v1/chat/completions`,
    modelsUrl: `${base}/v1/models`,
    rootUrl: base,
    headers: { authorization: `Bearer ${s.llmApiKey}` },
    capabilities: backend === "strata" ? STRATA : LLAMA_CPP,
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

/**
 * The question's addition when the server does not constrain decoding to a schema: the schema itself, as
 * the last thing the model reads (the conversation before it stays byte-identical, so it stays cached).
 */
export function schemaPrompt(schema: Record<string, unknown>): string {
  return `

Answer with only a JSON object matching this JSON schema, with no other text and no tool call:
${JSON.stringify(schema)}`;
}

/** The JSON object in an unconstrained reply: without a code fence or words around it, when there are any. */
export function jsonObjectIn(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text.trim();
}

/** The conversation with the schema appended to its last message (the one-off question). */
export function withSchemaPrompt(messages: Message[], schema: Record<string, unknown>): Message[] {
  const last = messages[messages.length - 1];
  if (!last) return messages;
  return [...messages.slice(0, -1), { ...last, content: last.content + schemaPrompt(schema) }];
}

/** A reply as the caller gets it: where nothing constrained it to the schema, only its JSON object (the caller checks the shape). */
export function schemaReply(
  provider: Provider,
  message: AssistantMessage,
  schema: Record<string, unknown> | undefined,
): AssistantMessage {
  if (!schema || provider.capabilities.schemaDecoding) return message;
  return { ...message, content: jsonObjectIn(message.content) };
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
