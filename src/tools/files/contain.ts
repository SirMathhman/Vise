import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "../../core/messages.ts";

export interface Inside {
  // The real location to read, with links followed.
  realTarget: string;
  // The path relative to the working directory, as the model named it, for display.
  rel: string;
}

// Resolves `path` under `root` and checks that it stays inside `root` and names no hidden
// entry. Both checks are done on the typed path and on the real paths, so a link inside
// the working directory can neither lead outside it nor reach a hidden entry.
export async function resolveInside(
  root: string,
  path: string,
): Promise<Result<Inside>> {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (outside(rel))
    return err(new Error("path is outside the working directory"));
  if (hidden(rel)) return err(new Error("hidden paths are refused"));
  try {
    const realRoot = await realpath(root);
    const realTarget = await realpath(target);
    const realRel = relative(realRoot, realTarget);
    if (outside(realRel))
      return err(new Error("path is outside the working directory"));
    if (hidden(realRel)) return err(new Error("hidden paths are refused"));
    return ok({ realTarget, rel });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

// Like resolveInside, for a path that may not exist yet. The part that exists is checked
// through its real location; the part that does not exist yet is checked as typed. The
// returned realTarget is where the new file goes.
export async function resolveNewInside(
  root: string,
  path: string,
): Promise<Result<Inside>> {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (outside(rel))
    return err(new Error("path is outside the working directory"));
  if (hidden(rel)) return err(new Error("hidden paths are refused"));
  try {
    const realRoot = await realpath(root);
    let existing = target;
    while (!(await exists(existing))) existing = dirname(existing);
    const realExisting = await realpath(existing);
    const realRel = relative(realRoot, realExisting);
    if (outside(realRel))
      return err(new Error("path is outside the working directory"));
    if (hidden(realRel)) return err(new Error("hidden paths are refused"));
    return ok({
      realTarget: join(realExisting, relative(existing, target)),
      rel,
    });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function outside(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function hidden(rel: string): boolean {
  return rel.split(sep).some((part) => part.startsWith("."));
}
