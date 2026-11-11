import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result, type TreeEntry } from "../../core/messages.ts";
import { resolveInside } from "./contain.ts";

// Lists the files under `path` (relative to `root`), recursing to `depth` directory
// levels. Depth 1 lists only the directory's own files. Hidden entries and links are
// skipped, and a path outside `root` is refused. Paths in the result are relative to `root`.
export async function listFiles(
  root: string,
  path: string,
  depth: number,
): Promise<Result<string>> {
  const inside = await resolveInside(root, path);
  if (!inside.ok) return err(inside.error);
  const files: string[] = [];
  try {
    await walk(inside.value.realTarget, inside.value.rel, depth, files);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  return ok(files.sort().join("\n"));
}

async function walk(
  dir: string,
  rel: string,
  depth: number,
  files: string[],
): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const entryRel = join(rel, entry.name);
    if (entry.isFile()) files.push(entryRel);
    else if (entry.isDirectory() && depth > 1)
      await walk(join(dir, entry.name), entryRel, depth - 1, files);
  }
}

// Lists the entries directly inside the folder `path` (relative to `root`): folders first, then files,
// each sorted by name. Hidden entries and links are skipped, and a path outside `root` is refused.
export async function listChildren(root: string, path: string): Promise<Result<TreeEntry[]>> {
  const inside = await resolveInside(root, path);
  if (!inside.ok) return err(inside.error);
  try {
    const entries: TreeEntry[] = [];
    for (const entry of await readdir(inside.value.realTarget, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      if (!entry.isFile() && !entry.isDirectory()) continue;
      entries.push({
        name: entry.name,
        path: join(inside.value.rel, entry.name),
        directory: entry.isDirectory(),
      });
    }
    entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    return ok(entries);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
