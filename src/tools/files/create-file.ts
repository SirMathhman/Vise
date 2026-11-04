import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { err, ok, type Result } from "../../core/result.ts";
import { resolveNewInside } from "./contain.ts";

// Creates a new file under `root` with `content`, creating the folders above it that do not
// exist. An existing file is never overwritten.
export async function createFile(root: string, path: string, content: string): Promise<Result<string>> {
  const place = await resolveNewInside(root, path);
  if (!place.ok) return err(place.error);
  const { realTarget, rel } = place.value;
  try {
    await mkdir(dirname(realTarget), { recursive: true });
    await writeFile(realTarget, content, { encoding: "utf8", flag: "wx" });
    return ok(`created ${rel}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return err(new Error("the file already exists"));
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
