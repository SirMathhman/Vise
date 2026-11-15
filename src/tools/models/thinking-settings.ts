import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type ReasoningEffort, type Result } from "../../core/messages.ts";

// The thinking level chosen with /thinking or the page's control, saved in the working directory and read at
// startup. A session with no saved level thinks at the default.
const SETTINGS_FOLDER = ".vise";
const SETTINGS_FILE = join(SETTINGS_FOLDER, "thinking.json");
export const DEFAULT_THINKING: ReasoningEffort = "low";

const LEVELS = ["off", "low", "medium", "high"] as const;

interface ThinkingFile {
  thinking?: unknown;
}

// Reads the saved level. `undefined` means thinking is off. A missing file gives the default; a file that is
// not JSON, or names no known level, is an error.
export async function readThinkingSetting(
  root: string,
): Promise<Result<ReasoningEffort | undefined>> {
  let text: string;
  try {
    text = await readFile(join(root, SETTINGS_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return ok(DEFAULT_THINKING);
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
  const { thinking } = value as ThinkingFile;
  if (!LEVELS.some((level) => level === thinking))
    return err(new Error(`${SETTINGS_FILE} must name off, low, medium, or high`));
  return ok(thinking === "off" ? undefined : (thinking as ReasoningEffort));
}

// Writes the chosen level, creating the settings folder if needed. `undefined` is off.
export async function saveThinkingSetting(
  root: string,
  effort: ReasoningEffort | undefined,
): Promise<Result<void>> {
  try {
    await mkdir(join(root, SETTINGS_FOLDER), { recursive: true });
    await writeFile(
      join(root, SETTINGS_FILE),
      `${JSON.stringify({ thinking: effort ?? "off" }, null, 2)}\n`,
      "utf8",
    );
    return ok(undefined);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
