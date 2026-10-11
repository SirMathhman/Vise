import { config } from "../config.ts";
import { noAudit, type AuditSink } from "../core/audit.ts";
import { encodeMessages, type ImageResolver, plainMessages, hideCalls, nameConfidence, parseReply, toolRequestFields } from "./tool-protocol.ts";
import { collectThinking, readJsonReply, streamChat } from "./stream-reader.ts";
import { generationReporter } from "./generation.ts";
import { modelInfo, providerFor, reasoningFields, responseFormat, type ModelInfo, type Provider } from "./provider.ts";
import { chooseSideSlot as chooseSlot, slotJustUsed } from "./slots.ts";
import { CallLog, CallTrace, recordCallEnd, recordCallStart, noteServerCut, runawayError, traceListener, traceThinking } from "./call-trace.ts";

export { streamChat };
import type { Client, Tool } from "../core/engine.ts";
import type {
  AssistantMessage,
  Message,
  CallPurpose,
  GenerationProgress,
  PromptProgress,
  Result,
} from "../core/errors.ts";


/** The active provider, read live from the settings (they can change while running). */
export function activeProvider(): Provider {
  return providerFor(config);
}

/** The inference backend label reported by the `self` tool. */
export function backendName(): string {
  return activeProvider().backend;
}

interface Slot {
  id: number;
  n_ctx: number;
  /** The most recent task the slot ran (grows with time; the highest is the slot used last). */
  id_task?: number;
}

interface ModelsResponse {
  data?: { id: string }[];
}

/**
 * The valid llama.cpp `reasoning_effort` levels, in the order they are
 * presented to the user. `default` keeps the chat template's built-in default;
 * `none` disables reasoning/thinking; the remaining levels are forwarded to the
 * Jinja chat template as-is. Exported so the terminal, web, and tests all
 * share one source of truth for the set of accepted values.
 */
export const REASONING_EFFORTS = ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** What a streamed request asks of the server: usage, prompt progress while it reads, and a running count of what it writes. */
const STREAM_FIELDS = {
  stream: true,
  stream_options: { include_usage: true },
};

/** The llama.cpp-only extras of a streamed request. */
const LLAMA_STREAM_FIELDS = { return_progress: true, timings_per_token: true };

/** Read one model reply, and tell `generation` (if any) when the call has ended, however it ended. */
async function readReply(
  read: () => ReturnType<typeof streamChat>,
  generation?: { done(): void },
): ReturnType<typeof streamChat> {
  try {
    return await read();
  } finally {
    generation?.done();
  }
}

export class LlmClient implements Client {
  private lastPromptTokens: number | undefined;
  private currentModel: string = activeProvider().defaultModel;
  /** OpenRouter `/models` facts per model id (window, vision), fetched once. */
  private readonly infoCache = new Map<string, ModelInfo>();
  private requestSeq = 0;
  /** What every model call of this client has written, running or recent (the inspector and `/audit calls` read it). */
  readonly calls = new CallLog();
  /** Hears the prompt processing of every model call of this client (set by the edge): the one place progress is reported. */
  private progressSink?: (progress: PromptProgress) => void;

  setProgressSink(
    sink: ((progress: PromptProgress) => void) | undefined,
  ): void {
    this.progressSink = sink;
  }

  /** Hears one record per model call: its purpose, duration and reply (set by the edge). */
  private auditSink: AuditSink = noAudit;

  setAuditSink(sink: AuditSink): void {
    this.auditSink = sink;
  }

  /** The same client with its calls labelled by what they are for (see `Client.as`). */
  as(purpose: CallPurpose): Client {
    return {
      chat: (
        messages,
        tools,
        onToken,
        onThinking,
        onProgress,
        schema,
        signal,
        isToolEnabled,
        act,
      ) =>
        this.chat(
          messages,
          tools,
          onToken,
          onThinking,
          onProgress,
          schema,
          signal,
          isToolEnabled,
          act,
          purpose,
        ),
    };
  }

  /** Hears how much each model call has generated so far (set by the edge). */
  private generationSink?: (progress: GenerationProgress) => void;

  setGenerationSink(
    sink: ((progress: GenerationProgress) => void) | undefined,
  ): void {
    this.generationSink = sink;
  }

