import { config } from "../config.ts";
import {
  encodeMessages,
  type ImageResolver,
  plainMessages,
  hideCalls,
  nameConfidence,
  parseReply,
  toolRequestFields,
} from "./tool-protocol.ts";
import { collectThinking, readJsonReply, streamChat } from "./stream-reader.ts";

export { streamChat };
import type { Client, Tool } from "../core/engine.ts";
import type {
  AssistantMessage,
  Message,
  PromptProgress,
  Result,
} from "../core/errors.ts";

/** The inference backend label reported by the `self` tool. */
export const BACKEND = "llama.cpp";

interface Slot {
  id: number;
  n_ctx: number;
  n_prompt_tokens?: number;
  is_processing?: boolean;
}

interface SlotStateResult {
  n_saved?: number;
  n_restored?: number;
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
export const REASONING_EFFORTS = [
  "default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export class LlmClient implements Client {
  private lastPromptTokens: number | undefined;
  private currentModel: string = config.llmModel;
  /** Turns the pictures in the conversation into what is sent to the model (set by the edge, which owns the image files). */
  imageResolver?: ImageResolver;
  /**
   * The active `reasoning_effort` level. `undefined` (or `"default"`) means
   * the field is omitted from the request so the chat template uses its
   * built-in default; any other value is forwarded as `reasoning_effort`.
   */
  private reasoningEffort: ReasoningEffort | undefined;
  private slotCacheDepth = 0;
  private readonly slotRequestTimeoutMs: number;

  constructor(slotRequestTimeoutMs = config.slotRequestTimeoutMs) {
    this.slotRequestTimeoutMs = slotRequestTimeoutMs;
  }

  /** Run an operation while best-effort preserving populated llama.cpp slots. */
  async withPreservedSlotCache<T>(operation: () => Promise<T>): Promise<T> {
    const depth = this.slotCacheDepth++;
    let saved: { id: number; filename: string }[] = [];
    try {
      saved = await this.savePopulatedSlots(depth);
    } catch {
      // Slot endpoints and slot saving may be disabled; run without snapshots.
    }
    try {
      return await operation();
    } finally {
      for (const slot of saved) {
        try {
          await this.restoreSlot(slot.id, slot.filename);
        } catch {
          // Cache preservation is best-effort and must not mask the operation.
        }
      }
      this.slotCacheDepth -= 1;
    }
  }

  private async savePopulatedSlots(
    depth: number,
  ): Promise<{ id: number; filename: string }[]> {
    const model = encodeURIComponent(this.currentModel);
    const response = await this.slotFetch(
      `${config.llmBaseUrl}/slots?model=${model}&include_slots=true`,
      {
        headers: { authorization: `Bearer ${config.llmApiKey}` },
      },
      this.slotRequestTimeoutMs,
    );
    if (!response.ok) return [];
    const body: unknown = await response.json();
    const slots = Array.isArray(body)
      ? (body as Slot[])
      : typeof body === "object" &&
          body !== null &&
          Array.isArray((body as { slots?: unknown }).slots)
        ? (body as { slots: Slot[] }).slots
        : [];
    if (!Array.isArray(slots)) return [];

    const saved: { id: number; filename: string }[] = [];
    for (const slot of slots) {
      if (
        !Number.isInteger(slot.id) ||
        (slot.n_prompt_tokens ?? 0) <= 0 ||
        slot.is_processing === true
      ) {
        continue;
      }
      const filename = `vise-${process.pid}-subagent-${depth}-slot-${slot.id}.bin`;
      try {
        const result = await this.slotAction(slot.id, "save", filename);
        if ((result.n_saved ?? 0) > 0) saved.push({ id: slot.id, filename });
      } catch {
        // Continue saving other slots when one slot cannot be preserved.
      }
    }
    return saved;
  }

  private async restoreSlot(id: number, filename: string): Promise<void> {
    await this.slotAction(id, "restore", filename);
  }

  private async slotAction(
    id: number,
    action: "save" | "restore",
    filename: string,
  ): Promise<SlotStateResult> {
    const model = encodeURIComponent(this.currentModel);
    const response = await this.slotFetch(
      `${config.llmBaseUrl}/slots/${id}?action=${action}&model=${model}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.llmApiKey}`,
        },
        body: JSON.stringify({ filename, model: this.currentModel }),
      },
      this.slotRequestTimeoutMs,
    );
    if (!response.ok) return {};
    return (await response.json()) as SlotStateResult;
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
    const headers = { authorization: `Bearer ${config.llmApiKey}` };
    try {
      const listed = await fetch(`${config.llmBaseUrl}/v1/models`, {
        headers,
      });
      if (listed.ok) {
        const body = (await listed.json()) as {
          data?: { id: string; status?: { args?: string[] } }[];
        };
        const args = body.data?.find((m) => m.id === model)?.status?.args;
        if (args) return args.some((a) => a === "--mmproj" || a === "-mm");
      }
      const props = await fetch(
        `${config.llmBaseUrl}/props?model=${encodeURIComponent(model)}`,
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
      const res = await fetch(`${config.llmBaseUrl}/v1/models`, {
        method: "GET",
        headers: { authorization: `Bearer ${config.llmApiKey}` },
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
  async contextMax(): Promise<Result<number>> {
    try {
      const res = await fetch(
        `${config.llmBaseUrl}/slots?model=${encodeURIComponent(this.currentModel)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${config.llmApiKey}` },
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
    if (
      this.reasoningEffort !== undefined &&
      this.reasoningEffort !== "default"
    ) {
      body.reasoning_effort = this.reasoningEffort;
    }
  }

  async chat(
    messages: Message[],
    tools?: Tool[],
    onToken?: (token: string) => void,
    onThinking?: (token: string) => void,
    onPromptProgress?: (progress: PromptProgress) => void,
    responseSchema?: Record<string, unknown>,
    signal?: AbortSignal,
    isToolEnabled?: (name: string) => boolean,
    act = false,
  ): Promise<Result<AssistantMessage>> {
    // Tools travel as stable prompt text plus a per-request grammar (see
    // tool-protocol.ts), never as the `tools` field: the grammar is not part
    // of the prompt, so toggling a tool leaves the KV cache intact.
    const useTools = !!tools && tools.length > 0 && !responseSchema;
    const body: Record<string, unknown> = {
      model: this.currentModel,
      // A schema-constrained request (a one-off question about the conversation)
      // still encodes the conversation as the tool protocol does, so it shares
      // the prompt prefix, and llama.cpp's cache, with the normal turns.
      messages:
        tools && tools.length > 0
          ? encodeMessages(messages, tools, this.imageResolver)
          : plainMessages(messages, this.imageResolver),
      ...(act
        ? { stream: false }
        : {
            stream: true,
            stream_options: { include_usage: true },
            return_progress: true,
          }),
    };
    if (useTools) {
      Object.assign(body, toolRequestFields(tools, isToolEnabled, act));
    }
    // An act round shows the user nothing; its reasoning is only captured.
    const thought = collectThinking(act ? undefined : onThinking);
    if (responseSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { schema: responseSchema },
      };
    }
    this.applyReasoningEffort(body);
    try {
      const res = await fetch(config.llmChatUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.llmApiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          error: { kind: "http", status: res.status, body: text },
        };
      }
      const stream = res.body;
      if (!stream) {
        return {
          ok: false,
          error: { kind: "malformed", body: "empty response body" },
        };
      }
      const thinking = useTools ? thought.sink : onThinking;
      const acc = act
        ? await readJsonReply(res, thinking)
        : await streamChat(
            stream,
            useTools ? hideCalls(onToken) : onToken,
            thinking,
            onPromptProgress,
            signal,
          );
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
