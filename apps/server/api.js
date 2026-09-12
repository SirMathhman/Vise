import { getListing, getFileContent, repoRoot } from "./listing.js";
import { resolveWithin } from "./pathGuard.js";
import { sendChatMessages } from "./chat.js";
import { getNotesContext, buildSnapshot } from "./notesContext.js";
import { TOOLS } from "./tools.js";
import { getEvalFunctions } from "./evalTools.js";
import { listProfiles, upsertProfile, deleteProfile } from "./profiles.js";

/**
 * Handles API requests and writes the JSON response directly. Supports:
 *   GET  /api/listing[?path=relative/path] -> JSON array of entries (name, isDirectory).
 *   GET  /api/file?path=relative/path      -> JSON { content: string }.
 *   POST /api/chat { messages }            -> JSON { reply: string }.
 *   GET  /api/profiles                     -> JSON { profiles: [{name, instructions}] }.
 *   POST /api/profiles { name, instructions } -> JSON { profile } (add or update).
 *   DELETE /api/profiles?name=X            -> JSON { ok } (404 if no such profile).
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

  if (req.method === "GET" && url.pathname === "/api/notes-snapshot") {
    return run(res, async () => {
      const snapshot = await buildSnapshot();
      return sendJson(res, 200, { snapshot });
    });
  }

  if (req.method === "GET" && url.pathname === "/api/tools") {
    return run(res, async () => {
      // The TOOLS registry is the single source of truth for which tools the
      // model can call; expose each one's display metadata (icon/label) and
      // its definition's description so the frontend can show what is
      // available without hardcoding a second copy of the tool list.
      const tools = TOOLS.map((t) => ({
        name: t.name,
        label: t.label,
        icon: t.icon,
        description: t.definition.function.description,
      }));
      return sendJson(res, 200, { tools });
    });
  }

  if (req.method === "GET" && url.pathname === "/api/eval-functions") {
    return run(res, async () => {
      // The eval sandbox's functions (built-in file I/O / directory functions
      // plus any the model defined via create_function) are the source of
      // truth for what an eval expression can call. Expose them so the UI's
      // eval-functions reference never hardcodes a second copy of the list.
      const functions = getEvalFunctions();
      return sendJson(res, 200, { functions });
    });
  }

  if (url.pathname === "/api/profiles") {
    if (req.method === "GET") {
      return run(res, async () => {
        const profiles = await listProfiles();
        return sendJson(res, 200, { profiles });
      });
    }
    if (req.method === "POST") {
      return run(res, async () => {
        const body = await readJsonBody(req);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const instructions =
          typeof body.instructions === "string" ? body.instructions : "";
        if (name === "") {
          return sendJson(res, 400, { error: "Missing profile name" });
        }
        const profile = await upsertProfile(name, instructions);
        return sendJson(res, 200, { profile });
      });
    }
    if (req.method === "DELETE") {
      return run(res, async () => {
        const name = url.searchParams.get("name") ?? "";
        if (name === "") {
          return sendJson(res, 400, { error: "Missing profile name" });
        }
        const result = await deleteProfile(name);
        if (!result.ok) {
          return sendJson(res, 404, { error: result.reason ?? "Not found" });
        }
        return sendJson(res, 200, { ok: true });
      });
    }
    return sendJson(res, 404, { error: "Not found" });
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    return run(res, async () => {
      const body = await readJsonBody(req);
      const messages = normalizeMessages(body.messages);
      if (!messages) return sendJson(res, 400, { error: "Missing messages" });
      // A stable conversation id gets a cached, conversation-frozen notes
      // snapshot; an absent id is one-shot (fresh snapshot each call, never
      // shared across conversations). The frontend may supply the snapshot it
      // stored at conversation start so a resumed conversation after a backend
      // restart reuses the same snapshot the model's prior replies saw.
      const conversationId =
        typeof body.conversationId === "string" ? body.conversationId : "";
      const storedSnapshot =
        typeof body.notesSnapshot === "string" ? body.notesSnapshot : "";
      const notesSystem = await getNotesContext(conversationId, storedSnapshot);
      // The profile instructions are frozen per conversation by the frontend
      // (it stores the selected profile's instructions at conversation start
      // and re-sends them with every request, exactly like notesSnapshot). An
      // empty/absent value means "no profile" — no extra system message, which
      // is the pre-profile behavior.
      const profileInstructions =
        typeof body.profileInstructions === "string"
          ? body.profileInstructions
          : "";
      const systemMessages = [notesSystem];
      if (profileInstructions) {
        systemMessages.push(
          `You are operating under the following user-defined profile ` +
            `instructions. Follow them throughout this conversation in ` +
            `addition to your normal instructions:\n\n${profileInstructions}`,
        );
      }
      const convo = [
        { role: "system", content: systemMessages.join("\n\n") },
        ...messages,
      ];
      await streamChat(res, convo);
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