  /** Progress reports of one request: labelled, and given to the sink and to the caller's own callback. */
  private reporter(
    request: number,
    purpose: CallPurpose,
    callback?: (progress: PromptProgress) => void,
  ): ((progress: PromptProgress) => void) | undefined {
    if (!this.progressSink && !callback) return undefined;
    return (progress) => {
      const tagged = { ...progress, request, purpose };
      callback?.(tagged);
      this.progressSink?.(tagged);
    };
  }
  /** Turns the pictures in the conversation into what is sent to the model (set by the edge, which owns the image files). */
  imageResolver?: ImageResolver;
  /**
   * The active `reasoning_effort` level. `undefined` (or `"default"`) means
   * the field is omitted from the request so the chat template uses its
   * built-in default; any other value is forwarded as `reasoning_effort`.
   */
  private reasoningEffort: ReasoningEffort | undefined;
  /** The slot side work is pinned to while `withSideSlot` runs; undefined when it runs unpinned. */
  private sideSlot: number | undefined;
  private sideDepth = 0;
  /** The slot the main conversation was last seen on (see `noteMainSlot`). */
  private mainSlot: number | undefined;
  private mainSlotProbe: Promise<void> | undefined;
  private readonly slotRequestTimeoutMs: number;

  constructor(slotRequestTimeoutMs = config.slotRequestTimeoutMs) {
    this.slotRequestTimeoutMs = slotRequestTimeoutMs;
  }

