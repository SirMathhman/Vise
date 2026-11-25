import type { ErrorResponse, Result } from "common";
import { parseJson } from "common";
import type { ParseError } from "common";
import type { z } from "zod";

// Only the frontend dev server may call this API from a browser.
const FRONTEND_ORIGIN = "http://localhost:5173";

/**
 * The headers every reply carries, so the frontend dev server may read it.
 */
export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": FRONTEND_ORIGIN,
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * A JSON reply.
 *
 * @param body The value to send.
 * @param status The HTTP status. Defaults to 200.
 * @returns The response.
 */
export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

/**
 * A JSON reply carrying an error message.
 *
 * @param error The message to send.
 * @param status The HTTP status.
 * @returns The response.
 */
export function errorJson(error: string, status: number): Response {
  const body: ErrorResponse = { error };
  return json(body, status);
}

/**
 * Reads a request body as text and checks it against a zod schema.
 *
 * @param req The request.
 * @param schema The schema the body must match.
 * @returns The checked body, or the reason it does not match.
 */
export async function readBody<S extends z.ZodType>(
  req: Request,
  schema: S,
): Promise<Result<z.output<S>, ParseError>> {
  return parseJson(schema, await req.text());
}
