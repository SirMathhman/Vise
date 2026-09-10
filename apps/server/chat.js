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
 * model call tools until it produces a final reply.
 * @param {Array<{role: string, content: string}>} messages - The conversation.
 * @param {Array<{name: string, definition: object, execute: (args: object) => Promise<string>}>} tools - The tools the model may call.
 * @returns {Promise<{reply: string, toolCalls: Array<{name: string, args: object}>}>} The model's reply and the tool calls made.
 */
export async function sendChatMessages(messages, tools) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const convo = [...messages];
  const toolCalls = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const message = await requestCompletion(convo, tools);

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      if (typeof message.content !== "string") {
        throw new Error("Unexpected response from LLM endpoint");
      }
      return { reply: message.content, toolCalls };
    }

    convo.push(message);
    for (const call of calls) {
      const args = parseArgs(call.function?.arguments);
      const tool = byName.get(call.function?.name);
      const result = tool
        ? await tool.execute(args)
        : `Unknown tool: ${call.function?.name}`;
      toolCalls.push({ name: call.function?.name, args });
      convo.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  // Out of tool rounds: ask for a final answer without further tools.
  const final = await requestCompletion(convo, tools);
  return {
    reply: typeof final.content === "string" ? final.content : "",
    toolCalls,
  };
}

/**
 * Performs a single chat-completions request and returns the assistant message.
 * @param {Array<object>} convo - The conversation to send.
 * @param {Array<object>} tools - The tools to offer the model.
 * @returns {Promise<object>} The assistant message (content and/or tool_calls).
 */
async function requestCompletion(convo, tools) {
  const res = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      stream: false,
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

  const data = await res.json();
  const message = data?.choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    throw new Error("Unexpected response from LLM endpoint");
  }
  return message;
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
