// OpenAI-compatible endpoint (llama.cpp) base URL, model name, and API key.
const LLM_BASE_URL = process.env.LLM_BASE_URL || "http://localhost:8080";
const LLM_MODEL =
  process.env.LLM_MODEL ||
  "RentedNoodle/Qwen3.8-27B-OrcaRouter-GSQ-RCO-IQ3_XXS-Uncensored:0";
const LLM_API_KEY =
  process.env.LLM_API_KEY ||
  "S6677k5w355Nw9ErxCZWYCMiW4ItldmzXBLUElpnLsdE8gBj5A";

// Maximum number of tool round-trips before we force a final answer.
const MAX_TOOL_ROUNDS = 5;

/**
 * Sends a conversation to the OpenAI-compatible chat endpoint, letting the
 * model call tools until it produces a final reply. Content deltas from the
 * streamed response are forwarded to `onDelta` (and reasoning deltas to
 * `onReasoning`) as they arrive, so the client can render the reply
 * character by character, including the model's thinking.
 * @param {Array<{role: string, content: string}>} messages - The conversation.
 * @param {Array<{name: string, definition: object, execute: (args: object) => Promise<string>}>} tools - The tools the model may call.
 * @param {(delta: string) => void} [onDelta] - Optional callback invoked with each content chunk as it streams in.
 * @param {(delta: string) => void} [onReasoning] - Optional callback invoked with each reasoning (thinking) chunk as it streams in.
 * @param {(file: {path: string, content: string}) => void} [onFileEdit] - Optional callback invoked when a file-writing tool succeeds, with the file's path and new content.
 * @returns {Promise<{reply: string, reasoning: string, toolCalls: Array<{name: string, args: object}>}>} The model's reply, its thinking, and the tool calls made.
 */
export async function sendChatMessages(
  messages,
  tools,
  onDelta,
  onReasoning,
  onFileEdit,
) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const convo = [...messages];
  const toolCalls = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const message = await requestCompletion(convo, tools, onDelta, onReasoning);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      if (typeof message.content !== "string") {
        throw new Error("Unexpected response from LLM endpoint");
      }
      return {
        reply: message.content,
        reasoning: message.reasoning,
        toolCalls,
      };
    }

    convo.push(message);
    for (const call of calls) {
      const args = parseArgs(call.function?.arguments);
      const tool = byName.get(call.function?.name);
      const raw = tool
        ? await tool.execute(args)
        : `Unknown tool: ${call.function?.name}`;
      // File-writing tools return { result, file? }; others return a string.
      const result = typeof raw === "string" ? raw : raw.result;
      if (tool?.writesFile && raw?.file) onFileEdit?.(raw.file);
      toolCalls.push({
        name: call.function?.name,
        label: tool?.label,
        icon: tool?.icon,
        detail: tool?.summary?.(args) ?? "",
        args,
      });
      convo.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  // Out of tool rounds: ask for a final answer without further tools.
  const final = await requestCompletion(convo, tools, onDelta, onReasoning);
  return {
    reply: typeof final.content === "string" ? final.content : "",
    reasoning: final.reasoning,
    toolCalls,
  };
}

/**
 * Performs a single streaming chat-completions request and returns the
 * accumulated assistant message. Content chunks are forwarded to `onDelta`
 * and reasoning chunks to `onReasoning` as they arrive.
 * @param {Array<object>} convo - The conversation to send.
 * @param {Array<object>} tools - The tools to offer the model.
 * @param {(delta: string) => void} [onDelta] - Optional callback for streamed content.
 * @param {(delta: string) => void} [onReasoning] - Optional callback for streamed reasoning (thinking).
 * @returns {Promise<object>} The assistant message (content, reasoning, and/or tool_calls).
 */
async function requestCompletion(convo, tools, onDelta, onReasoning) {
  const res = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      stream: true,
      messages: convo,
      tools: tools.map((t) => t.definition),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `LLM request failed (${res.status})${text ? `: ${text}` : ""}`,
    );
  }

  const message = await parseStream(res, onDelta, onReasoning);
  if (!message || typeof message !== "object") {
    throw new Error("Unexpected response from LLM endpoint");
  }
  return message;
}

/**
 * Reads an OpenAI-compatible SSE stream, forwarding content deltas to
 * `onDelta` and reasoning (thinking) deltas to `onReasoning`, and
 * accumulates the full assistant message.
 * @param {Response} res - The streaming response from the LLM endpoint.
 * @param {(delta: string) => void} [onDelta] - Optional callback for streamed content.
 * @param {(delta: string) => void} [onReasoning] - Optional callback for streamed reasoning (thinking).
 * @returns {Promise<object>} The accumulated assistant message.
 */
async function parseStream(res, onDelta, onReasoning) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  const calls = []; // accumulated tool calls, indexed by stream position

  const handleChunk = (chunk) => {
    const delta = chunk?.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    if (
      typeof delta.reasoning_content === "string" &&
      delta.reasoning_content
    ) {
      reasoning += delta.reasoning_content;
      onReasoning?.(delta.reasoning_content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!calls[idx]) {
          calls[idx] = {
            type: "function",
            id: "",
            function: { name: "", arguments: "" },
          };
        }
        const acc = calls[idx];
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.function.name += tc.function.name;
        if (typeof tc.function?.arguments === "string") {
          acc.function.arguments += tc.function.arguments;
        }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        handleChunk(JSON.parse(payload));
      } catch {
        // Ignore malformed keep-alive chunks.
      }
    }
  }

  const toolCalls = calls.filter(Boolean);
  return {
    role: "assistant",
    content,
    reasoning,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };
}

/**
 * Parses a tool-call's arguments (a JSON string) into an object.
 * @param {unknown} raw - The raw arguments value.
 * @returns {object} The parsed arguments (empty object if none).
 */
function parseArgs(raw) {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
