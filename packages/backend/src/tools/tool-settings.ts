import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import type { Result, ToolSettings } from "common";
import { ToolSettingsSchema, err, ok, parseJson } from "common";
import { z } from "zod";
import { configDir } from "../config-dir";

// Kept in the config folder, outside the project, beside the other settings files.
const SETTINGS_FILE = "tools.json";
const PROFILE_TOOLS_FILE = "profile-tools.json";
const ProfileToolListsSchema = z.record(z.string(), z.array(z.string()));

/**
 * Each profile's whitelist of tools, keyed by profile id.
 */
export type ProfileToolLists = Record<string, string[]>;

// Saves run one after another, so two edits to the same file cannot overwrite each other.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task);
  queue = run.catch(() => undefined);
  return run;
}

function configFile(name: string): string {
  return path.join(configDir(), name);
}

// A missing file holds nothing yet. A file that does not parse is reported, not ignored.
async function readFileAs<S extends z.ZodType>(
  name: string,
  schema: S,
  empty: z.output<S>,
): Promise<Result<z.output<S>, string>> {
  const file = Bun.file(configFile(name));
  if (!(await file.exists())) {
    return ok(empty);
  }
  const parsed = parseJson(schema, await file.text());
  return parsed.ok
    ? ok(parsed.value)
    : err(`${name} could not be read. Check that it is valid JSON.`);
}

// Written beside the file under a unique name, then renamed over it, so a crash mid-write keeps
// the last full copy.
async function writeFileAs(name: string, value: unknown): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  const target = configFile(name);
  const temp = `${target}.${randomUUID()}.tmp`;
  await Bun.write(temp, JSON.stringify(value, null, 2));
  await rename(temp, target);
}

/**
 * The tools the user has turned off. A missing file turns none off.
 *
 * @returns The settings, or a message when the file cannot be read.
 */
export function readToolSettings(): Promise<Result<ToolSettings, string>> {
  return readFileAs(SETTINGS_FILE, ToolSettingsSchema, { disabled: [] });
}

/**
 * Replaces the settings.
 *
 * @param settings The new settings.
 * @returns Resolves once the settings are saved.
 */
export function saveToolSettings(settings: ToolSettings): Promise<void> {
  return serialized(() => writeFileAs(SETTINGS_FILE, settings));
}

/**
 * Every profile's whitelist. A missing file has none.
 *
 * @returns The whitelists by profile id, or a message when the file cannot be read.
 */
export function readProfileToolLists(): Promise<
  Result<ProfileToolLists, string>
> {
  return readFileAs(PROFILE_TOOLS_FILE, ProfileToolListsSchema, {});
}

/**
 * Sets one profile's whitelist, or removes it so the profile has none.
 *
 * @param profileId The profile's id.
 * @param tools The tools the profile may use, or undefined to remove its whitelist.
 * @returns ok, or a message when the existing whitelists cannot be read.
 */
export function saveProfileToolList(
  profileId: string,
  tools: string[] | undefined,
): Promise<Result<undefined, string>> {
  return serialized(async () => {
    const lists = await readProfileToolLists();
    if (!lists.ok) {
      return lists;
    }
    const kept = Object.entries(lists.value).filter(([id]) => id !== profileId);
    const next: ProfileToolLists = Object.fromEntries(
      tools === undefined ? kept : [...kept, [profileId, tools]],
    );
    await writeFileAs(PROFILE_TOOLS_FILE, next);
    return ok(undefined);
  });
}
