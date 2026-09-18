import { execSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { badRequest } from "../errors.js";
import { looksBinary, resolveWithinRoot } from "../fs.js";
import type { LlmToolHandler } from "./llmToolTypes.js";

/** The maximum number of matches a find_files call may return. */
const MAX_FILE_MATCHES = 500;

/** The maximum file size (bytes) a search_files call will read. */
const MAX_BYTES = 1024 * 1024; // 1 MB

/** The maximum number of matching lines a search_files call may return, across all files. */
const MAX_CONTENT_MATCHES = 200;

/** The maximum number of matching lines a single file may contribute to a search_files call. */
const MAX_MATCHES_PER_FILE = 50;

/**
 * List every file git would consider part of the workspace (tracked plus
 * untracked), honoring .gitignore, nested .gitignore files, and
 * .git/info/exclude — the shared listing behind find_files and search_files.
 * -z yields NUL-separated entries so paths with spaces are safe; git exits
 * non-zero (e.g. not a repo), which propagates and is turned into a readable
 * error string for the model by the route's catch.
 */
function listWorkspaceFiles(root: string): string[] {
  const raw = execSync("git ls-files --cached --others --exclude-standard -z", {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  });
  return raw.toString("utf-8").split("\0").filter(Boolean);
}

/** Parse and validate a tool call's regular-expression `pattern` argument. */
function requirePattern(args: Record<string, unknown>): RegExp {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (!pattern) throw badRequest("pattern is required");
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw badRequest(`invalid pattern: ${(err as Error).message}`);
  }
}

/**
 * Search for file names matching a regular expression across the workspace,
 * excluding anything git ignores. The pattern is matched against each file's
 * base name. At most MAX_FILE_MATCHES results are returned.
 */
export const findFiles: LlmToolHandler = async (args, root) => {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  const re = requirePattern(args);
  const files = listWorkspaceFiles(root);

  const matches: string[] = [];
  for (const rel of files) {
    const base = rel.split("/").pop() ?? rel;
    if (re.test(base)) {
      matches.push(rel);
      if (matches.length >= MAX_FILE_MATCHES) break;
    }
  }

  if (matches.length === 0) {
    return `No files match /${pattern}/.`;
  }
  const lines = matches.join("\n");
  const more =
    matches.length >= MAX_FILE_MATCHES
      ? `\n… (results capped at ${MAX_FILE_MATCHES})`
      : "";
  return `Found ${matches.length} file(s) matching /${pattern}/:\n${lines}${more}`;
};

/**
 * Search the text content of files for a regular expression, across the
 * workspace, excluding anything git ignores (see listWorkspaceFiles). Each
 * file is read once and tested line by line; binary files (NUL-sniffed) and
 * files over MAX_BYTES are skipped rather than erroring the whole search, and
 * a file that vanishes between listing and reading (a benign race) is
 * likewise skipped. Results are capped per file (MAX_MATCHES_PER_FILE) and in
 * total (MAX_CONTENT_MATCHES) so one match-heavy file can't crowd out others;
 * the closing note distinguishes the two — a file that hit its own per-file
 * cap is called out by name even when the total cap was never reached, so the
 * model isn't told "found N matches" without knowing a given file had more.
 */
export const searchFiles: LlmToolHandler = async (args, root) => {
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  const re = requirePattern(args);
  const files = listWorkspaceFiles(root);

  const results: string[] = [];
  let totalMatches = 0;
  let filesWithMatches = 0;
  const filesCapped: string[] = [];
  for (const rel of files) {
    if (totalMatches >= MAX_CONTENT_MATCHES) break;
    let buf: Buffer;
    try {
      const target = await resolveWithinRoot(root, rel);
      const info = await stat(target);
      if (!info.isFile() || info.size > MAX_BYTES) continue;
      buf = await readFile(target);
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;

    const lines = buf.toString("utf-8").split(/\r?\n/);
    let fileMatches = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      results.push(`${rel}:${i + 1}: ${lines[i]}`);
      totalMatches++;
      fileMatches++;
      if (fileMatches >= MAX_MATCHES_PER_FILE) {
        filesCapped.push(rel);
        break;
      }
      if (totalMatches >= MAX_CONTENT_MATCHES) break;
    }
    if (fileMatches > 0) filesWithMatches++;
  }

  if (results.length === 0) {
    return `No matches for /${pattern}/.`;
  }
  const notes: string[] = [];
  if (totalMatches >= MAX_CONTENT_MATCHES) {
    notes.push(`results capped at ${MAX_CONTENT_MATCHES} total`);
  }
  if (filesCapped.length > 0) {
    notes.push(
      `hit the ${MAX_MATCHES_PER_FILE}-match per-file cap and may have more ` +
        `matches in: ${filesCapped.join(", ")}`
    );
  }
  const more = notes.length > 0 ? `\n… (${notes.join("; ")})` : "";
  return (
    `Found ${totalMatches} match(es) in ${filesWithMatches} file(s) for ` +
    `/${pattern}/:\n${results.join("\n")}${more}`
  );
};
