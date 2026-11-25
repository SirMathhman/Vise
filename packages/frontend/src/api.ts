import type { ChatRequest, ErrorResponse, Result } from "common";
import { err, ok } from "common";

// Backend base URL. Change this if the backend runs elsewhere.
const API_BASE = "http://localhost:3000";

const UNREACHABLE = "Could not reach the backend";

// Returns the backend's error message from a parsed body, or the fallback.
function errorText(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const { error } = body as Partial<ErrorResponse>;
    if (typeof error === "string") {
      return error;
    }
  }
  return fallback;
}

// Calls a JSON endpoint. Returns the parsed body, or the error to show the user.
export async function apiJson<T>(
  path: string,
  init?: RequestInit,
): Promise<Result<T, string>> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch {
    return err(UNREACHABLE);
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    return err(errorText(body, `HTTP ${String(res.status)}`));
  }
  return ok(body as T);
}

// Opens the chat stream for one message. Returns the raw body to read, or the error.
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
    const body: unknown = await res.json().catch(() => undefined);
    return err(errorText(body, `HTTP ${String(res.status)}`));
  }
  if (!res.body) {
    return err("The reply had no body");
  }
  return ok(res.body);
}