  /**
   * Run side work (a subagent) on a llama.cpp slot of its own, so the main
   * conversation's slot, and the context checkpoints the server needs to reuse
   * its prefix, are never touched. Slots are for concurrent activity: saving a
   * slot to a file and restoring it afterwards does not bring the checkpoints
   * back, so the next main request re-processed the whole prompt. With a single
   * slot (or when the slots cannot be read) the work runs unpinned and the
   * server's own prompt cache keeps the evicted context. Nested side work uses
   * the same slot.
   */
  async withSideSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.sideDepth++ === 0) {
      this.sideSlot = activeProvider().llamaCpp
        ? await this.chooseSideSlot().catch(() => undefined)
        : undefined;
    }
    try {
      return await operation();
    } finally {
      if (--this.sideDepth === 0) this.sideSlot = undefined;
    }
  }

  /** The least recently used slot other than the one used last (the main conversation's); undefined when there is none to choose. */
  private async chooseSideSlot(): Promise<number | undefined> {
    const provider = activeProvider();
    await this.mainSlotProbe;
    const model = encodeURIComponent(this.currentModel);
    const response = await this.slotFetch(
      `${provider.rootUrl}/slots?model=${model}`,
      { headers: provider.headers },
      this.slotRequestTimeoutMs,
    );
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (!Array.isArray(body)) return undefined;
    return chooseSlot(body as Slot[], this.mainSlot);
  }

  /** Note which slot the main conversation runs on (the one a call outside side work just used), so side work never takes it over. */
  private async noteMainSlot(): Promise<void> {
    try {
      const provider = activeProvider();
      const response = await this.slotFetch(
        `${provider.rootUrl}/slots?model=${encodeURIComponent(this.currentModel)}`,
        { headers: provider.headers },
        this.slotRequestTimeoutMs,
      );
      if (!response.ok) return;
      const body: unknown = await response.json();
      if (Array.isArray(body)) this.mainSlot = slotJustUsed(body as Slot[]) ?? this.mainSlot;
    } catch {
      // The heuristic (the slot used last) still applies.
    }
  }

  private async slotFetch(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await Promise.race([
        fetch(url, { ...init, signal: controller.signal }),
        new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () =>
              reject(
                new DOMException("slot request timed out", "TimeoutError"),
              ),
            { once: true },
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The current active model id.
   */
  getModel(): string {
    return this.currentModel;
  }

  /**
   * Change the active model.
   */
  setModel(name: string): void {
    this.currentModel = name;
  }

  /**
   * The active `reasoning_effort` level, or `undefined` when none is set
   * (the request omits the field and the template default applies).
   */
  getReasoningEffort(): ReasoningEffort | undefined {
    return this.reasoningEffort;
  }

  /**
   * Set the active `reasoning_effort` level. Pass `undefined` or `"default"`
   * to fall back to the chat template's built-in default.
   */
  setReasoningEffort(effort: ReasoningEffort | undefined): void {
    this.reasoningEffort = effort;
  }

  /**
   * Whether a model can see images: the server (in router mode) lists a
   * multimodal projector among the model's arguments, or (single model) its
   * `/props` report vision. False when that cannot be found out.
   */
  async supportsVision(model: string = this.currentModel): Promise<boolean> {
    const provider = activeProvider();
    const headers = provider.headers;
    try {
      if (!provider.llamaCpp) {
        return (await this.hostedInfo(model))?.vision === true;
      }
      const listed = await fetch(provider.modelsUrl, { headers });
      if (listed.ok) {
        const body = (await listed.json()) as {
          data?: { id: string; status?: { args?: string[] } }[];
        };
        const args = body.data?.find((m) => m.id === model)?.status?.args;
        if (args) return args.some((a) => a === "--mmproj" || a === "-mm");
      }
      const props = await fetch(
        `${provider.rootUrl}/props?model=${encodeURIComponent(model)}`,
        { headers },
      );
      if (!props.ok) return false;
      const info = (await props.json()) as {
        modalities?: { vision?: boolean };
      };
      return info.modalities?.vision === true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch the list of available model ids from the server via `GET /v1/models`.
   */
  async listModels(): Promise<Result<string[]>> {
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

  /**
   * The server's token count of the most recent prompt sent via `chat`.
   * `undefined` until the first successful `chat` returns a `usage` block.
   */
  lastPromptTokensUsed(): number | undefined {
    return this.lastPromptTokens;
  }

  /**
   * The model's maximum context window in tokens, as reported live by the
   * server via `GET /slots?model=<id>` (`n_ctx` on each slot).
   */
  /** After a call: tell the generation sink how full its prompt made the context window (not waited for). */
  private async reportUsage(request: number, purpose: CallPurpose, used: number): Promise<void> {
    const max = await this.contextMax().catch(() => undefined);
    if (max?.ok) this.generationSink?.({ request, purpose, tokens: 0, done: true, used, max: max.value });
  }

  /** What a hosted provider's `/models` says about one model (window, vision); cached, undefined when unknown. */
  private async hostedInfo(model: string): Promise<ModelInfo | undefined> {
    const cached = this.infoCache.get(model);
    if (cached) return cached;
    const provider = activeProvider();
    const res = await fetch(provider.modelsUrl, { headers: provider.headers });
    if (!res.ok) return undefined;
    const info = modelInfo(await res.json(), model);
    if (info) this.infoCache.set(model, info);
    return info;
  }

  async contextMax(): Promise<Result<number>> {
    const provider = activeProvider();
    if (!provider.llamaCpp) {
      try {
        const info = await this.hostedInfo(this.currentModel);
        if (info?.contextLength !== undefined) {
          return { ok: true, value: info.contextLength };
        }
        return {
          ok: false,
          error: { kind: "malformed", body: "model list had no context_length" },
        };
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
    try {
      const res = await fetch(
        `${provider.rootUrl}/slots?model=${encodeURIComponent(this.currentModel)}`,
        {
          method: "GET",
          headers: provider.headers,
        },
      );
      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          error: { kind: "http", status: res.status, body: text },
        };
      }
      const slots = (await res.json()) as Slot[];
      const first =
        Array.isArray(slots) && slots.length > 0 ? slots[0] : undefined;
      const nCtx = first?.n_ctx;
      if (nCtx === undefined) {
        return {
          ok: false,
          error: {
            kind: "malformed",
            body: "slots response had no n_ctx",
          },
        };
      }
      return { ok: true, value: nCtx };
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
  private applyReasoningEffort(body: Record<string, unknown>): void {
    // `reasoning_effort` is forwarded to the Jinja chat template. `default`
    // (and the unset case) omit the field so the template uses its built-in
    // default; every other level — including `none`, which disables
    // reasoning — is sent through.
    Object.assign(
      body,
      reasoningFields(activeProvider(), this.reasoningEffort),
    );
  }

  /** One model call, recorded in the audit log whatever its outcome. */
  async chat(
    ...args: Parameters<LlmClient["send"]>
  ): Promise<Result<AssistantMessage>> {
    const purpose = args[9] ?? "reply";
    const trace = this.calls.start(
      new CallTrace(++this.requestSeq, purpose, this.currentModel),
    );
    const stopRecording = recordCallStart(this.auditSink, trace);
    const [m, t, onToken, onThinking, onProgress, schema, signal, enabled, act] = args;
    let result: Result<AssistantMessage>;
    try {
      result = await this.send(m, t, onToken, onThinking, onProgress, schema, signal, enabled, act, purpose, trace);
    } finally {
      stopRecording();
    }
    recordCallEnd(this.auditSink, trace, result, this.lastPromptTokens);
    this.calls.finish(trace);
    // A reply that calls tools may start side work next: the slot it ran on is the main one.
    if (
      this.sideDepth === 0 &&
      purpose === "reply" &&
      result.ok &&
      (result.value.tool_calls?.length ?? 0) > 0 &&
      activeProvider().llamaCpp
    ) {
      this.mainSlotProbe = this.noteMainSlot();
    }
    return result;
  }

  /** The JSON body of a chat request: the conversation, the tool grammar, the reply format, and the slot side work is pinned to. */
  private requestBody(
    messages: Message[],
    tools: Tool[] | undefined,
    responseSchema: Record<string, unknown> | undefined,
    isToolEnabled: ((name: string) => boolean) | undefined,
    act: boolean,
  ): Record<string, unknown> {
    const useTools = !!tools && tools.length > 0 && !responseSchema;
    const provider = activeProvider();
    const body: Record<string, unknown> = {
      model: this.currentModel,
      // A schema-constrained request (a one-off question about the conversation)
      // still encodes the conversation as the tool protocol does, so it shares
      // the prompt prefix, and llama.cpp's cache, with the normal turns.
      messages:
        tools && tools.length > 0
          ? encodeMessages(messages, tools, this.imageResolver)
          : plainMessages(messages, this.imageResolver),
      ...(act ? { stream: false } : STREAM_FIELDS),
      ...(!act && provider.llamaCpp ? LLAMA_STREAM_FIELDS : {}),
    };
    // Only llama.cpp understands the grammar that constrains tool calls.
    if (useTools && provider.llamaCpp) {
      Object.assign(body, toolRequestFields(tools, isToolEnabled, act));
    }
    if (responseSchema) {
      body.response_format = responseFormat(provider, responseSchema);
    }
    this.applyReasoningEffort(body);
    // The server's own limit on one call (the guard stops a loop sooner).
    if (config.maxCallTokens > 0) body.max_tokens = config.maxCallTokens;
    if (this.sideSlot !== undefined && provider.llamaCpp) body.id_slot = this.sideSlot;
    return body;
  }

  private async send(
    messages: Message[],
    tools?: Tool[],
    onToken?: (token: string) => void,
    onThinking?: (token: string) => void,
    onPromptProgress?: (progress: PromptProgress) => void,
    responseSchema?: Record<string, unknown>,
    signal?: AbortSignal,
    isToolEnabled?: (name: string) => boolean,
    act = false,
    purpose: CallPurpose = "reply",
    trace?: CallTrace,
  ): Promise<Result<AssistantMessage>> {
    // Tools travel as stable prompt text plus a per-request grammar (see
    // tool-protocol.ts), never as the `tools` field: the grammar is not part
    // of the prompt, so toggling a tool leaves the KV cache intact.
    const useTools = !!tools && tools.length > 0 && !responseSchema;
    const request = trace?.request ?? ++this.requestSeq;
    const body = this.requestBody(
      messages,
      tools,
      responseSchema,
      isToolEnabled,
      act,
    );
    // An act round shows the user nothing; its reasoning is only captured.
    const thought = collectThinking(act ? undefined : onThinking);
    // The runaway guard aborts the call through its own controller, chained to the turn's signal.
    const guard = new AbortController();
    const callSignal = signal ? AbortSignal.any([signal, guard.signal]) : guard.signal;
    try {
      const res = await fetch(activeProvider().chatUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...activeProvider().headers,
        },
        body: JSON.stringify(body),
        signal: callSignal,
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false, error: { kind: "http", status: res.status, body: text } };
      }
      const stream = res.body;
      if (!stream) {
        return { ok: false, error: { kind: "malformed", body: "empty response body" } };
      }
      const baseThinking = useTools ? thought.sink : onThinking;
      const thinking = trace ? traceThinking(trace, baseThinking) : baseThinking;
      const generation =
        this.generationSink && !act
          ? generationReporter(this.generationSink, request, purpose)
          : undefined;
      const listener = trace && !act ? traceListener(trace, generation, guard) : generation;
      const acc = await readReply(
        act
          ? () => readJsonReply(res, thinking)
          : () =>
              streamChat(
                stream,
                useTools ? hideCalls(onToken) : onToken,
                thinking,
                this.reporter(request, purpose, onPromptProgress),
                callSignal,
                listener,
              ),
        generation,
      );
      if (generation && acc.usage !== undefined) void this.reportUsage(request, purpose, acc.usage);
      const cut = runawayError(noteServerCut(trace));
      if (cut) return { ok: false, error: cut };
      if (!acc.sawData) {
        return {
          ok: false,
          error: { kind: "malformed", body: "stream returned no data" },
        };
      }
      this.lastPromptTokens = acc.usage;
      if (useTools) {
        return {
          ok: true,
          value: {
            ...parseReply(acc.message, thought.text(), act),
            ...(act ? { confidence: nameConfidence(acc.logprobs) } : {}),
          },
        };
      }
      return { ok: true, value: acc.message };
    } catch (err) {
      // An abort by the guard surfaces as a failed read: say what it really was.
      const cut = runawayError(trace);
      if (cut) return { ok: false, error: cut };
      return {
        ok: false,
        error: {
          kind: "network",
          cause: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
