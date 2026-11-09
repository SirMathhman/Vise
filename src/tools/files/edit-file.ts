import { readFile, writeFile } from "node:fs/promises";
import { err, ok, type Result } from "../../core/messages.ts";
import { resolveInside } from "./contain.ts";

// Replaces the first occurrence of `previous` in an existing file under `root`. The match
// is exact, including line endings. The file is never created.
export async function editFile(
  root: string,
  path: string,
  previous: string,
  replacement: string,
): Promise<Result<string>> {
  const inside = await resolveInside(root, path);
  if (!inside.ok) return err(inside.error);
  const { realTarget, rel } = inside.value;
  try {
    const text = await readFile(realTarget, "utf8");
    const at = text.indexOf(previous);
    if (at < 0) return err(new Error("previous text was not found"));
    await writeFile(
      realTarget,
      text.slice(0, at) + replacement + text.slice(at + previous.length),
      "utf8",
    );
    return ok(`edited ${rel}`);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
