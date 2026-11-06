import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../core/result.ts";
import { toolNames } from "../core/tools.ts";

// The settings file, in the working directory. It holds the names of the tools switched off.
const SETTINGS_FOLDER = ".vise";
const SETTINGS_FILE = join(SETTINGS_FOLDER, "tools.json");

interface SettingsFile {
  disabled?: unknown;
}

// Reads the tools switched off. A missing file switches none off. A file that is not JSON, or
// names a tool that does not exist, is an error.
export async function readToolSettings(root: string): Promise<Result<string[]>> {
  let text: string;
  try {
    text = await readFile(join(root, SETTINGS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err(new Error(`${SETTINGS_FILE} is not JSON`));
  }
  if (typeof value !== "object" || value === null) return err(new Error(`${SETTINGS_FILE} must hold an object`));
  const { disabled } = value as SettingsFile;
  if (disabled === undefined) return ok([]);
  if (!Array.isArray(disabled) || !disabled.every((name) => typeof name === "string")) {
    return err(new Error(`${SETTINGS_FILE} must list disabled tools as strings`));
  }
  const names = disabled as string[];
  if (names.some((name) => !toolNames.includes(name))) {
    return err(new Error(`${SETTINGS_FILE} names a tool that does not exist`));
  }
  return ok(names);
}

// Writes the tools switched off, creating the settings folder if needed.
export async function saveToolSettings(root: string, names: string[]): Promise<Result<void>> {
  try {
    await mkdir(join(root, SETTINGS_FOLDER), { recursive: true });
    await writeFile(join(root, SETTINGS_FILE), `${JSON.stringify({ disabled: names }, null, 2)}\n`, "utf8");
    return ok(undefined);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
