import path from "node:path";
import type { Result } from "common";
import { err, ok, parseJson } from "common";
import { z } from "zod";
import { configDir } from "../config-dir";
import { runCaptured } from "../process/run";

// The commands the user sets in hooks.json in the config folder, outside the project. Each is
// optional. A missing file sets none.
const HooksFileSchema = z.object({
  beforeSession: z.string().min(1).optional(),
  afterSession: z.string().min(1).optional(),
  beforeTurn: z.string().min(1).optional(),
  afterTurn: z.string().min(1).optional(),
});

/**
 * The four events a hook can run at: before and after a session, and before and after a turn.
 */
export type HookName = keyof z.infer<typeof HooksFileSchema>;

/**
 * How long a hook may run. The same limit a shell command gets.
 */
export const HOOK_TIMEOUT_MS = 30_000;

function hooksFile(): string {
  return path.join(configDir(), "hooks.json");
}

async function readHooks(): Promise<
  Result<z.infer<typeof HooksFileSchema>, string>
> {
  const file = Bun.file(hooksFile());
  if (!(await file.exists())) {
    return ok({});
  }
  const parsed = parseJson(HooksFileSchema, await file.text());
  return parsed.ok
    ? ok(parsed.value)
    : err("hooks.json could not be read. Check that it is valid JSON.");
}

/**
 * Runs the command set for one event on the host, in the project root, through the shared
 * process runner. An event with no command succeeds without running anything.
 *
 * @param name The event to run.
 * @param root The project root, where the command runs.
 * @param timeoutMs How long the command may run before it is stopped.
 * @returns ok when no command is set or it exits with 0; otherwise the failure, naming the hook.
 */
export async function runHook(
  name: HookName,
  root: string,
  timeoutMs = HOOK_TIMEOUT_MS,
): Promise<Result<undefined, string>> {
  const config = await readHooks();
  if (!config.ok) {
    return config;
  }
  const command = config.value[name];
  if (command === undefined) {
    return ok(undefined);
  }
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
