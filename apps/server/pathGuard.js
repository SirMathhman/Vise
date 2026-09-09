import { resolve, sep, normalize } from "node:path";

/**
 * Resolves `rel` against `root` and returns the absolute path only if it is
 * `root` itself or a child of `root` (segment-aware). Returns null otherwise.
 */
export function resolveWithin(root, rel) {
  const resolvedRoot = resolve(root);
  const cleaned = normalize(rel).replace(/^([/\\])+/, "");
  const resolved = resolve(resolvedRoot, cleaned);
  if (resolved === resolvedRoot) return resolved;
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : resolvedRoot + sep;
  return resolved.startsWith(prefix) ? resolved : null;
}
