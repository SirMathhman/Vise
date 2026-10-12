import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write `content` to `path` through a temp file and a rename, so a crash can
 * never leave half a file, creating the folder when it is missing. Throws on
 * an I/O failure (the callers each report it in their own result type).
 * `mode` is for files that may hold secrets (`0o600`).
 */
export function writeFileAtomic(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, content, mode === undefined ? "utf8" : { mode });
  renameSync(temp, path);
}
