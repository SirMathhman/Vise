import type { ToolsResponse } from "common";
import { ToolSettingsSchema, describeParseError } from "common";
import { errorJson, json, readBody } from "../http";
import { isToolName, listTools } from "./index";
import { readToolSettings, saveToolSettings } from "./tool-settings";

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

/**
 * Serves /api/tool-settings: GET reads which tools are turned off; PUT replaces that list. A name
 * that is not a tool is refused.
 *
 * @param req The request.
 * @returns The settings, a refusal, or 405 for any other method.
 */
export async function handleToolSettings(req: Request): Promise<Response> {
  if (req.method === "GET") {
    const settings = await readToolSettings();
    return settings.ok ? json(settings.value) : errorJson(settings.error, 500);
  }
  if (req.method === "PUT") {
    const input = await readBody(req, ToolSettingsSchema);
    if (!input.ok) {
      return errorJson(describeParseError(input.error), 400);
    }
    const unknown = input.value.disabled.filter((name) => !isToolName(name));
    if (unknown.length > 0) {
      return errorJson(`No tool is named ${unknown.join(", ")}.`, 400);
    }
    await saveToolSettings(input.value);
    return json(input.value);
  }
  return errorJson("Method not allowed", 405);
}
