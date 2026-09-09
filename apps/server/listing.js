import { readdir } from "node:fs/promises";

/**
 * Returns the top-level entry names (files and directories) of a directory,
 * sorted alphabetically. Defaults to the current working directory.
 */
export async function getListing(dir = process.cwd()) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
}
