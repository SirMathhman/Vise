import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
const PROFILE_TEMPLATE =
  "TODO: describe the persona or instructions for this profile";

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
 * A profile file split into its optional frontmatter and its body. The
 * frontmatter is a `---` block at the top of the file; its `tools:` line is a
 * comma-separated whitelist of the tools the profile may use, its `hooks:` line
 * is a JSON array of the hook commands bound to the profile, and any other
 * frontmatter lines are kept verbatim in `meta` so rewriting never drops them.
 */
export interface ParsedProfile {
  tools?: string[];
  hooks?: string[];
  meta: string[];
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split profile file text into frontmatter fields and body. */
export function parseProfile(text: string): ParsedProfile {
  const match = FRONTMATTER.exec(text);
  if (!match) return { meta: [], body: text };
  const meta: string[] = [];
  let tools: string[] | undefined;
  let hooks: string[] | undefined;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const h = /^hooks:\s*(\[.*\])\s*$/.exec(line);
    const parsedHooks = h ? parseHookList(h[1] ?? "") : undefined;
    if (parsedHooks) {
      hooks = parsedHooks;
      continue;
    }
    const m = /^tools:\s*(.*)$/.exec(line);
    if (m) {
      tools = (m[1] ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "");
    } else {
      meta.push(line);
    }
  }
  return { tools, hooks, meta, body: text.slice(match[0].length) };
}

/** A `hooks:` value: a JSON array of command strings, or undefined when it is anything else. */
function parseHookList(json: string): string[] | undefined {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.every((c) => typeof c === "string")
      ? value
      : undefined;
  } catch {
    return undefined;
  }
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
  return parseProfile(readFileSync(p, "utf8")).body;
}

/** A profile's tool whitelist, or undefined when it has none (or no file). */
export function readProfileTools(
  base: string,
  name: string,
): string[] | undefined {
  const p = profilePath(base, name);
  if (!existsSync(p)) return undefined;
  return parseProfile(readFileSync(p, "utf8")).tools;
}

/**
 * Set (or, with undefined, clear) a profile's tool whitelist, preserving its
 * body and other frontmatter. Throws an `Error` when the profile is missing.
 */
export function setProfileTools(
  base: string,
  name: string,
  tools: string[] | undefined,
): void {
  const p = profilePath(base, name);
  if (!existsSync(p)) throw new Error(`profile '${name}' not found`);
  const parsed = parseProfile(readFileSync(p, "utf8"));
  writeFileSync(p, renderProfile({ ...parsed, tools }), "utf8");
}

/** The hook commands bound to every profile that has any, by profile name. */
export function readAllProfileHooks(base: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const name of listProfiles(base)) {
    const text = readFileSync(profilePath(base, name), "utf8");
    const hooks = parseProfile(text).hooks;
    if (hooks && hooks.length > 0) out[name] = hooks;
  }
  return out;
}

/**
 * Set (or, with undefined or an empty list, clear) the hook commands bound to
 * a profile, preserving its body and other frontmatter. Throws an `Error` when
 * the profile is missing.
 */
export function setProfileHooks(
  base: string,
  name: string,
  hooks: string[] | undefined,
): void {
  const p = profilePath(base, name);
  if (!existsSync(p)) throw new Error(`profile '${name}' not found`);
  const parsed = parseProfile(readFileSync(p, "utf8"));
  const bound = hooks && hooks.length > 0 ? hooks : undefined;
  writeFileSync(p, renderProfile({ ...parsed, hooks: bound }), "utf8");
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
  writeFileSync(
    profilePath(base, name),
    body.replace(/\s+$/, "") + "\n",
    "utf8",
  );
}

/**
 * Initialize a profile with a placeholder template body. Throws an `Error`
 * when the name is invalid or already exists (same rules as `saveProfile`).
 */
export function initProfile(base: string, name: string): void {
  saveProfile(base, name, PROFILE_TEMPLATE);
}
