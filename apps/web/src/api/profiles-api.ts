import {
  deleteProfile,
  listProfiles,
  readProfile,
  renameProfile,
  saveProfile,
  writeProfileBody,
} from "@vise/backend";
import { failedResult, str, type Reply } from "./wire/reply.ts";

/**
 * The web UI's profile editor: create, rename, edit the text of and delete the
 * profiles of the session's data directory, directly (never through a model
 * turn). A profile's tool whitelist and own hooks keep their own paths
 * (`profile_tools`, `/hooks profile ...`); saving the text keeps both.
 * Wire protocol (JSON):
 *   browser → server: { type:"profiles_list" }
 *                     { type:"profile_get", name }
 *                     { type:"profile_save", name, body, from? }   `from` is the profile being edited (a different
 *                         `name` renames it); without `from` the profile is created and an existing name is an error
 *                     { type:"profile_delete", name }
 *   server → browser: { type:"profiles", profiles:[name] }
 *                     { type:"profile", name, body }
 *                     { type:"profile_result", ok, deleted?, error?, name?, from? }   after a save or delete
 */

const list = (base: string): Reply => ({
  type: "profiles",
  profiles: listProfiles(base),
});

const failure = (error: unknown): Reply[] => failedResult("profile_result", error);

function save(base: string, msg: Record<string, unknown>): Reply[] {
  const name = str(msg["name"]).trim();
  const from = str(msg["from"]).trim();
  const body = str(msg["body"]);
  if (name === "") return failure(new Error("a profile needs a name"));
  try {
    if (from === "") saveProfile(base, name, body);
    else {
      if (from !== name) renameProfile(base, from, name);
      writeProfileBody(base, name, body);
    }
    const renamed = from !== "" && from !== name ? { from } : {};
    return [{ type: "profile_result", ok: true, name, ...renamed }, list(base)];
  } catch (error) {
    return failure(error);
  }
}

/** Handle a profile editor message; null when it is not one. */
export function handleProfileMessage(base: string, msg: Record<string, unknown>): Reply[] | null {
  const name = str(msg["name"]);
  switch (msg["type"]) {
    case "profiles_list":
      return [list(base)];
    case "profile_get": {
      const body = readProfile(base, name);
      if (body === undefined) return failure(new Error(`profile '${name}' not found`));
      return [{ type: "profile", name, body }];
    }
    case "profile_save":
      return save(base, msg);
    case "profile_delete":
      try {
        deleteProfile(base, name);
        return [{ type: "profile_result", ok: true, deleted: true, name }, list(base)];
      } catch (error) {
        return failure(error);
      }
    default:
      return null;
  }
}
