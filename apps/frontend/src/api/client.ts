/**
 * Typed fetch wrapper for the backend API. Each function returns parsed data
 * or throws an `Error` with the server-provided message (falling back to the
 * HTTP status). Views call these instead of `fetch` directly so that JSON
 * parsing and error normalization live in one place.
 */
import type { LlmToolName } from "@vise/shared";

export interface DirEntry {
  name: string;
  kind: "file" | "directory";
}

export interface LsResponse {
  path: string;
  items: DirEntry[];
}

export interface FileResponse {
  path: string;
  size: number;
  content: string;
}

/** A model served by the LLM proxy (see `/llm/v1/models`). */
export interface LlmModel {
  id: string;
  /** The model's context window in tokens, if the proxy reports it. */
  context?: number;
}

/** GET the backend health status. */
export async function health(): Promise<string> {
  const res = await fetch("/api/health");
  if (!res.ok) return fail(res);
  const data = (await res.json()) as { status: string };
  return data.status;
}

function encodeRel(rel: string): string {
  return rel.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** Fetch a normalized error message from a failed response. */
async function fail(res: Response): Promise<never> {
  const data = (await res.json().catch(() => null)) as {
    message?: string;
  } | null;
  throw new Error(data?.message ?? `HTTP ${res.status}`);
}

/** A debounced filesystem change pushed over the watch stream. */
export interface WatchEvent {
  /** Relative path from the root, forward-slash separated. */
  path: string;
  /** The raw fs event kind that produced it. */
  event: "change" | "rename";
}

/**
 * Subscribe to live filesystem changes via the SSE stream at `/api/watch`.
 * Returns an unsubscribe function that closes the stream. `EventSource`
 * auto-reconnects, so transient drops heal without caller help.
 */
export function subscribeToChanges(
  onEvent: (e: WatchEvent) => void
): () => void {
  const source = new EventSource("/api/watch");
  source.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as WatchEvent);
    } catch {
      // Ignore malformed frames; the stream keeps going.
    }
  };
  return () => source.close();
}

/** GET the listing for a directory ("" = root). */
export async function listDir(rel: string): Promise<LsResponse> {
  const res = await fetch(`/api/ls/${encodeRel(rel)}`);
  if (!res.ok) return fail(res);
  return (await res.json()) as LsResponse;
}

/** GET the contents of a file. */
export async function getFile(rel: string): Promise<FileResponse> {
  const res = await fetch(`/api/file/${encodeRel(rel)}`);
  if (!res.ok) return fail(res);
  return (await res.json()) as FileResponse;
}

