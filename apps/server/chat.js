// OpenAI-compatible endpoint (llama.cpp) base URL, model name, and API key.
const LLM_BASE_URL = process.env.LLM_BASE_URL || "http://localhost:8080";
const LLM_MODEL =
  process.env.LLM_MODEL || "orcarouter/Qwen3.8-27B-Uncensored-GGUF:Q4_K_M";
const LLM_API_KEY =
  process.env.LLM_API_KEY ||
  "S6677k5w355Nw9ErxCZWYCMiW4ItldmzXBLUElpnLsdE8gBj5A";

/**
 * Sends a conversation to the OpenAI-compatible chat endpoint and returns
 * the assistant's reply text.
 * @param {Array<{role: string, content: string}>} messages - The conversation.
 * @returns {Promise<string>} The model's reply.
 */
export async function sendChatMessages(messages) {
  const res = await fetch(`${LLM_BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      stream: false,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `LLM request failed (${res.status})${text ? `: ${text}` : ""}`,
    );
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content;
  if (typeof reply !== "string") {
    throw new Error("Unexpected response from LLM endpoint");
  }
  return reply;
}
