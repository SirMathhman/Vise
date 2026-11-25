import type { HooksResponse } from "common";
import { HooksSchema, describeParseError } from "common";
import { errorJson, json, readBody } from "../http";
import { profileInstructions } from "../notes/profiles";
import {
  readGlobalHooks,
  readProfileHooks,
  saveGlobalHooks,
  saveProfileHooks,
} from "./hooks";

// GET /api/hooks: the global commands and every profile's commands.
async function allHooks(): Promise<Response> {
  const global = await readGlobalHooks();
  if (!global.ok) {
    return errorJson(global.error, 500);
  }
  const profiles = await readProfileHooks();
  if (!profiles.ok) {
    return errorJson(profiles.error, 500);
  }
  const body: HooksResponse = {
    global: global.value,
    profiles: profiles.value,
  };
  return json(body);
}

// PUT /api/hooks/global replaces the global commands.
async function putGlobal(req: Request): Promise<Response> {
  const input = await readBody(req, HooksSchema);
  if (!input.ok) {
    return errorJson(describeParseError(input.error), 400);
  }
  await saveGlobalHooks(input.value);
  return json(input.value);
}

// PUT /api/hooks/profiles/:id replaces one profile's commands. Only a profile note can have them.
async function putProfile(req: Request, id: string): Promise<Response> {
  const profile = await profileInstructions(id);
  if (!profile.ok) {
    return errorJson(profile.error, 400);
  }
  const input = await readBody(req, HooksSchema);
  if (!input.ok) {
    return errorJson(describeParseError(input.error), 400);
  }
  const saved = await saveProfileHooks(id, input.value);
  if (!saved.ok) {
    return errorJson(saved.error, 500);
  }
  return json(input.value);
}

/**
 * Serves /api/hooks, /api/hooks/global, and /api/hooks/profiles/:id.
 *
 * @param req The request.
 * @param pathname The request's path.
 * @returns The response for the hooks routes.
 */
export function handleHooks(req: Request, pathname: string): Promise<Response> {
  const notAllowed = Promise.resolve(errorJson("Method not allowed", 405));
  if (pathname === "/api/hooks") {
    return req.method === "GET" ? allHooks() : notAllowed;
  }
  if (pathname === "/api/hooks/global") {
    return req.method === "PUT" ? putGlobal(req) : notAllowed;
  }
  const id = pathname.slice("/api/hooks/profiles/".length);
  return req.method === "PUT" ? putProfile(req, id) : notAllowed;
}
