import type { ServerResponse } from "node:http";
import { sendJson } from "./http.js";

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function notFound(): AppError {
  return new AppError(404, "not_found", "resource not found");
}

export function badRequest(message: string): AppError {
  return new AppError(400, "bad_request", message);
}

export function internal(message = "internal server error"): AppError {
  return new AppError(500, "internal_error", message);
}

export function toResponse(res: ServerResponse, err: AppError): void {
  sendJson(res, err.statusCode, {
    error: err.code,
    ...(err.message ? { message: err.message } : {}),
  });
}
