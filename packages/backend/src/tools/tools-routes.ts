import type { ToolsResponse } from "common";
import { errorJson, json } from "../http";
import { listTools } from "./index";

/**
 * Serves GET /api/tools: every tool the model may call, with its description.
 *
 * @param req The request.
 * @returns The tool list, or 405 for any other method.
 */
export function handleTools(req: Request): Response {
  if (req.method !== "GET") {
    return errorJson("Method not allowed", 405);
  }
  const body: ToolsResponse = { tools: listTools() };
  return json(body);
}
