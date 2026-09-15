import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { badRequest } from "./errors.js";

/**
 * Resolve a relative path against the root and guarantee it stays within it,
 * following symlinks so a link inside the root cannot point outside.
 *
 * @throws AppError (400) if the resolved target escapes the root.
 */
export async function resolveWithinRoot(
  root: string,
  rel: string,
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
  rel: string,
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
