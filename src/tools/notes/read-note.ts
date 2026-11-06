import { readFile } from "node:fs/promises";
import { err, ok, type Result } from "../../core/result.ts";
import { resolveInside } from "../files/contain.ts";

// Reads a note's text through the containment check, so a link out of the working directory is not followed.
export async function readNote(root: string, rel: string): Promise<Result<string>> {
  const place = await resolveInside(root, rel);
  if (!place.ok) return place;
  try {
    return ok(await readFile(place.value.realTarget, "utf8"));
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
