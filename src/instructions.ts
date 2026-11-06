import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The text of AGENTS.md in `directory`, or undefined when the file is missing, unreadable, or blank.
export async function readInstructions(
  directory: string,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(directory, "AGENTS.md"), "utf8");
  } catch {
    return undefined;
  }
  return text.trim() === "" ? undefined : text;
}
