import { config } from "../config.ts";
import { badNumber, numberArg } from "./args.ts";
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

/**
 * A failure as the tool result the model and the runner both recognise: the
 * `error:` prefix is what marks a result as failed (audit, goal loop, display),
 * so every failing tool returns this and never a bare message.
 */
export function errStr(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.startsWith("error:") ? message : `error: ${message}`;
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
 * Lines of a file with their numbers in front (`  12 | text`), counted from
 * `from`, so the model reads a line's place instead of guessing it. The numbers
 * are not part of the file; the tool's description says so.
 */
export function numberLines(lines: string[], from: number): string {
  const width = String(from + lines.length - 1).length;
  return lines
    .map((line, i) => `${String(from + i).padStart(width)} | ${line}`)
    .join("\n");
}

/**
 * Read a file, or `limit` lines of it from line `offset`. A small file comes
 * back whole; a big one (or a range) comes back as at most `MAX_LINES` lines
 * and `MAX_CHARS` characters with a header and a pointer to the rest, so one
 * read can never flood the context.
 */
export function readFile(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  if (path === "") return `error: path is required`;
  const refused =
    badNumber("offset", args.offset) ?? badNumber("limit", args.limit);
  if (refused) return refused;
  try {
    const text = readFileSync(path, "utf8");
    const ranged =
      numberArg(args.offset) !== undefined ||
      numberArg(args.limit) !== undefined;
    if (!ranged && !isTooLarge(text)) {
      if (text === "") return text;
      const whole = text.split(/\r?\n/);
      const endsWithNewline = whole[whole.length - 1] === "";
      return numberLines(endsWithNewline ? whole.slice(0, -1) : whole, 1);
    }
    const all = text.split(/\r?\n/);
    const num = (v: unknown, fallback: number): number =>
      Math.floor(numberArg(v) ?? fallback);
    const from = Math.max(1, num(args.offset, 1));
    if (all.length < from) {
      return `error: the file has ${all.length} lines; there is nothing at line ${from}`;
    }
    const count = Math.min(
      config.resultMaxLines,
      Math.max(1, num(args.limit, config.resultMaxLines)),
    );
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
    return `[lines ${from}-${last} of ${all.length}]\n${numberLines(shown.split("\n"), from)}${more}`;
  } catch (err) {
    return errStr(err);
  }
}

export function createFile(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  if (path === "") return `error: path is required`;
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

const CRLF = new RegExp(String.fromCharCode(13, 10), "g");
const LONE_LF = new RegExp(
  "(?<!" + String.fromCharCode(13) + ")" + String.fromCharCode(10),
  "g",
);

/** Whether most of a text's line breaks are CRLF (a Windows file) rather than LF. */
function usesCrlf(text: string): boolean {
  const crlf = text.match(CRLF)?.length ?? 0;
  return crlf > 0 && crlf >= (text.match(LONE_LF)?.length ?? 0);
}

/** `text` with every line break CRLF. */
function withCrlf(text: string): string {
  return text.replace(CRLF, "\n").replaceAll("\n", "\r\n");
}

export function editFile(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  const old = String(args.old_string ?? "");
  const next = String(args.new_string ?? "");
  if (path === "") return `error: path is required`;
  try {
    if (old === "") {
      return `error: old_string must not be empty in ${path}`;
    }
    const current = readFileSync(path, "utf8");
    // The model writes `\n`; a file with CRLF line endings keeps them.
    const crlf = usesCrlf(current);
    const wanted = crlf && !current.includes(old) ? withCrlf(old) : old;
    const replacement = crlf ? withCrlf(next) : next;
    const count = current.split(wanted).length - 1;
    if (count === 0) {
      return `error: old_string not found in ${path}`;
    }
    if (count > 1) {
      return `error: old_string appears ${count} times in ${path}; it must be unique`;
    }
    // A function, so `$&`, `$'` and the like in the new text are written as they are.
    writeFileSync(
      path,
      current.replace(wanted, () => replacement),
      "utf8",
    );
    return `edited ${path}`;
  } catch (err) {
    return errStr(err);
  }
}

export function deleteFile(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  if (path === "") return `error: path is required`;
  try {
    unlinkSync(path);
    return `deleted ${path}`;
  } catch (err) {
    return errStr(err);
  }
}

export function deleteDirectory(args: Record<string, unknown>): string {
  const path = String(args.path ?? "");
  if (path === "") return `error: path is required`;
  try {
    rmSync(path, { recursive: true });
    return `deleted ${path}`;
  } catch (err) {
    return errStr(err);
  }
}

/** Folders a recursive search does not descend into (generated or repository internals); a search that starts inside one still walks it. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

/** Call `onFile(path, name)` for every file under `root`, skipping symlinks and `SKIPPED_DIRECTORIES`. */
function walkFiles(root: string, onFile: (path: string, name: string) => void): void {
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
        if (!SKIPPED_DIRECTORIES.has(entry.name)) stack.push(fullPath);
      } else {
        onFile(fullPath, entry.name);
      }
    }
  }
}

export function findFiles(args: Record<string, unknown>): string {
  try {
    const pattern = String(args.pattern ?? "");
    if (pattern === "") return "error: pattern must not be empty";
    const root = String(args.root ?? ".");
    const re = new RegExp(pattern);
    const out: string[] = [];
    walkFiles(root, (path, name) => {
      if (re.test(name)) out.push(path);
    });
    return out.length === 0 ? "no matches" : out.join("\n");
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
      content.split(/\r?\n/).forEach((line, i) => {
        if (re.test(line)) out.push(`${filePath}:${i + 1}: ${line}`);
      });
    };
    if (statSync(target).isFile()) searchFile(target);
    else walkFiles(target, searchFile);
    return out.length === 0 ? "no matches" : out.join("\n");
  } catch (err) {
    return errStr(err);
  }
}
