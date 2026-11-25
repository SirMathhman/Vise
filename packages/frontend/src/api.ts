import type { ChatRequest, Result } from "common";
import {
  ErrorResponseSchema,
  describeParseError,
  err,
  ok,
  parseJson,
} from "common";
import type { z } from "zod";

// Backend base URL. Change this if the backend runs elsewhere.
const API_BASE = "http://localhost:3000";

const UNREACHABLE = "Could not reach the backend";

// The backend's error message, or a fallback when the body does not carry one.
async function failureFrom(res: Response): Promise<string> {
  const body = parseJson(ErrorResponseSchema, await res.text());
  return body.ok ? body.value.error : `HTTP ${String(res.status)}`;
}

/**
 * Calls a JSON endpoint and checks the reply against the schema for it.
 *
 * @param path The endpoint path, starting with a slash.
 * @param schema The schema the reply must match.
 * @param init Options for the request, such as the method and body.
 * @returns The checked reply, or the error to show the user.
 */
export async function apiJson<S extends z.ZodType>(
  path: string,
  schema: S,
  init?: RequestInit,
): Promise<Result<z.output<S>, string>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch {
    return err(UNREACHABLE);
  }
  if (!res.ok) {
    return err(await failureFrom(res));
  }
  const parsed = parseJson(schema, await res.text());
  return parsed.ok ? ok(parsed.value) : err(describeParseError(parsed.error));
}

/**
 * Opens the chat stream for one request. Returns the raw body to read, or the error.
 *
 * @param request The model and the conversation to send.
 * @returns The raw body to read, or the error to show the user.
 */
export async function openChat(
  request: ChatRequest,
): Promise<Result<ReadableStream<Uint8Array>, string>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch {
    return err(UNREACHABLE);
  }
  if (!res.ok) {
    return err(await failureFrom(res));
  }
  if (!res.body) {
    return err("The reply had no body");
  }
  return ok(res.body);
}
