import type {
  ChatStreamEvent,
  ErrorResponse,
  HealthResponse,
  ModelsResponse,
  OpenRouterSettings,
  Result,
} from "common";
import {
  ChatRequestSchema,
  SaveOpenRouterKeyRequestSchema,
  describeParseError,
  fitsBudget,
  greet,
  parseJson,
} from "common";
import type { ParseError } from "common";
import { z } from "zod";
import { streamChatReply, withSystemContext } from "./chat";
import { PROJECT_ROOT } from "./workdir";
import { fetchModels } from "./openrouter";
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
  if (!fitsBudget(messages)) {
    return errorJson(
      "The conversation is over the size limit. Start a new conversation or send a shorter message.",
      400,
    );
  }

  const apiKey = await getOpenRouterKey();
  if (!apiKey) {
    return errorJson(
      "No OpenRouter API key is set. Add one in the UI or set OPENROUTER_API_KEY.",
      500,
    );
  }

  const reply = await streamChatReply(
    apiKey,
    model,
    withSystemContext(messages, PROJECT_ROOT),
  );
  if (!reply.ok) {
    return errorJson(reply.error, 502);
  }
  return new Response(reply.value.pipeThrough(toSse()), {
    headers: { ...CORS_HEADERS, "Content-Type": "text/event-stream" },
  });
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
