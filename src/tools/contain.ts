import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "../core/result.ts";

export interface Inside {
  // The real location to read, with links followed.
  realTarget: string;
  // The path relative to the working directory, as the model named it, for display.
  rel: string;
}

// Resolves `path` under `root` and checks that it stays inside `root`. The check is done
// on the real paths, so a link inside the working directory cannot lead outside it.
export async function resolveInside(root: string, path: string): Promise<Result<Inside>> {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (outside(rel)) return err(new Error("path is outside the working directory"));
  if (rel.split(sep).some((part) => part.startsWith("."))) return err(new Error("hidden paths are refused"));
  try {
    const realRoot = await realpath(root);
    const realTarget = await realpath(target);
    if (outside(relative(realRoot, realTarget))) return err(new Error("path is outside the working directory"));
    return ok({ realTarget, rel });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

function outside(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
