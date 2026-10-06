import type { Client, Tool } from "../core/engine.ts";
import type {
  AssistantMessage,
  Message,
  PromptProgress,
  Result,
} from "../core/errors.ts";

const URL = "http://localhost:8080/v1/chat/completions";
const API_KEY = "S6677k5w355Nw9ErxCZWYCMiW4ItldmzXBLUElpnLsdE8gBj5A";
const MODEL =
  "RentedNoodle/Qwen3.8-27B-OrcaRouter-GSQ-RCO-IQ3_XXS-Uncensored:QATFA";
/** The inference backend label reported by the `self` tool. */
export const BACKEND = "llama.cpp";

interface ToolCall {
  type: "function";
  id: string;
  function: { name: string; arguments: string };
}

interface Usage {
  prompt_tokens?: number;
}

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

/** A single streamed tool-call delta, accumulated by index across chunks. */
interface StreamToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

/** The `delta` field of one streaming choice. */
interface StreamDelta {
  content?: string;
  reasoning_content?: string;
  tool_calls?: StreamToolCallDelta[];
}

/** One choice in a streaming chunk. */
interface StreamChoice {
  delta: StreamDelta;
}

/** One SSE `data:` payload from the chat completions stream. */
interface StreamChunk {
  choices?: StreamChoice[];
  usage?: Usage;
  prompt_progress?: PromptProgress;
}

/**
 * Parse the SSE chat-completions stream, accumulating the assistant message
 * and invoking `onToken` for each content delta. Returns the final message,
 * the last seen `usage.prompt_tokens`, and whether any data payload arrived.
 *
 * Exported for testing: it is the edge's SSE parser and is exercised with a
 * synthetic stream in `test/llm.test.ts`.
 */
export async function streamChat(
  stream: ReadableStream<Uint8Array>,
  onToken?: (token: string) => void,
  onThinking?: (token: string) => void,
  onPromptProgress?: (progress: PromptProgress) => void,
  signal?: AbortSignal,
): Promise<{ message: AssistantMessage; usage?: number; sawData: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: number | undefined;
  let sawData = false;
  const toolCallParts = new Map<number, ToolCall>();

  const handleData = (line: string) => {
    if (line === "" || !line.startsWith("data:")) return;
    const payload = line.slice("data:".length).trim();
    if (payload === "[DONE]") return;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload) as StreamChunk;
    } catch {
      return;
    }
    sawData = true;
    if (chunk.prompt_progress) {
      onPromptProgress?.(chunk.prompt_progress);
    }
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;
    const reasoning = delta?.reasoning_content;
    if (reasoning && reasoning !== "") {
      onThinking?.(reasoning);
    }
    const piece = delta?.content;
    if (piece && piece !== "") {
      content += piece;
      onToken?.(piece);
    }
    const deltas = delta?.tool_calls;
    if (deltas) {
      for (const tc of deltas) {
        const existing = toolCallParts.get(tc.index);
        if (existing) {
          existing.function.arguments += tc.function?.arguments ?? "";
          if (tc.function?.name) {
            existing.function.name += tc.function.name;
          }
        } else {
          toolCallParts.set(tc.index, {
            type: "function",
            id: tc.id ?? "",
            function: {
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            },
          });
        }
      }
    }
    const promptTokens = chunk.usage?.prompt_tokens;
    if (promptTokens !== undefined) usage = promptTokens;
  };

  for (;;) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      break;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      handleData(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }

  const toolCalls = [...toolCallParts.values()];
  const message: AssistantMessage = {
    content,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
  return { message, usage, sawData };
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
  private currentModel: string = MODEL;
  /**
   * The active `reasoning_effort` level. `undefined` (or `"default"`) means
   * the field is omitted from the request so the chat template uses its
   * built-in default; any other value is forwarded as `reasoning_effort`.
   */
  private reasoningEffort: ReasoningEffort | undefined;
  private slotCacheDepth = 0;
  private readonly slotRequestTimeoutMs: number;

  constructor(slotRequestTimeoutMs = 5_000) {
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
      `http://localhost:8080/slots?model=${model}&include_slots=true`,
      {
        headers: { authorization: `Bearer ${API_KEY}` },
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
      `http://localhost:8080/slots/${id}?action=${action}&model=${model}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
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
   * Fetch the list of available model ids from the server via `GET /v1/models`.
   */
  async listModels(): Promise<Result<string[]>> {
    try {
      const res = await fetch("http://localhost:8080/v1/models", {
        method: "GET",
        headers: { authorization: `Bearer ${API_KEY}` },
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
        `http://localhost:8080/slots?model=${encodeURIComponent(this.currentModel)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${API_KEY}` },
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
  async chat(
    messages: Message[],
    tools?: Tool[],
    onToken?: (token: string) => void,
    onThinking?: (token: string) => void,
    onPromptProgress?: (progress: PromptProgress) => void,
    responseSchema?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Result<AssistantMessage>> {
    const body: Record<string, unknown> = {
      model: this.currentModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      return_progress: true,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    if (responseSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { schema: responseSchema },
      };
    }
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
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
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
      const acc = await streamChat(
        stream,
        onToken,
        onThinking,
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
