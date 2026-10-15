import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { validName } from "./notes.ts";
import { parseProfileText, type ParsedProfile } from "@vise/core";

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

/** Rebuild profile file text from its parts (no frontmatter when empty). */
function renderProfile(parsed: ParsedProfile): string {
  const lines = [...parsed.meta];
  if (parsed.hooks !== undefined) {
    lines.push(`hooks: ${JSON.stringify(parsed.hooks)}`);
  }
  if (parsed.tools !== undefined) {
    lines.push(`tools: ${parsed.tools.join(", ")}`);
  }
  if (lines.length === 0) return parsed.body;
  return `---\n${lines.join("\n")}\n---\n${parsed.body}`;
}

/**
 * Read a profile's body (frontmatter removed). Returns the text, or undefined
 * when no profile of that name exists.
 */
export function readProfile(base: string, name: string): string | undefined {
  const p = profilePath(base, name);
  if (!existsSync(p)) return undefined;
  return parseProfileText(readFileSync(p, "utf8")).body;
}

/** A profile's tool whitelist, or undefined when it has none (or no file). */
export function readProfileTools(base: string, name: string): string[] | undefined {
  const p = profilePath(base, name);
  if (!existsSync(p)) return undefined;
  return parseProfileText(readFileSync(p, "utf8")).tools;
}

/**
 * Set (or, with undefined, clear) a profile's tool whitelist, preserving its
 * body and other frontmatter. Throws an `Error` when the profile is missing.
 */
export function setProfileTools(base: string, name: string, tools: string[] | undefined): void {
  const p = profilePath(base, name);
  if (!existsSync(p)) throw new Error(`profile '${name}' not found`);
  const parsed = parseProfileText(readFileSync(p, "utf8"));
  writeFileSync(p, renderProfile({ ...parsed, tools }), "utf8");
}

/** The hooks each profile owns (profiles with none are omitted), by profile name. */
export function readAllProfileHooks(base: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of listProfiles(base)) {
    const text = readFileSync(profilePath(base, name), "utf8");
    const hooks = parseProfileText(text).hooks;
    if (hooks && hooks.length > 0) out[name] = hooks;
  }
  return out;
}

/**
 * Set (or, with undefined or an empty list, clear) the hooks owned by
 * a profile, preserving its body and other frontmatter. Throws an `Error` when
 * the profile is missing.
 */
export function setProfileHooks(base: string, name: string, hooks: string[] | undefined): void {
  const p = profilePath(base, name);
  if (!existsSync(p)) throw new Error(`profile '${name}' not found`);
  const parsed = parseProfileText(readFileSync(p, "utf8"));
  const owned = hooks && hooks.length > 0 ? hooks : undefined;
  writeFileSync(p, renderProfile({ ...parsed, hooks: owned }), "utf8");
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

/**
 * Replace a profile's body, keeping its frontmatter (tool whitelist, hooks and
 * any other lines). Throws an `Error` when the profile is missing.
 */
export function writeProfileBody(base: string, name: string, body: string): void {
  const p = profilePath(base, name);
  if (!existsSync(p)) throw new Error(`profile '${name}' not found`);
  const parsed = parseProfileText(readFileSync(p, "utf8"));
  const text = body.replace(/\s+$/, "") + "\n";
  writeFileSync(p, renderProfile({ ...parsed, body: text }), "utf8");
}

/**
 * Rename a profile file. Throws an `Error` when the new name is invalid or
 * taken, or the profile is missing.
 */
export function renameProfile(base: string, from: string, to: string): void {
  if (!validName(to)) throw new Error(`invalid profile name '${to}'`);
  if (!existsSync(profilePath(base, from))) {
    throw new Error(`profile '${from}' not found`);
  }
  if (existsSync(profilePath(base, to))) {
    throw new Error(`profile '${to}' already exists`);
  }
  renameSync(profilePath(base, from), profilePath(base, to));
}

/** Delete a profile file. Throws an `Error` when it is missing. */
export function deleteProfile(base: string, name: string): void {
  const p = profilePath(base, name);
  if (!existsSync(p)) throw new Error(`profile '${name}' not found`);
  unlinkSync(p);
}
