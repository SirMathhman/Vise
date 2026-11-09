import { err, ok, type Result } from "../../core/messages.ts";
import { REQUEST_TIMEOUT_MS, type McpSession } from "./client.ts";

// One MCP server over HTTP (the Streamable HTTP transport). Each message is a POST to the URL. The answer
// comes back as one JSON message or as an event stream. The server may give a session id on the first
// answer, which is sent back on every later message and on the final DELETE.
const PROTOCOL_VERSION = "2025-06-18";
const SESSION_HEADER = "mcp-session-id";

interface Answer {
  id?: unknown;
  result?: unknown;
  error?: AnswerError;
}

interface AnswerError {
  message?: string;
}

// Opens a session to the endpoint. The URL is checked here; nothing is sent until the first request.
export function openHttpSession(url: string, headers: Record<string, string>): Result<McpSession> {
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch {
    return err(new Error("the url is not a URL"));
  }
  let sessionId: string | undefined;
  let nextId = 1;
  let closed = false;

  const send = (body: object): Promise<Response> => {
    const sent: Record<string, string> = { ...headers, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL_VERSION };
    if (sessionId !== undefined) sent[SESSION_HEADER] = sessionId;
    // A redirect is refused, so the headers are never sent to another address.
    return fetch(endpoint, { method: "POST", headers: sent, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  };

  return ok({
    async request(method, params) {
      if (closed) return err(new Error("the server has stopped"));
      const id = nextId++;
      try {
        const response = await send({ jsonrpc: "2.0", id, method, params });
        const given = response.headers.get(SESSION_HEADER);
        if (given !== null) sessionId = given;
        if (!response.ok) return err(new Error(`the server answered ${response.status}`));
        const answer = await answerTo(response, id);
        if (answer === undefined) return err(new Error(`${method} got no answer in time`));
        if (answer.error !== undefined) return err(new Error(answer.error.message ?? "the server returned an error"));
        return ok(answer.result);
      } catch (error) {
        return err(error instanceof Error ? error : new Error(String(error)));
      }
    },
    notify(method, params) {
      if (closed) return;
      // A notification has no answer to wait for, so a failure to send it is not reported.
      send({ jsonrpc: "2.0", method, params }).then(
        () => undefined,
        () => undefined,
      );
    },
    async stop() {
      closed = true;
      if (sessionId === undefined) return;
      try {
        await fetch(endpoint, {
          method: "DELETE",
          redirect: "error",
          headers: { ...headers, [SESSION_HEADER]: sessionId },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        // The server may have gone already; there is nothing more to do.
      }
    },
  });
}

// The answer to request `id`, read from a JSON body or from an event stream. Undefined when none is there.
async function answerTo(response: Response, id: number): Promise<Answer | undefined> {
  const text = await response.text();
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    return answerInEvents(text, id);
  }
  return matching(parseJson(text), id);
}

// Reads the events of a stream: each event's data lines are joined, and the first one that answers `id`
// is taken.
function answerInEvents(text: string, id: number): Answer | undefined {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    const answer = matching(parseJson(data), id);
    if (answer !== undefined) return answer;
  }
  return undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The message if it is an object that answers `id`.
function matching(value: unknown, id: number): Answer | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const answer = value as Answer;
  return answer.id === id ? answer : undefined;
}
