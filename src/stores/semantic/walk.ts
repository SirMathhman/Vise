import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Largest file that is indexed (bytes). */
export const EMBED_MAX_BYTES = 1_000_000;

/** Folders never indexed: dependencies, build output, repository and Vise's own data. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".vise", "dist", "out", "build", "coverage", "target", "vendor"]);

/**
 * Files that hold secrets: a key or an environment file must not be turned into
 * vectors (and, with a hosted embedder, sent anywhere). Matched on the name.
 */
export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith(".env") ||
    /\.(pem|key|p12|pfx|jks|keystore|ppk)$/.test(lower) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(lower) ||
    /^(secrets?|credentials?)(\.|$)/.test(lower) ||
    lower === ".npmrc" ||
    lower === ".netrc"
  );
}

/** A file that may be indexed, found without reading it. */
export interface IndexableFile {
  /** Path relative to the root, with `/` separators (how the index and the tools name files). */
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * Every file under `root` that may be indexed: no symlinks, no hidden files or
 * folders, nothing in `SKIP_DIRS`, no secrets, nothing empty or over `maxBytes`.
 * Only `stat`s: contents are read (and a binary file turned away) by `readText`.
 */
export function listIndexable(root: string, maxBytes: number = EMBED_MAX_BYTES): IndexableFile[] {
  const found: IndexableFile[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && !isSecretName(entry.name)) {
        try {
          const stat = statSync(full);
          if (stat.size > 0 && stat.size <= maxBytes) {
            found.push({ path: relative(root, full).split(sep).join("/"), mtimeMs: stat.mtimeMs, size: stat.size });
          }
        } catch {
          // Vanished while walking: not indexed.
        }
      }
    }
  }
  return found;
}

/** A file's text, or undefined when it cannot be read or is binary (a NUL byte in its first 8 KB). */
export function readText(root: string, path: string): string | undefined {
  try {
    const bytes = readFileSync(join(root, ...path.split("/")));
    if (bytes.subarray(0, 8192).includes(0)) return undefined;
    return bytes.toString("utf-8");
  } catch {
    return undefined;
  }
}
