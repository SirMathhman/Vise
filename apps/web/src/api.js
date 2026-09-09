/**
 * Frontend network layer: thin wrappers around the backend's `/api/*` routes.
 * Keeping all fetch calls here isolates the network concern from state and
 * rendering, and makes the API surface easy to test without a DOM.
 */

/**
 * Sends the conversation to the LLM via the backend and returns the reply.
 * @param {Array<{role: string, content: string}>} messages - The conversation.
 * @returns {Promise<string>} The model's reply.
 */
export async function sendChat(messages) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed: ${res.status}`);
  return data.reply;
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
