import type {
  ChatRequest,
  ChatStreamEvent,
  ErrorResponse,
  HealthResponse,
  ModelsResponse,
  OpenRouterSettings,
  SaveOpenRouterKeyRequest,
} from "common";
import { greet } from "common";
import { streamChatReply } from "./chat";
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

async function openRouterSettings(req: Request): Promise<Response> {
  if (req.method === "PUT") {
    const input = (await req
      .json()
      .catch(() => ({}))) as Partial<SaveOpenRouterKeyRequest>;
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (!apiKey || /\s/.test(apiKey)) {
      const body: ErrorResponse = {
        error: "apiKey must be a non-empty string without whitespace",
      };
      return json(body, 400);
    }
    await saveOpenRouterKey(apiKey);
  } else if (req.method === "DELETE") {
    await clearSavedOpenRouterKey();
  } else if (req.method !== "GET") {
    const body: ErrorResponse = { error: "Method not allowed" };
    return json(body, 405);
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
  const input = (await req.json().catch(() => ({}))) as Partial<ChatRequest>;
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (!model || !message) {
    const body: ErrorResponse = {
      error: "model and message must be non-empty strings",
    };
    return json(body, 400);
  }

  const apiKey = await getOpenRouterKey();
  if (!apiKey) {
    const body: ErrorResponse = {
      error:
        "No OpenRouter API key is set. Add one in the UI or set OPENROUTER_API_KEY.",
    };
    return json(body, 500);
  }

  try {
    const reply = await streamChatReply(apiKey, model, message);
    return new Response(reply.pipeThrough(toSse()), {
      headers: { ...CORS_HEADERS, "Content-Type": "text/event-stream" },
    });
  } catch (err) {
    const body: ErrorResponse = {
      error: err instanceof Error ? err.message : String(err),
    };
    return json(body, 502);
  }
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
        : json({ error: "Method not allowed" } satisfies ErrorResponse, 405);
    }

    if (url.pathname === "/api/models") {
      const apiKey = await getOpenRouterKey();
      if (!apiKey) {
        const body: ErrorResponse = {
          error:
            "No OpenRouter API key is set. Add one in the UI or set OPENROUTER_API_KEY.",
        };
        return json(body, 500);
      }
      try {
        const body: ModelsResponse = { models: await fetchModels(apiKey) };
        return json(body);
      } catch (err) {
        const body: ErrorResponse = {
          error: err instanceof Error ? err.message : String(err),
        };
        return json(body, 502);
      }
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
