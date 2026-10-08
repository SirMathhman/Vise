import { config } from "../config.ts";
import { isTooLarge } from "./temp-store.ts";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function listDirectory(args: Record<string, unknown>): string {
  try {
    const entries = readdirSync(String(args.path ?? "."));
    return entries.join("\n");
  } catch (err) {
    return errStr(err);
  }
}

/**
 * Read a file, or `limit` lines of it from line `offset`. A small file comes
 * back whole; a big one (or a range) comes back as at most `MAX_LINES` lines
 * and `MAX_CHARS` characters with a header and a pointer to the rest, so one
 * read can never flood the context.
 */
export function readFile(args: Record<string, unknown>): string {
  try {
    const text = readFileSync(String(args.path ?? ""), "utf8");
    const ranged =
      typeof args.offset === "number" || typeof args.limit === "number";
    if (!ranged && !isTooLarge(text)) return text;
    const all = text.split(/\r?\n/);
    const num = (v: unknown, fallback: number): number =>
      typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
    const from = Math.max(1, num(args.offset, 1));
    if (all.length < from) {
      return `error: the file has ${all.length} lines; there is nothing at line ${from}`;
    }
    const count = Math.min(config.resultMaxLines, Math.max(1, num(args.limit, config.resultMaxLines)));
    let shown = all.slice(from - 1, from - 1 + count).join("\n");
    let last = Math.min(all.length, from - 1 + count);
    if (shown.length > config.resultMaxChars) {
      shown = shown.slice(0, config.resultMaxChars);
      last = from - 1 + shown.split("\n").length;
    }
    const more =
      last < all.length
        ? `\n[${all.length - last} more lines: continue with offset ${last + 1}]`
        : "";
    return `[lines ${from}-${last} of ${all.length}]\n${shown}${more}`;
  } catch (err) {
    return errStr(err);
  }
}

export function createFile(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  if (path === "") return `error: path must not be empty`;
  try {
    if (existsSync(path)) {
      return `error: ${path} already exists; use edit_file to modify it`;
    }
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(path, String(args.content ?? ""), "utf8");
    } catch (err) {
      // The open succeeded (file now exists, possibly empty/partial).
      // Remove it so a retry isn't told "already exists" for a file
      // this tool just made.
      try {
        unlinkSync(path);
      } catch {
        // File may not exist; the original error is what matters.
      }
      throw err;
    }
    return `created ${path}`;
  } catch (err) {
    return errStr(err);
  }
}

export function editFile(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  const old = String(args.old_string ?? "");
  const next = String(args.new_string ?? "");
  try {
    if (old === "") {
      return `error: old_string must not be empty in ${path}`;
    }
    const current = readFileSync(path, "utf8");
    const count = current.split(old).length - 1;
    if (count === 0) {
      return `error: old_string not found in ${path}`;
    }
    if (count > 1) {
      return `error: old_string appears ${count} times in ${path}; it must be unique`;
    }
    writeFileSync(path, current.replace(old, next), "utf8");
    return `edited ${path}`;
  } catch (err) {
    return errStr(err);
  }
}

export function deleteFile(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  if (path === "") return `error: path must not be empty`;
  try {
    unlinkSync(path);
    return `deleted ${path}`;
  } catch (err) {
    return errStr(err);
  }
}

export function deleteDirectory(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  if (path === "") return `error: path must not be empty`;
  try {
    rmSync(path, { recursive: true });
    return `deleted ${path}`;
  } catch (err) {
    return errStr(err);
  }
}

export function findFiles(args: Record<string, unknown>): string {
  try {
    const pattern = String(args.pattern ?? "");
    if (pattern === "") return "error: pattern must not be empty";
    const root = String(args.root ?? ".");
    const re = new RegExp(pattern);
    const out: string[] = [];
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (re.test(entry.name)) {
          out.push(fullPath);
        }
      }
    }
    const matches = out;
    if (matches.length === 0) return "no matches";
    return matches.join("\n");
  } catch (err) {
    return errStr(err);
  }
}

export function searchFiles(args: Record<string, unknown>): string {
  try {
    const pattern = String(args.pattern ?? "");
    if (pattern === "") return "error: pattern must not be empty";
    const target = String(args.path ?? ".");
    const re = new RegExp(pattern);
    const out: string[] = [];

    const searchFile = (filePath: string): void => {
      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        return; // skip unreadable files (binary, permission, etc.)
      }
      const lines = content.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (re.test(line)) out.push(`${filePath}:${i + 1}: ${line}`);
      });
    };

    if (statSync(target).isFile()) {
      searchFile(target);
    } else {
      const stack: string[] = [target];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink()) continue;
          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(fullPath);
          } else {
            searchFile(fullPath);
          }
        }
      }
    }

    if (out.length === 0) return "no matches";
    return out.join("\n");
  } catch (err) {
    return errStr(err);
  }
}
