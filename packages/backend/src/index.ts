import type {
  ChatStreamEvent,
  ErrorResponse,
  HealthResponse,
  ModelsResponse,
  NotesResponse,
  OpenRouterSettings,
  Result,
} from "common";
import {
  ApprovalDecisionSchema,
  ChatRequestSchema,
  NoteInputSchema,
  SaveOpenRouterKeyRequestSchema,
  describeParseError,
  conversationLimit,
  fitsBudget,
  greet,
  parseJson,
} from "common";
import type { ParseError } from "common";
import { z } from "zod";
import { decideApproval } from "./chat/approvals";
import { withSystemContext } from "./chat/chat";
import { streamChatReply } from "./chat/tool-loop";
import { toolDefinitions } from "./tools";
import { buildModelSelf } from "./chat/model-facts";
import { PROJECT_ROOT } from "./project/workdir";
import { fetchModels } from "./openrouter";
import {
  type NoteError,
  createNote,
  deleteNote,
  describeNoteError,
  getNote,
  listNotes,
  updateNote,
} from "./notes/notes-store";
import {
  clearSavedOpenRouterKey,
  getOpenRouterKey,
  saveOpenRouterKey,
} from "./settings";

const port = Number(process.env.PORT ?? 3000);

// Only the frontend dev server may call this API from a browser.
const FRONTEND_ORIGIN = "http://localhost:5173";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

function errorJson(error: string, status: number): Response {
  const body: ErrorResponse = { error };
  return json(body, status);
}

// Reads a request body as text and checks it against a zod schema.
async function readBody<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<Result<z.output<S>, ParseError>> {
  return parseJson(schema, await req.text());
}

async function openRouterSettings(req: Request): Promise<Response> {
  if (req.method === "PUT") {
    const input = await readBody(req, SaveOpenRouterKeyRequestSchema);
    if (!input.ok) {
      return errorJson(describeParseError(input.error), 400);
    }
    await saveOpenRouterKey(input.value.apiKey);
  } else if (req.method === "DELETE") {
    await clearSavedOpenRouterKey();
  } else if (req.method !== "GET") {
    return errorJson("Method not allowed", 405);
  }

  const body: OpenRouterSettings = {
    configured: Boolean(await getOpenRouterKey()),
  };
  return json(body);
}

// Frames each chat event as one server-sent event. Failures after the stream starts
// arrive as an "error" event, since the HTTP status has already been sent.
const sseEncoder = new TextEncoder();
// A stream can be piped only once, so each reply gets its own transform.
function toSse(): TransformStream<ChatStreamEvent, Uint8Array> {
  return new TransformStream<ChatStreamEvent, Uint8Array>({
    transform(event, controller) {
      controller.enqueue(
        sseEncoder.encode(`data: ${JSON.stringify(event)}\n\n`),
      );
    },
  });
}

// Sends one message and streams the model's reply back as server-sent events.
async function chat(req: Request): Promise<Response> {
  const input = await readBody(req, ChatRequestSchema);
  if (!input.ok) {
    return errorJson(describeParseError(input.error), 400);
  }
  const { model, messages } = input.value;

  const apiKey = await getOpenRouterKey();
  if (!apiKey) {
    return errorJson(
      "No OpenRouter API key is set. Add one in the UI or set OPENROUTER_API_KEY.",
      500,
    );
  }

  // The limit is the model's own context window, so look that up for this request.
  const models = await fetchModels(apiKey);
  if (!models.ok) {
    return errorJson(models.error, 502);
  }
  const info = models.value.find((m) => m.id === model);
  if (info === undefined) {
    return errorJson(`Unknown model "${model}".`, 400);
  }
  if (!fitsBudget(messages, conversationLimit(info.contextLength))) {
    return errorJson(
      "The conversation is too long for this model. Start a new conversation or send a shorter message.",
      400,
    );
  }

  const upstream = withSystemContext(messages, PROJECT_ROOT);
  const tools: typeof toolDefinitions =
    input.value.allowTools === false ? [] : toolDefinitions;
  const self = buildModelSelf(
    info,
    upstream,
    tools,
    conversationLimit(info.contextLength),
  );
  const reply = await streamChatReply(
    apiKey,
    model,
    upstream,
    req.signal,
    tools,
    { root: PROJECT_ROOT, self },
  );
  if (!reply.ok) {
    return errorJson(reply.error, 502);
  }
  return new Response(reply.value.pipeThrough(toSse()), {
    headers: { ...CORS_HEADERS, "Content-Type": "text/event-stream" },
  });
}

