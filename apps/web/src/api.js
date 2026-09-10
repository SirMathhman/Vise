/**
 * Frontend network layer: thin wrappers around the backend's `/api/*` routes.
 * Keeping all fetch calls here isolates the network concern from state and
 * rendering, and makes the API surface easy to test without a DOM.
 */

/**
 * Sends the conversation to the LLM via the backend and streams the reply
 * back. Content deltas are forwarded to `onDelta` as they arrive; the
 * resolved value carries the complete reply and any tool calls the model
 * made.
 * @param {Array<{role: string, content: string}>} messages - The conversation.
 * @param {(delta: string) => void} [onDelta] - Optional callback for streamed content.
 * @returns {Promise<{reply: string, toolCalls: Array<{name: string, args: object}>}>}
 */
export async function sendChat(messages, onDelta) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? `Request failed: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sepIdx;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      const parsed = data ? JSON.parse(data) : {};
      if (event === "delta") {
        reply += parsed.delta ?? "";
        onDelta?.(parsed.delta ?? "");
      } else if (event === "done") {
        return {
          reply: parsed.reply ?? reply,
          toolCalls: parsed.toolCalls ?? [],
        };
      } else if (event === "error") {
        throw new Error(parsed.error ?? "Request failed");
      }
    }
  }

  return { reply, toolCalls: [] };
}

/**
 * Fetches the text content of a file from the backend.
 * @param {string} path - The file's relative path.
 * @returns {Promise<string>} The file's text content.
 */
export async function fetchFileContent(path) {
  const url = `/api/file?path=${encodeURIComponent(path)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  const data = await res.json();
  return data.content;
}

/**
 * Fetches directory entries for a given path from the backend.
 * @param {string} path - The relative path to list.
 * @returns {Promise<Array<{name: string, isDirectory: boolean}>>}
 */
export async function fetchEntries(path = "") {
  const url = path
    ? `/api/listing?path=${encodeURIComponent(path)}`
    : "/api/listing";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}
