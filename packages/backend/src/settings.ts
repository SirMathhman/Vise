import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";

import path from "node:path";

// The UI-saved key lives in a per-user config folder, outside the project, so the model's
// tools and the sandbox never see it. VISE_CONFIG_DIR overrides the folder. `--no-env-file`
// in the backend scripts stops Bun from loading any .env file on its own, and the key saved
// here takes precedence over OPENROUTER_API_KEY from the environment.
const KEY_NAME = "OPENROUTER_API_KEY";

function keyFile(): string {
  const dir =
    process.env.VISE_CONFIG_DIR ??
    path.join(process.env.APPDATA ?? homedir(), "vise");
  return path.join(dir, "openrouter.env");
}

async function readKeyLines(): Promise<string[]> {
  const file = Bun.file(keyFile());
  if (!(await file.exists())) {
    return [];
  }
  return (await file.text()).split(/\r?\n/).filter((line) => line.length > 0);
}

function isKeyLine(line: string): boolean {
  return line.startsWith(`${KEY_NAME}=`);
}

async function writeKeyLines(lines: string[]): Promise<void> {
  await mkdir(path.dirname(keyFile()), { recursive: true });
  await Bun.write(keyFile(), lines.map((line) => `${line}\n`).join(""));
}

/**
 * The key saved from the UI, or undefined when none is saved.
 *
 * @returns The saved key, or undefined when none is saved.
 */
export async function getSavedOpenRouterKey(): Promise<string | undefined> {
  const line = (await readKeyLines()).find(isKeyLine);
  const value = line?.slice(KEY_NAME.length + 1).trim();
  return value ? value : undefined;
}

/**
 * The UI-saved key wins; otherwise fall back to the environment variable.
 *
 * @returns The saved key when there is one, otherwise the environment variable, or undefined.
 */
export async function getOpenRouterKey(): Promise<string | undefined> {
  return (
    (await getSavedOpenRouterKey()) ?? (process.env[KEY_NAME] || undefined)
  );
}

/**
 * Saves the key to the config file, replacing any key saved before.
 *
 * @param apiKey The key to save.
 */
export async function saveOpenRouterKey(apiKey: string): Promise<void> {
  const lines = (await readKeyLines()).filter((line) => !isKeyLine(line));
  lines.push(`${KEY_NAME}=${apiKey}`);
  await writeKeyLines(lines);
}

/**
 * Removes the key saved from the UI. The environment variable is not affected.
 */
export async function clearSavedOpenRouterKey(): Promise<void> {
  await writeKeyLines(
    (await readKeyLines()).filter((line) => !isKeyLine(line)),
  );
}
