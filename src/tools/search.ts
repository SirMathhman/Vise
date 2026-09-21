// Search tool handlers: find_files (name search) and search_content
// (content search). Read-only filesystem access.
import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

// Directory names skipped while walking, so results stay bounded and focused
// on the project rather than dependency or VCS internals.
const SKIP_DIRS = new Set(["node_modules", ".git"]);

// Yields every file under root (including root if it is a file), recursing
// into subdirectories while skipping SKIP_DIRS. Stack-based so deep trees
// cannot overflow the call stack.
function* walkFiles(root: string): Generator<string, void, undefined> {
  if (existsSync(root) && statSync(root).isFile()) {
    yield root;
    return;
  }
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full);
      } else if (entry.isFile()) {
        yield full;
      }
    }
  }
}

// A file path relative to the working directory, so the model can feed the
// result straight back into read_file.
function displayPath(fullPath: string): string {
  const rel = path.relative(process.cwd(), fullPath);
  return rel.length > 0 ? rel : ".";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const find_files = async (
  args: Record<string, unknown>,
): Promise<string> => {
  const pattern = String(args.pattern ?? "");
  if (pattern.length === 0) return "Error: pattern is empty.";
  const rawPath = String(args.path ?? ".");
  const dirPath = path.resolve(process.cwd(), rawPath);
  const maxResults = Math.max(1, Math.min(500, Number(args.maxResults ?? 100)));
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    return `Error: ${rawPath} is not a directory.`;
  }
  const regex = new RegExp(
    `^${pattern.split("*").map(escapeRegex).join(".*")}$`,
    "i",
  );
  const matches: string[] = [];
  for (const filePath of walkFiles(dirPath)) {
    if (regex.test(path.basename(filePath))) {
      matches.push(displayPath(filePath));
      if (matches.length >= maxResults) break;
    }
  }
  if (matches.length === 0) {
    return `No files matching "${pattern}" under ${rawPath}.`;
  }
  const suffix =
    matches.length >= maxResults ? `\n\n(Showing first ${maxResults}.)` : "";
  return matches.join("\n") + suffix;
};

export const search_content = async (
  args: Record<string, unknown>,
): Promise<string> => {
  const pattern = String(args.pattern ?? "");
  if (pattern.length === 0) return "Error: pattern is empty.";
  const rawPath = String(args.path ?? ".");
  const maxResults = Math.max(1, Math.min(200, Number(args.maxResults ?? 50)));
  const caseSensitive = Boolean(args.caseSensitive ?? false);
  const target = path.resolve(process.cwd(), rawPath);
  if (!existsSync(target)) {
    return `Error: ${rawPath} not found.`;
  }
  const files: string[] = [];
  if (statSync(target).isDirectory()) {
    for (const f of walkFiles(target)) files.push(f);
  } else {
    files.push(target);
  }
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const matches: string[] = [];
  outer: for (const filePath of files) {
    let content: string;
    try {
      content = readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    if (content.includes("\u0000")) continue; // skip binary
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw === undefined) continue;
      const line = caseSensitive ? raw : raw.toLowerCase();
      if (line.includes(needle)) {
        matches.push(
          `${displayPath(filePath)}:${i + 1}: ${raw.replace(/\r$/, "").trim()}`,
        );
        if (matches.length >= maxResults) break outer;
      }
    }
  }
  if (matches.length === 0) {
    return `No matches for "${pattern}" under ${rawPath}.`;
  }
  const suffix =
    matches.length >= maxResults ? `\n\n(Showing first ${maxResults}.)` : "";
  return matches.join("\n") + suffix;
};
