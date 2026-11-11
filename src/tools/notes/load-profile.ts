import { access } from "node:fs/promises";
import { join } from "node:path";
import {
  PROFILE_CATEGORY,
  bodyOf,
  checkName,
  notePath,
  parseHeader,
  type ProfileHook,
  type ProfileLoader,
} from "../../core/notes.ts";
import { err, ok, type Result } from "../../core/messages.ts";
import { readNote } from "./read-note.ts";

interface ProfileNote {
  text: string;
  tools?: string[];
  hooks?: ProfileHook[];
}

// Reads the profile's note: its text and its header. A profile that cannot be read, or has no text
// below its header, is refused.
async function readProfile(
  root: string,
  name: string,
): Promise<Result<ProfileNote>> {
  const text = await readNote(root, notePath(PROFILE_CATEGORY, name));
  if (!text.ok)
    return err(
      new Error(`profile ${name} could not be read: ${text.error.message}`),
    );
  const header = parseHeader(text.value);
  if (!header.ok)
    return err(
      new Error(`profile ${name} is not a note: ${header.error.message}`),
    );
  const body = bodyOf(text.value);
  if (body === "") return err(new Error(`profile ${name} is empty`));
  return ok({
    text: body,
    tools: header.value.tools,
    hooks: header.value.hooks,
  });
}

// The profile as the session reads it: the project folder's note, or the home folder's when the project has no
// note of that name. Only a missing note falls back, so a broken project note is still reported.
export async function readProfileIn(
  root: string,
  global: string | undefined,
  name: string,
): Promise<Result<ProfileNote>> {
  return readProfile(await profileFolder(root, global, name), name);
}

// The folder whose note the profile is: the project's when it has one, else the home folder's. A name that is not a
// valid profile name always means the project folder, which then refuses it.
export async function profileFolder(root: string, global: string | undefined, name: string): Promise<string> {
  if (global === undefined || !checkName(name, "profile name").ok) return root;
  const local = await access(join(root, notePath(PROFILE_CATEGORY, name))).then(
    () => true,
    () => false,
  );
  return local ? root : global;
}

// The loader for a working directory: the text below a profile's header.
export function loadProfile(root: string, global?: string): ProfileLoader {
  return async (name) => {
    const profile = await readProfileIn(root, global, name);
    if (!profile.ok) return profile;
    return ok(profile.value.text);
  };
}

// The tools a profile allows, from its `tools:` line. Undefined when it has none, so every tool is
// allowed. A name that is not a tool refuses the profile, so a typo cannot drop a tool silently.
export function loadProfileTools(
  root: string,
  known: string[],
  global?: string,
): (name: string) => Promise<Result<string[] | undefined>> {
  return async (name) => {
    const profile = await readProfileIn(root, global, name);
    if (!profile.ok) return profile;
    const unknown = (profile.value.tools ?? []).find(
      (tool) => !known.includes(tool),
    );
    if (unknown !== undefined)
      return err(
        new Error(`profile ${name} allows a tool that does not exist`),
      );
    return ok(profile.value.tools);
  };
}

// The hooks a profile adds, from its `<point>: <command>` lines. Empty when it adds none.
export function loadProfileHooks(
  root: string,
  global?: string,
): (name: string) => Promise<Result<ProfileHook[]>> {
  return async (name) => {
    const profile = await readProfileIn(root, global, name);
    if (!profile.ok) return profile;
    return ok(profile.value.hooks ?? []);
  };
}
