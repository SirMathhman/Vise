import type {
  ChatStreamEvent,
  HealthResponse,
  ModelsResponse,
  OkResponse,
  OpenRouterSettings,
} from "common";
import {
  ApprovalDecisionSchema,
  ChatRequestSchema,
  EndSessionRequestSchema,
  SaveOpenRouterKeyRequestSchema,
  describeParseError,
  conversationLimit,
  fitsBudget,
  greet,
} from "common";
import { decideApproval } from "./chat/approvals";
import { systemContextText, withSystemContext } from "./chat/chat";
import { streamChatReply } from "./chat/tool-loop";
import { enabledToolDefinitions, toolDefinitions } from "./tools";
import { handleTools, handleToolSettings } from "./tools/tools-routes";
import { buildModelSelf } from "./chat/model-facts";
import { CORS_HEADERS, errorJson, json, readBody, refuseWrite } from "./http";
import { PROJECT_ROOT } from "./project/workdir";
import { fetchModels } from "./openrouter";
import { HOOK_TIMEOUT_MS, runHook } from "./hooks/hooks";
import { stopAllJobs } from "./process/jobs";
import { handleHooks } from "./hooks/hooks-routes";
import { handleNotes } from "./notes/notes-routes";
import { profileInstructions } from "./notes/profiles";
import {
  clearSavedOpenRouterKey,
  getOpenRouterKey,
  saveOpenRouterKey,
} from "./settings";

const port = Number(process.env.PORT ?? 3000);

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
// A stream can be piped only once, so each reply gets its own transform. The end callback runs
// once the reply's events have all been sent.
function toSse(
  onEnd: () => Promise<void>,
): TransformStream<ChatStreamEvent, Uint8Array> {
  return new TransformStream<ChatStreamEvent, Uint8Array>({
    transform(event, controller) {
      controller.enqueue(
        sseEncoder.encode(`data: ${JSON.stringify(event)}\n\n`),
      );
    },
    async flush() {
      await onEnd();
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
  let instructions: string | undefined;
  if (input.value.profileId !== undefined) {
    const profile = await profileInstructions(input.value.profileId);
    if (!profile.ok) {
      return errorJson(profile.error, 400);
    }
    instructions = profile.value;
  }
  // The budget counts the system instructions too, since the upstream request carries them.
  const system = {
    role: "user" as const,
    content: systemContextText(PROJECT_ROOT, instructions),
  };
  if (
    !fitsBudget([system, ...messages], conversationLimit(info.contextLength))
  ) {
    return errorJson(
      "The conversation is too long for this model. Start a new conversation or send a shorter message.",
      400,
    );
  }

  // A request without tools is a summary for compaction, not a turn. The first message of a
  // conversation also starts its session.
  const turn = input.value.allowTools !== false;
  if (turn) {
    if (messages.length === 1) {
      const started = await runHook(
        "beforeSession",
        PROJECT_ROOT,
        HOOK_TIMEOUT_MS,
        input.value.profileId,
      );
      if (!started.ok) {
        return errorJson(started.error, 500);
      }
    }
    const begun = await runHook(
      "beforeTurn",
      PROJECT_ROOT,
      HOOK_TIMEOUT_MS,
      input.value.profileId,
    );
    if (!begun.ok) {
      return errorJson(begun.error, 500);
    }
  }

  const upstream = withSystemContext(messages, PROJECT_ROOT, instructions);
  let tools: typeof toolDefinitions = [];
  if (input.value.allowTools !== false) {
    const enabled = await enabledToolDefinitions();
    if (!enabled.ok) {
      return errorJson(enabled.error, 500);
    }
    tools = enabled.value;
  }
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
  const afterTurn = async (): Promise<void> => {
    if (turn) {
      const done = await runHook(
        "afterTurn",
        PROJECT_ROOT,
        HOOK_TIMEOUT_MS,
        input.value.profileId,
      );
      if (!done.ok) {
        console.error(done.error);
      }
    }
  };
  return new Response(reply.value.pipeThrough(toSse(afterTurn)), {
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

// The chat session has ended, because the user started a new conversation. Its after-session
// command can only log a failure, so the reply is always ok.
async function endSession(req: Request): Promise<Response> {
  const input = await readBody(req, EndSessionRequestSchema);
  if (!input.ok) {
    return errorJson(describeParseError(input.error), 400);
  }
  // Background commands belong to the conversation, so they stop with it.
  stopAllJobs();
  const finished = await runHook(
    "afterSession",
    PROJECT_ROOT,
    HOOK_TIMEOUT_MS,
    input.value.profileId,
  );
  if (!finished.ok) {
    console.error(finished.error);
  }
  const body: OkResponse = { ok: true };
  return json(body);
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
  hostname: "127.0.0.1",
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const refusal = refuseWrite(req);
    if (refusal) {
      return refusal;
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

    if (
      url.pathname === "/api/notes" ||
      url.pathname.startsWith("/api/notes/")
    ) {
      return handleNotes(req, url.pathname);
    }

    if (
      url.pathname === "/api/hooks" ||
      url.pathname.startsWith("/api/hooks/")
    ) {
      return handleHooks(req, url.pathname);
    }

    if (url.pathname === "/api/session/end") {
      return req.method === "POST"
        ? endSession(req)
        : errorJson("Method not allowed", 405);
    }

    if (url.pathname === "/api/tools") {
      return handleTools(req);
    }

    if (url.pathname === "/api/tool-settings") {
      return handleToolSettings(req);
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
