import path from "node:path";
import type { Result } from "common";
import { err, ok, parseJson } from "common";
import { z } from "zod";
import { configDir } from "../config-dir";

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

// Longest output kept in a failure message, counted from the end where the error usually is.
const MAX_OUTPUT_CHARS = 2000;

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
 * Runs the command set for one event on the host, in the project root. An event with no
 * command succeeds without running anything.
 *
 * @param name The event to run.
 * @param root The project root, where the command runs.
 * @returns ok when no command is set or it exits with 0; otherwise the failure with the end of its output.
 */
export async function runHook(
  name: HookName,
  root: string,
): Promise<Result<undefined, string>> {
  const config = await readHooks();
  if (!config.ok) {
    return config;
  }
  const command = config.value[name];
  if (command === undefined) {
    return ok(undefined);
  }
  const shell =
    process.platform === "win32"
      ? ["cmd.exe", "/d", "/s", "/c", command]
      : ["sh", "-c", command];
  const proc = Bun.spawn(shell, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code === 0) {
    return ok(undefined);
  }
  const output = `${stdout}${stderr}`.trim().slice(-MAX_OUTPUT_CHARS);
  return err(`The ${name} hook exited with code ${String(code)}.\n${output}`);
}
