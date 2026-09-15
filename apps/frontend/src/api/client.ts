/**
 * Typed fetch wrapper for the backend API. Each function returns parsed data
 * or throws an `Error` with the server-provided message (falling back to the
 * HTTP status). Views call these instead of `fetch` directly so that JSON
 * parsing and error normalization live in one place.
 */

export interface DirEntry {
  name: string;
  kind: "file" | "directory";
}

export interface LsResponse {
  path: string;
  items: DirEntry[];
}

export interface FileResponse {
  path: string;
  size: number;
  content: string;
}

/** A model id served by the LLM proxy (see `/llm/v1/models`). */
export interface LlmModel {
  id: string;
}

/** GET the backend health status. */
export async function health(): Promise<string> {
  const res = await fetch("/api/health");
  if (!res.ok) return fail(res);
  const data = (await res.json()) as { status: string };
  return data.status;
}

function encodeRel(rel: string): string {
  return rel.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

/** Fetch a normalized error message from a failed response. */
async function fail(res: Response): Promise<never> {
  const data = (await res.json().catch(() => null)) as {
    message?: string;
  } | null;
  throw new Error(data?.message ?? `HTTP ${res.status}`);
}

/** GET the listing for a directory ("" = root). */
export async function listDir(rel: string): Promise<LsResponse> {
  const res = await fetch(`/api/ls/${encodeRel(rel)}`);
  if (!res.ok) return fail(res);
  return (await res.json()) as LsResponse;
}

/** GET the contents of a file. */
export async function getFile(rel: string): Promise<FileResponse> {
  const res = await fetch(`/api/file/${encodeRel(rel)}`);
  if (!res.ok) return fail(res);
  return (await res.json()) as FileResponse;
}

/** PUT new contents to a file. */
export async function putFile(rel: string, content: string): Promise<void> {
  const res = await fetch(`/api/file/${encodeRel(rel)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) return fail(res);
}

/** DELETE a file. */
export async function deleteFile(rel: string): Promise<void> {
  const res = await fetch(`/api/file/${encodeRel(rel)}`, {
    method: "DELETE",
  });
  if (!res.ok) return fail(res);
}

/**
 * POST a create request for a file or directory in `parentRel`. Throws on
 * failure so the caller can surface the error.
 */
export async function createEntry(
  kind: "file" | "directory",
  parentRel: string,
  name: string
): Promise<void> {
  const rel = parentRel ? `${parentRel}/${name}` : name;
  const endpoint = kind === "directory" ? "/api/dir" : "/api/file";
  const payload =
    kind === "directory" ? { path: rel } : { path: rel, content: "" };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return fail(res);
}

/**
 * The LLM proxy (llama.cpp at :8080) requires a bearer token. This is a
 * local-use key: the Vite dev proxy forwards to 127.0.0.1, so the key never
 * leaves the machine.
 */
const LLM_API_KEY = "S6677k5w355Nw9ErxCZWYCMiW4ItldmzXBLUElpnLsdE8gBj5A";

/** GET the models served by the LLM proxy. */
export async function listLlmModels(): Promise<LlmModel[]> {
  const res = await fetch("/llm/v1/models", {
    headers: { Authorization: `Bearer ${LLM_API_KEY}` },
  });
  if (!res.ok) return fail(res);
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? []).map((m) => ({ id: m.id }));
}

/** A single turn in a chat conversation, in OpenAI-compatible wire format. */
export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Present on assistant messages that request tool invocations. */
  tool_calls?: LlmToolCall[];
  /** On `tool` messages, the id of the call this result answers. */
  tool_call_id?: string;
}

/** A function call the model asked to run. */
export interface LlmToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** The model's reply for one turn: either text or a set of tool calls. */
export interface LlmAssistantMessage {
  content: string | null;
  tool_calls?: LlmToolCall[];
}

/** An OpenAI-compatible tool definition. */
export interface LlmTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Lets the model inspect the file tree so it can answer "what's in this
 * directory" from live data. Paths are relative to the workspace root.
 */
export const listDirectoryTool: LlmTool = {
  type: "function",
  function: {
    name: "list_directory",
    description:
      'List the files and subdirectories in a directory. Use this to answer questions about what files or folders exist. The path is relative to the workspace root; use an empty string ("") for the root.',
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            'Directory path relative to the workspace root. Use "" for the root.',
        },
      },
      required: ["path"],
    },
  },
};

/** POST a chat completion and return the assistant's reply (text and/or tool calls). */
export async function sendLlmMessage(
  messages: LlmMessage[],
  model: string,
  tools?: LlmTool[]
): Promise<LlmAssistantMessage> {
  const body: Record<string, unknown> = { model, messages };
  if (tools && tools.length > 0) body.tools = tools;
  const res = await fetch("/llm/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return fail(res);
  const data = (await res.json()) as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: LlmToolCall[];
      };
    }[];
  };
  const message = data.choices?.[0]?.message;
  return {
    content: message?.content ?? null,
    tool_calls: message?.tool_calls,
  };
}
