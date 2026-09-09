import { readdir, readFile, stat } from "node:fs/promises";
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

/**
 * Returns the text content of a file at the given absolute path.
 * Throws if the path is not a regular file.
 * @param {string} filePath - Absolute path to the file.
 * @returns {Promise<string>} The file's text content.
 */
export async function getFileContent(filePath) {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("Not a file");
  return readFile(filePath, "utf8");
}
