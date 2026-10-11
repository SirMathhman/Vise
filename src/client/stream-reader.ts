import type {
  AssistantMessage,
  PromptProgress,
  ToolCall,
} from "../core/errors.ts";
import { hideCalls, type TokenLogprob } from "./tool-protocol.ts";

interface Usage {
  prompt_tokens?: number;
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
  finish_reason?: string | null;
  logprobs?: { content?: TokenLogprob[] };
}

/** One SSE `data:` payload from the chat completions stream. */
interface StreamChunk {
  choices?: StreamChoice[];
  usage?: Usage;
  prompt_progress?: PromptProgress;
  timings?: { predicted_n?: number };
}

/** Receives what a call generates: the raw text as it streams and the server's running token count. */
export interface GenerationListener {
  text(piece: string): void;
  tokens(count: number): void;
  /** The server's reason the call ended (`stop`, `length`, `tool_calls`...), when it says. */
  finish?(reason: string): void;
}

/**
 * Parse the SSE chat-completions stream, accumulating the assistant message
 * and invoking `onToken` for each content delta. Returns the final message,
 * the last seen `usage.prompt_tokens`, and whether any data payload arrived.
 *
 * Exported for testing: it is the edge's SSE parser and is exercised with a
 * synthetic stream in `test/client/llm.test.ts`.
 */
export async function streamChat(
  stream: ReadableStream<Uint8Array>,
  onToken?: (token: string) => void,
  onThinking?: (token: string) => void,
  onPromptProgress?: (progress: PromptProgress) => void,
  signal?: AbortSignal,
  generation?: GenerationListener,
): Promise<{
  message: AssistantMessage;
  usage?: number;
  sawData: boolean;
  logprobs: TokenLogprob[];
}> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: number | undefined;
  let sawData = false;
  const toolCallParts = new Map<number, ToolCall>();
  const logprobs: TokenLogprob[] = [];

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
    for (const lp of choice?.logprobs?.content ?? []) logprobs.push(lp);
    const reasoning = delta?.reasoning_content;
    if (reasoning && reasoning !== "") {
      onThinking?.(reasoning);
    }
    const piece = delta?.content;
    if (piece && piece !== "") {
      content += piece;
      generation?.text(piece);
      onToken?.(piece);
    }
    if (choice?.finish_reason) generation?.finish?.(choice.finish_reason);
    const generated = chunk.timings?.predicted_n;
    if (generated !== undefined && generated > 0) generation?.tokens(generated);
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
  return { message, usage, sawData, logprobs };
}

/**
 * Accumulates the model's reasoning text (so a call written inside it can be
 * recovered) while forwarding it, minus any call text, to `onThinking`.
 */
export function collectThinking(onThinking?: (token: string) => void) {
  let text = "";
  const shown = hideCalls(onThinking);
  return {
    text: () => text,
    sink: (t: string) => {
      text += t;
      shown?.(t);
    },
  };
}

/**
 * Read a non-streaming chat completion into the shape `streamChat` returns.
 * Act rounds use this because llama.cpp only reports token probabilities on
 * non-streamed responses, and an act round shows the user nothing anyway.
 */
export async function readJsonReply(
  res: Response,
  onThinking?: (token: string) => void,
): Promise<Awaited<ReturnType<typeof streamChat>>> {
  const json = (await res.json()) as {
    choices?: {
      message?: { content?: string; reasoning_content?: string };
      logprobs?: { content?: TokenLogprob[] };
    }[];
    usage?: Usage;
  };
  const choice = json.choices?.[0];
  const reasoning = choice?.message?.reasoning_content;
  if (reasoning) onThinking?.(reasoning);
  return {
    message: { content: choice?.message?.content ?? "" },
    usage: json.usage?.prompt_tokens,
    sawData: json.choices !== undefined,
    logprobs: choice?.logprobs?.content ?? [],
  };
}