/** PUT new contents to a file. */
export async function putFile(rel: string, content: string): Promise<void> {
  const res = await fetch(`/api/file/${encodeRel(rel)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) return fail(res);
}

/** DELETE a file. */
export async function deleteFile(rel: string): Promise<void> {
  const res = await fetch(`/api/file/${encodeRel(rel)}`, {
    method: "DELETE",
  });
  if (!res.ok) return fail(res);
}

/**
 * POST a create request for a file or directory in `parentRel`. Throws on
 * failure so the caller can surface the error.
 */
export async function createEntry(
  kind: "file" | "directory",
  parentRel: string,
  name: string
): Promise<void> {
  const rel = parentRel ? `${parentRel}/${name}` : name;
  const endpoint = kind === "directory" ? "/api/dir" : "/api/file";
  const payload =
    kind === "directory" ? { path: rel } : { path: rel, content: "" };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return fail(res);
}

/**
 * The LLM proxy (llama.cpp at :8080) requires a bearer token. This is a
 * local-use key: the Vite dev proxy forwards to 127.0.0.1, so the key never
 * leaves the machine.
 */
const LLM_API_KEY = "S6677k5w355Nw9ErxCZWYCMiW4ItldmzXBLUElpnLsdE8gBj5A";

/** GET the models served by the LLM proxy. */
export async function listLlmModels(): Promise<LlmModel[]> {
  const res = await fetch("/llm/v1/models", {
    headers: { Authorization: `Bearer ${LLM_API_KEY}` },
  });
  if (!res.ok) return fail(res);
  const data = (await res.json()) as {
    data?: { id: string; meta?: { n_ctx?: number } }[];
  };
  return (data.data ?? []).map((m) => ({
    id: m.id,
    context: m.meta?.n_ctx,
  }));
}

/** A single turn in a chat conversation, in OpenAI-compatible wire format. */
export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Present on assistant messages that request tool invocations. */
  tool_calls?: LlmToolCall[];
  /** On `tool` messages, the id of the call this result answers. */
  tool_call_id?: string;
}

/** A function call the model asked to run. */
export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Token accounting for a single completion, as reported by the proxy. */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** The model's reply for one turn: either text or a set of tool calls. */
export interface LlmAssistantMessage {
  content: string | null;
  tool_calls?: LlmToolCall[];
  /** The model's chain-of-thought, if the proxy streams it. */
  reasoning?: string | null;
  /** Tokens consumed by the last completion (the prompt that was sent). */
  usage?: LlmUsage;
}

/** An OpenAI-compatible tool definition. */
export interface LlmTool {
  type: "function";
  function: {
    /** One of the shared LLM tool names; checked against the backend. */
    name: LlmToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** POST a chat completion and return the assistant's reply (text and/or tool calls). */
export async function sendLlmMessage(
  messages: LlmMessage[],
  model: string,
  tools?: LlmTool[]
): Promise<LlmAssistantMessage> {
  const body: Record<string, unknown> = { model, messages };
  if (tools && tools.length > 0) body.tools = tools;
  const res = await fetch("/llm/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return fail(res);
  const data = (await res.json()) as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: LlmToolCall[];
      };
    }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    };
  };
  const message = data.choices?.[0]?.message;
  return {
    content: message?.content ?? null,
    tool_calls: message?.tool_calls,
    usage: data.usage
      ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

/**
 * POST a streaming chat completion and call `onTextChunk` with the cumulative
 * text each time a new text delta arrives. Returns the complete assistant
 * reply (text and/or tool calls) when the stream ends. Unlike `sendLlmMessage`,
 * this sends `stream: true` and parses the SSE response incrementally.
 *
 * `signal`, when given, lets the caller cancel generation early (e.g. a Stop
 * button). Aborting does not reject the returned promise: whatever text and
 * reasoning were accumulated before the abort are returned normally, so the
 * caller can treat an interrupted reply the same as a short complete one
 * instead of having to special-case a thrown `AbortError`.
 */
export async function streamLlmMessage(
  messages: LlmMessage[],
  model: string,
  tools: LlmTool[] | undefined,
  onTextChunk: (text: string) => void,
  onReasoningChunk: (text: string) => void,
  signal?: AbortSignal
): Promise<LlmAssistantMessage> {
  const body: Record<string, unknown> = { model, messages, stream: true };
  if (tools && tools.length > 0) body.tools = tools;
  let buffer = "";
  let content = "";
  let reasoning = "";
  const toolCalls: LlmToolCall[] = [];
  let lastUsage: LlmUsage | undefined;

  const handleChunk = (json: Record<string, unknown>): void => {
    const choice = (
      json.choices as
        | {
            delta?: {
              content?: string;
              reasoning_content?: string;
              tool_calls?: LlmToolCall[];
            };
          }[]
        | undefined
    )?.[0];
    const delta = choice?.delta;
    if (delta?.content) {
      content += delta.content;
      onTextChunk(content);
    }
    if (delta?.reasoning_content) {
      reasoning += delta.reasoning_content;
      onReasoningChunk(reasoning);
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = (tc as { index?: number }).index ?? 0;
        if (!toolCalls[idx]) {
          toolCalls[idx] = {
            id: tc.id ?? "",
            type: "function",
            function: { name: "", arguments: "" },
          };
        }
        const existing = toolCalls[idx];
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.function.name += tc.function.name;
        if (tc.function?.arguments)
          existing.function.arguments += tc.function.arguments;
      }
    }
    const usage = json.usage as
      | {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
        }
      | undefined;
    if (usage) {
      lastUsage = {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
      };
    }
  };

  const processBuffer = (): void => {
    for (;;) {
      const sep = buffer.indexOf("\n\n");
      if (sep < 0) break;
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = frame.trim();
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        handleChunk(JSON.parse(payload) as Record<string, unknown>);
      } catch {
        // Skip malformed frames; the stream keeps going.
      }
    }
  };

  try {
    const res = await fetch("/llm/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) return fail(res);
    if (!res.body) {
      // No readable body (e.g. a proxy that stripped the stream); fall back to
      // the non-streaming path so the caller still gets a complete reply.
      return await sendLlmMessage(messages, model, tools);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      processBuffer();
    }
    processBuffer();
  } catch (err) {
    // A caller-initiated abort (a Stop button) ends generation early rather
    // than failing the turn: return whatever was accumulated so far, exactly
    // as if the model had produced a short, complete reply.
    if (!(err instanceof DOMException && err.name === "AbortError")) throw err;
  }
  const calls = toolCalls.filter((t) => t.id !== "");
  return {
    content: content || null,
    tool_calls: calls.length > 0 ? calls : undefined,
    reasoning: reasoning || null,
    usage: lastUsage,
  };
}

/**
 * Execute a tool call on the backend and return the model-readable result
 * string. Errors come back as text (the backend resolves them to a string) so
 * the tool loop can feed them straight back to the model.
 */
export async function executeLlmTool(tc: LlmToolCall): Promise<string> {
  const res = await fetch("/api/llm/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: tc.function.name,
      arguments: tc.function.arguments,
    }),
  });
  if (!res.ok) return fail(res);
  const data = (await res.json()) as { result: string };
  return data.result;
}

/** stdout/stderr kept separate, unlike run_command's combined model text. */
export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

/**
 * Run a PowerShell command in the workspace root and return its stdout and
 * stderr separately. Used by the panel's end-of-turn hook, which needs to
 * tell the two apart to decide whether to block the turn — unlike the
 * run_command LLM tool (`executeLlmTool`), which returns one combined,
 * model-formatted string.
 */
export async function runShellCommand(
  command: string
): Promise<ShellCommandResult> {
  const res = await fetch("/api/llm/hook-command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
  if (!res.ok) return fail(res);
  return (await res.json()) as ShellCommandResult;
}
