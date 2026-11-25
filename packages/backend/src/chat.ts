const CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

// One streamed event from OpenRouter's chat completions endpoint.
interface ChatChunk {
  error?: { message?: string };
  choices?: { delta?: { content?: string | null } }[];
}

// Returns the text in one SSE line, or undefined for lines that carry no text.
// Blank lines, ": keep-alive" comments, and "[DONE]" are skipped.
function textFromSseLine(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return undefined;
  }
  const payload = trimmed.slice("data:".length).trim();
  if (payload === "" || payload === "[DONE]") {
    return undefined;
  }
  const chunk = JSON.parse(payload) as ChatChunk;
  if (chunk.error) {
    throw new Error(chunk.error.message ?? "OpenRouter stream failed");
  }
  return chunk.choices?.[0]?.delta?.content ?? undefined;
}

// Turns OpenRouter's SSE body into a stream of text deltas.
export function sseTextDeltas(
  body: ReadableStream<Uint8Array>,
): ReadableStream<string> {
  const decoder = new TextDecoder();
  let pending = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, string>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const text = textFromSseLine(line);
          if (text) {
            controller.enqueue(text);
          }
        }
      },
      flush(controller) {
        pending += decoder.decode();
        const text = textFromSseLine(pending);
        if (text) {
          controller.enqueue(text);
        }
      },
    }),
  );
}

// Sends one user message and returns the reply as it streams in.
export async function streamChatReply(
  apiKey: string,
  model: string,
  message: string,
): Promise<ReadableStream<string>> {
  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: message }],
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`OpenRouter responded with HTTP ${String(res.status)}`);
  }
  return sseTextDeltas(res.body);
}
