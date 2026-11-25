import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import type { Result, ToolSettings } from "common";
import { ToolSettingsSchema, err, ok, parseJson } from "common";
import { configDir } from "../config-dir";

// Kept in the config folder, outside the project, beside the other settings files.
const SETTINGS_FILE = "tools.json";

function settingsFile(): string {
  return path.join(configDir(), SETTINGS_FILE);
}

/**
 * The tools the user has turned off. A missing file turns none off.
 *
 * @returns The settings, or a message when the file cannot be read.
 */
export async function readToolSettings(): Promise<
  Result<ToolSettings, string>
> {
  const file = Bun.file(settingsFile());
  if (!(await file.exists())) {
    return ok({ disabled: [] });
  }
  const parsed = parseJson(ToolSettingsSchema, await file.text());
  return parsed.ok
    ? ok(parsed.value)
    : err(`${SETTINGS_FILE} could not be read. Check that it is valid JSON.`);
}

/**
 * Replaces the settings. Written beside the file and renamed over it, so a crash mid-write keeps
 * the last full copy.
 *
 * @param settings The new settings.
 */
export async function saveToolSettings(settings: ToolSettings): Promise<void> {
  await mkdir(configDir(), { recursive: true });
  const target = settingsFile();
  await Bun.write(`${target}.tmp`, JSON.stringify(settings, null, 2));
  await rename(`${target}.tmp`, target);
}
