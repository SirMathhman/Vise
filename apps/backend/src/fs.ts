import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { badRequest } from "./errors.js";

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
