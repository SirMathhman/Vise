import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import type { Hooks, Result } from "common";
import { HooksSchema, err, ok, parseJson } from "common";
import { z } from "zod";
import { configDir } from "../config-dir";
import { runCaptured } from "../process/run";

// The commands are stored in the config folder, outside the project. The global commands are in
// one file; each profile's commands are keyed by its id in another.
const GLOBAL_FILE = "hooks.json";
const PROFILE_FILE = "profile-hooks.json";
const ProfileHooksFileSchema = z.record(z.string(), HooksSchema);

/**
 * The four events a hook can run at: before and after a session, and before and after a turn.
 */
export type HookName = keyof Hooks;

/**
 * How long a hook may run. The same limit a shell command gets.
 */
export const HOOK_TIMEOUT_MS = 30_000;

function configFile(name: string): string {
  return path.join(configDir(), name);
}

// A missing file holds no commands yet. A file that does not parse is reported, not ignored.
async function readConfig<S extends z.ZodType>(
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

// Written beside the file and renamed over it, so a crash mid-write keeps the last full copy.
async function writeConfig(name: string, value: unknown): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  const target = configFile(name);
  await Bun.write(`${target}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${target}.tmp`, target);
}

/**
 * The global commands, or none when no file exists yet.
 *
 * @returns The global commands, or a message when the file cannot be read.
 */
export function readGlobalHooks(): Promise<Result<Hooks, string>> {
  return readConfig(GLOBAL_FILE, HooksSchema, {});
}

/**
 * Every profile's commands, keyed by profile id.
 *
 * @returns The commands by profile id, or a message when the file cannot be read.
 */
export function readProfileHooks(): Promise<
  Result<Record<string, Hooks>, string>
> {
  return readConfig(PROFILE_FILE, ProfileHooksFileSchema, {});
}

/**
 * Replaces the global commands.
 *
 * @param hooks The new global commands.
 */
export async function saveGlobalHooks(hooks: Hooks): Promise<void> {
  await writeConfig(GLOBAL_FILE, hooks);
}

/**
 * Replaces one profile's commands, keeping the other profiles' commands.
 *
 * @param profileId The id of the profile.
 * @param hooks The profile's new commands.
 * @returns ok, or a message when the existing commands cannot be read.
 */
export async function saveProfileHooks(
  profileId: string,
  hooks: Hooks,
): Promise<Result<undefined, string>> {
  const all = await readProfileHooks();
  if (!all.ok) {
    return all;
  }
  await writeConfig(PROFILE_FILE, { ...all.value, [profileId]: hooks });
  return ok(undefined);
}

/**
 * Runs the commands for one event on the host, in the project root, through the shared process
 * runner. The global command runs first; then the chosen profile's command for the same event,
 * if it has one. A failure stops the rest. An event with no command succeeds without running
 * anything.
 *
 * @param name The event to run.
 * @param root The project root, where the commands run.
 * @param timeoutMs How long each command may run before it is stopped.
 * @param profileId The profile the session uses, if any.
 * @returns ok when every command set for the event exits with 0; otherwise the first failure, naming the hook.
 */
export async function runHook(
  name: HookName,
  root: string,
  timeoutMs = HOOK_TIMEOUT_MS,
  profileId?: string,
): Promise<Result<undefined, string>> {
  const global = await readGlobalHooks();
  if (!global.ok) {
    return global;
  }
  const commands: string[] = [];
  const globalCommand = global.value[name];
  if (globalCommand !== undefined) {
    commands.push(globalCommand);
  }
  if (profileId !== undefined) {
    const all = await readProfileHooks();
    if (!all.ok) {
      return all;
    }
    const own = Object.hasOwn(all.value, profileId)
      ? all.value[profileId]
      : undefined;
    const profileCommand = own?.[name];
    if (profileCommand !== undefined) {
      commands.push(profileCommand);
    }
  }
  for (const command of commands) {
    const finished = await runCommand(name, command, root, timeoutMs);
    if (!finished.ok) {
      return finished;
    }
  }
  return ok(undefined);
}

async function runCommand(
  name: HookName,
  command: string,
  root: string,
  timeoutMs: number,
): Promise<Result<undefined, string>> {
  // Bash runs every hook, on every platform, as the shell tool's host commands do. On Windows
  // that is Git Bash. cmd.exe would mangle the quotes in a command.
  const finished = await runCaptured(["bash", "-c", command], root, timeoutMs);
  if (!finished.ok) {
    return err(`The ${name} hook failed: ${finished.error}`);
  }
  if (finished.value.code === 0) {
    return ok(undefined);
  }
  return err(
    `The ${name} hook exited with code ${String(finished.value.code)}.\n${finished.value.output}`,
  );
}
