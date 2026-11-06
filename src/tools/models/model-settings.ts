import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../../core/result.ts";

// The model chosen with /model, saved in the working directory and read at startup.
const SETTINGS_FOLDER = ".vise";
const SETTINGS_FILE = join(SETTINGS_FOLDER, "model.json");

interface ModelFile {
  model?: unknown;
}

// Reads the saved model. A missing file has none. A file that is not JSON, or does not name a model
// as a string, is an error.
export async function readModelSetting(
  root: string,
): Promise<Result<string | undefined>> {
  let text: string;
  try {
    text = await readFile(join(root, SETTINGS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return ok(undefined);
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err(new Error(`${SETTINGS_FILE} is not JSON`));
  }
  if (typeof value !== "object" || value === null)
    return err(new Error(`${SETTINGS_FILE} must hold an object`));
  const { model } = value as ModelFile;
  if (typeof model !== "string" || model === "")
    return err(new Error(`${SETTINGS_FILE} must name a model`));
  return ok(model);
}

// Writes the chosen model, creating the settings folder if needed.
export async function saveModelSetting(
  root: string,
  model: string,
): Promise<Result<void>> {
  try {
    await mkdir(join(root, SETTINGS_FOLDER), { recursive: true });
    await writeFile(
      join(root, SETTINGS_FILE),
      `${JSON.stringify({ model }, null, 2)}\n`,
      "utf8",
    );
    return ok(undefined);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
