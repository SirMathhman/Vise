import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Repo root: three levels up from the file (apps/server/listing.js → repo root)
export const repoRoot = resolve(
  fileURLToPath(import.meta.url),
  "..",
  "..",
  "..",
);

/**
 * Returns the entries (name + isDirectory) of a directory,
 * sorted alphabetically. Defaults to the repository root.
 */
export async function getListing(dir = repoRoot) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
