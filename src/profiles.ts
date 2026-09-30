import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validName } from "./notes.ts";

/**
 * Shared profile-file I/O for the edge. Profiles are the project's store of
 * per-persona instruction files. Each profile is a single `.md` file under
 * `profiles/`, where the filename (minus extension) is the profile name and
 * the whole file is the profile body.
 *
 * This module is edge I/O (invariant #2). It is shared by the model-facing
 * subagent handler (`tools/subagent.ts`, which loads a named profile for an
 * isolated conversation) and the user-facing `/profile` command's
 * `ProfileSource` (`index.ts`), so the file layout and naming rules live in
 * one place. The naming rule is the same as notes', so `validName` is reused
 * from `notes.ts`.
 */

/** The placeholder body for a newly initialized profile. */
const PROFILE_TEMPLATE = "TODO: describe the persona or instructions for this profile";

/** Path of the profiles directory under the base directory. */
function profileDir(base: string): string {
  return join(base, "profiles");
}

/** Path of a single profile file. */
function profilePath(base: string, name: string): string {
  return join(profileDir(base), `${name}.md`);
}

/**
 * List every profile under `base`, sorted by name. Returns an empty array
 * when no `profiles/` directory exists.
 */
export function listProfiles(base: string): string[] {
  const dir = profileDir(base);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

/**
 * Read a profile's full body. Returns the text, or undefined when no profile
 * of that name exists.
 */
export function readProfile(base: string, name: string): string | undefined {
  const p = profilePath(base, name);
  if (!existsSync(p)) return undefined;
  return readFileSync(p, "utf8");
}

/**
 * Save a profile. Throws an `Error` (caught by the caller into a string
 * result) when the name is invalid or already exists.
 */
export function saveProfile(base: string, name: string, body: string): void {
  if (!validName(name)) {
    throw new Error(`invalid profile name '${name}'`);
  }
  if (existsSync(profilePath(base, name))) {
    throw new Error(`profile '${name}' already exists`);
  }
  mkdirSync(profileDir(base), { recursive: true });
  writeFileSync(profilePath(base, name), body.replace(/\s+$/, "") + "\n", "utf8");
}

/**
 * Initialize a profile with a placeholder template body. Throws an `Error`
 * when the name is invalid or already exists (same rules as `saveProfile`).
 */
export function initProfile(base: string, name: string): void {
  saveProfile(base, name, PROFILE_TEMPLATE);
}
