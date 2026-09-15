import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { AppError, badRequest } from "./errors.js";

/**
 * Resolve a relative path against the root and guarantee it stays within it,
 * following symlinks so a link inside the root cannot point outside.
 *
 * @throws AppError (400) if the resolved target escapes the root.
 */
export async function resolveWithinRoot(
  root: string,
  rel: string
): Promise<string> {
  const realRoot = await realpath(root);
  const target = resolve(realRoot, rel);
  const realTarget = await realpath(target);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw badRequest(`path escapes root: ${rel}`);
  }
  return realTarget;
}

/**
 * Resolve the path of a file/directory about to be created. Unlike
 * {@link resolveWithinRoot}, this does not require the target to exist: it
 * resolves and validates the existing parent directory, then joins a single
 * leaf segment that has already been vetted (no separators, no dot segments),
 * so the result is guaranteed to stay within the root.
 *
 * @throws AppError (400) if the parent escapes the root.
 */
export async function resolveForCreate(
  root: string,
  rel: string
): Promise<string> {
  const parentRel = dirname(rel);
  const leaf = basename(rel);
  if (leaf === "" || leaf === "." || leaf === "..")
    throw badRequest(`invalid path: ${rel}`);
  const realParent =
    parentRel === "."
      ? await realpath(root)
      : await resolveWithinRoot(root, parentRel);
  return join(realParent, leaf);
}

/**
 * Vet a relative path for creation: reject empty names, empty segments, dot
 * segments, backslashes, and segments longer than 255 characters. Shared by
 * every create call site so the rules cannot drift between the HTTP and LLM
 * surfaces.
 */
export function validatePath(rel: string): void {
  if (!rel) throw badRequest("a name is required");
  for (const seg of rel.split("/")) {
    if (!seg) throw badRequest(`empty path segment in: ${rel}`);
    if (seg === "." || seg === "..")
      throw badRequest(`invalid path segment: ${seg}`);
    if (seg.includes("\\"))
      throw badRequest(`name cannot contain a backslash: ${seg}`);
    if (seg.length > 255) throw badRequest(`name too long (max 255): ${seg}`);
  }
}

/** Throw 400 if `target` already exists. */
export async function assertDoesNotExist(
  target: string,
  rel: string
): Promise<void> {
  try {
    await stat(target);
    throw badRequest(`already exists: ${rel}`);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Create a new directory under the root. Vets the path, resolves it, ensures
 * it does not already exist, and creates it. Returns the resolved absolute
 * path. Throws AppError for vetting/existence failures; raw fs errors (e.g.
 * EACCES) propagate to the caller for mapping.
 */
export async function createDir(root: string, rel: string): Promise<string> {
  validatePath(rel);
  const target = await resolveForCreate(root, rel);
  await assertDoesNotExist(target, rel);
  await mkdir(target);
  return target;
}

/**
 * Create a new file under the root with the given content. Vets the path,
 * resolves it, ensures it does not already exist, and writes it. Returns the
 * resolved absolute path. Throws AppError for vetting/existence failures; raw
 * fs errors (e.g. EACCES) propagate to the caller for mapping.
 */
export async function createFile(
  root: string,
  rel: string,
  content: string
): Promise<string> {
  validatePath(rel);
  const target = await resolveForCreate(root, rel);
  await assertDoesNotExist(target, rel);
  await writeFile(target, content, "utf-8");
  return target;
}