// Records the user's answer to a proposed change. The waiting reply then continues.
async function answerApproval(req: Request, id: string): Promise<Response> {
  const input = await readBody(req, ApprovalDecisionSchema);
  if (!input.ok) {
    return errorJson(describeParseError(input.error), 400);
  }
  const decision = input.value.approved ? "approve" : "reject";
  if (!decideApproval(id, decision)) {
    return errorJson("No change is waiting for that id.", 404);
  }
  return json({ ok: true });
}

// Maps a note failure to its HTTP status: a missing note is 404, a taken name is 409.
function noteFailure(error: NoteError): Response {
  const status =
    error === "not-found" ? 404 : error === "name-taken" ? 409 : 500;
  return errorJson(describeNoteError(error), status);
}

// GET lists every note; POST creates one.
async function notesCollection(req: Request): Promise<Response> {
  if (req.method === "GET") {
    const notes = await listNotes();
    if (!notes.ok) {
      return noteFailure(notes.error);
    }
    const body: NotesResponse = { notes: notes.value };
    return json(body);
  }
  const input = await readBody(req, NoteInputSchema);
  if (!input.ok) {
    return errorJson(describeParseError(input.error), 400);
  }
  const created = await createNote(input.value);
  return created.ok ? json(created.value, 201) : noteFailure(created.error);
}

// GET reads one note; PUT replaces its fields; DELETE removes it.
async function noteItem(req: Request, id: string): Promise<Response> {
  if (req.method === "GET") {
    const note = await getNote(id);
    return note.ok ? json(note.value) : noteFailure(note.error);
  }
  if (req.method === "PUT") {
    const input = await readBody(req, NoteInputSchema);
    if (!input.ok) {
      return errorJson(describeParseError(input.error), 400);
    }
    const updated = await updateNote(id, input.value);
    return updated.ok ? json(updated.value) : noteFailure(updated.error);
  }
  if (req.method === "DELETE") {
    const removed = await deleteNote(id);
    return removed.ok ? json(removed.value) : noteFailure(removed.error);
  }
  return errorJson("Method not allowed", 405);
}

async function models(): Promise<Response> {
  const apiKey = await getOpenRouterKey();
  if (!apiKey) {
    return errorJson(
      "No OpenRouter API key is set. Add one in the UI or set OPENROUTER_API_KEY.",
      500,
    );
  }
  const result = await fetchModels(apiKey);
  if (!result.ok) {
    return errorJson(result.error, 502);
  }
  const body: ModelsResponse = { models: result.value };
  return json(body);
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (url.pathname === "/api/settings/openrouter") {
      return openRouterSettings(req);
    }

    if (url.pathname === "/api/chat") {
      return req.method === "POST"
        ? chat(req)
        : errorJson("Method not allowed", 405);
    }

    if (url.pathname.startsWith("/api/approvals/")) {
      const id = url.pathname.slice("/api/approvals/".length);
      return req.method === "POST"
        ? answerApproval(req, id)
        : errorJson("Method not allowed", 405);
    }

    if (url.pathname === "/api/notes") {
      return req.method === "GET" || req.method === "POST"
        ? notesCollection(req)
        : errorJson("Method not allowed", 405);
    }

    if (url.pathname.startsWith("/api/notes/")) {
      return noteItem(req, url.pathname.slice("/api/notes/".length));
    }

    if (url.pathname === "/api/models") {
      return models();
    }

    if (url.pathname === "/api/health") {
      const body: HealthResponse = {
        status: "ok",
        service: "backend",
        time: new Date().toISOString(),
      };
      return json(body);
    }

    if (url.pathname === "/api/greet") {
      const name = url.searchParams.get("name") ?? "world";
      return json({ message: greet(name) });
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
});

console.log(`backend listening on http://localhost:${String(port)}`);
