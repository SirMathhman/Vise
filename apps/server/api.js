import { getListing, getFileContent, repoRoot } from "./listing.js";
import { resolveWithin } from "./pathGuard.js";
import { sendChatMessages } from "./chat.js";
import { TOOLS } from "./tools.js";

/**
 * Handles API requests and writes the JSON response directly. Supports:
 *   GET  /api/listing[?path=relative/path] -> JSON array of entries (name, isDirectory).
 *   GET  /api/file?path=relative/path      -> JSON { content: string }.
 *   POST /api/chat { messages }            -> JSON { reply: string }.
 */
export async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/listing") {
    return run(res, async () => {
      const dir = resolveWithin(repoRoot, url.searchParams.get("path") ?? "");
      if (!dir) return sendJson(res, 400, { error: "Invalid path" });
      return sendJson(res, 200, await getListing(dir));
    });
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    return run(res, async () => {
      const filePath = resolveWithin(
        repoRoot,
        url.searchParams.get("path") ?? "",
      );
      if (!filePath) return sendJson(res, 400, { error: "Invalid path" });
      return sendJson(res, 200, { content: await getFileContent(filePath) });
    });
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    return run(res, async () => {
      const body = await readJsonBody(req);
      const messages = normalizeMessages(body.messages);
      if (!messages) return sendJson(res, 400, { error: "Missing messages" });
      await streamChat(res, messages);
    });
  }

  return sendJson(res, 404, { error: "Not found" });
}

/**
 * Sends a JSON response.
 * @param {import("node:http").ServerResponse} res - The response.
 * @param {number} status - The HTTP status code.
 * @param {unknown} payload - The value to serialize as JSON.
 */
function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

// SSE event names for the chat stream protocol. The client in
// apps/web/src/api.js mirrors these; keep them in sync.
const SSE_DELTA = "delta";
const SSE_REASONING = "reasoning";
const SSE_FILE_EDIT = "file_edit";
const SSE_DONE = "done";
const SSE_ERROR = "error";

/**
 * Streams a chat reply to the client as Server-Sent Events. Content deltas
 * are sent as they arrive from the LLM; the final event carries the complete
 * reply and any tool calls the model made.
 * @param {import("node:http").ServerResponse} res - The response.
 * @param {Array<{role: string, content: string}>} messages - The conversation.
 */
async function streamChat(res, messages) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const send = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const { reply, reasoning, toolCalls } = await sendChatMessages(
      messages,
      TOOLS,
      (delta) => send(SSE_DELTA, { delta }),
      (delta) => send(SSE_REASONING, { delta }),
      (file) => send(SSE_FILE_EDIT, file),
    );
    send(SSE_DONE, { reply, reasoning, toolCalls });
  } catch (err) {
    send(SSE_ERROR, { error: err.message });
  }
  res.end();
}

/**
 * Runs an async handler, sending a 500 JSON error if it throws.
 * @param {import("node:http").ServerResponse} res - The response.
 * @param {() => Promise<void>} fn - The handler to run.
 */
async function run(res, fn) {
  try {
    await fn();
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

/**
 * Reads and parses a JSON request body.
 * @param {import("node:http").IncomingMessage} req - The request.
 * @returns {Promise<object>} The parsed body (empty object if none).
 */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

/**
 * Validates and sanitizes a conversation into a list of { role, content }.
 * Returns null if it is not a non-empty array of valid messages.
 * @param {unknown} value - The raw `messages` value from the request body.
 * @returns {Array<{role: string, content: string}> | null}
 */
function normalizeMessages(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const messages = value
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string",
    )
    .map((m) => ({ role: m.role, content: m.content }));
  return messages.length ? messages : null;
}
