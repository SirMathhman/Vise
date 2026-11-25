import type {
  OkResponse,
  ProfileToolListsResponse,
  ToolsResponse,
} from "common";
import {
  ProfileToolsSchema,
  ToolSettingsSchema,
  describeParseError,
} from "common";
import { profileInstructions } from "../notes/profiles";
import { errorJson, json, readBody } from "../http";
import { isToolName, listTools } from "./index";
import {
  readProfileToolLists,
  readToolSettings,
  saveProfileToolList,
  saveToolSettings,
} from "./tool-settings";

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
    try {
      await saveToolSettings(input.value);
    } catch {
      return errorJson("The tool settings could not be saved.", 500);
    }
    return json(input.value);
  }
  return errorJson("Method not allowed", 405);
}

/**
 * Serves /api/tool-settings/profiles (GET lists every whitelist) and /api/tool-settings/profiles/:id
 * (PUT sets one profile's whitelist, DELETE removes it). Only a profile note can have a whitelist,
 * and it may list only real tools.
 *
 * @param req The request.
 * @param pathname The request's path.
 * @returns The whitelists, the saved list, a refusal, or 405 for any other method.
 */
export async function handleProfileToolSettings(
  req: Request,
  pathname: string,
): Promise<Response> {
  if (pathname === "/api/tool-settings/profiles") {
    if (req.method !== "GET") {
      return errorJson("Method not allowed", 405);
    }
    const lists = await readProfileToolLists();
    if (!lists.ok) {
      return errorJson(lists.error, 500);
    }
    const body: ProfileToolListsResponse = { profiles: lists.value };
    return json(body);
  }
  if (req.method !== "PUT" && req.method !== "DELETE") {
    return errorJson("Method not allowed", 405);
  }
  const id = pathname.slice("/api/tool-settings/profiles/".length);
  const profile = await profileInstructions(id);
  if (!profile.ok) {
    return errorJson(profile.error, 400);
  }
  try {
    if (req.method === "DELETE") {
      const removed = await saveProfileToolList(id, undefined);
      if (!removed.ok) {
        return errorJson(removed.error, 500);
      }
      const body: OkResponse = { ok: true };
      return json(body);
    }
    const input = await readBody(req, ProfileToolsSchema);
    if (!input.ok) {
      return errorJson(describeParseError(input.error), 400);
    }
    const unknown = input.value.tools.filter((name) => !isToolName(name));
    if (unknown.length > 0) {
      return errorJson(`No tool is named ${unknown.join(", ")}.`, 400);
    }
    const saved = await saveProfileToolList(id, input.value.tools);
    if (!saved.ok) {
      return errorJson(saved.error, 500);
    }
    return json(input.value);
  } catch {
    return errorJson("The tool settings could not be saved.", 500);
  }
}
