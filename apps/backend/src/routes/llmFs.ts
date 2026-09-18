import {
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { badRequest, notFound } from "../errors.js";
import {
  createDir,
  createFile as createFileCore,
  looksBinary,
  resolveWithinRoot,
} from "../fs.js";
import type { LlmToolHandler } from "./llmToolTypes.js";
import { listDir } from "./ls.js";

/** The maximum number of lines a single read_file call may return. */
const MAX_LINES_PER_READ = 300;

/**
 * The maximum number of lines an edit_file call may span (the range being
 * replaced). Keeps a single edit bounded and cheap for the model to reason
 * about; larger changes are made by reading in windows and editing each.
 */
const MAX_LINES_PER_EDIT = 300;

/** The maximum file size (bytes) an edit_file call may produce. */
const MAX_BYTES = 1024 * 1024; // 1 MB

/** List the contents of a directory in the workspace (root-scoped). */
export const listDirectory: LlmToolHandler = async (args, root) => {
  const rel = typeof args.path === "string" ? args.path : "";
  const dir = await resolveWithinRoot(root, rel);
  const items = await listDir(dir);
  const lines = items.map((item) =>
    item.kind === "directory"
      ? `  [dir]  ${item.name}`
      : `  [file] ${item.name}`
  );
  return `Directory "${dir}" contains:\n${lines.join("\n")}`;
};

/**
 * Read a range of lines from a file in the workspace. Lines are 1-based:
 * `start_line` is inclusive, `end_line` is exclusive. At most 300 lines are
 * returned per call; when `end_line` is omitted the range is capped 300 lines
 * past `start_line` so the model can page through long files one window at a
 * time.
 */
export const readFileRange: LlmToolHandler = async (args, root) => {
  const rel = typeof args.path === "string" ? args.path : "";
  if (!rel) throw badRequest("path is required");

  const startLine =
    typeof args.start_line === "number" ? Math.trunc(args.start_line) : 1;
  const endLine =
    typeof args.end_line === "number" ? Math.trunc(args.end_line) : undefined;

  if (startLine < 1) throw badRequest("start_line must be >= 1");
  if (endLine !== undefined && endLine <= startLine) {
    throw badRequest("end_line must be greater than start_line");
  }
  const cap = endLine ?? startLine + MAX_LINES_PER_READ;
  if (cap - startLine > MAX_LINES_PER_READ) {
    throw badRequest(
      `range too large: ${cap - startLine} lines (max ${MAX_LINES_PER_READ})`
    );
  }

  const target = await resolveWithinRoot(root, rel);
  const info = await stat(target);
  if (!info.isFile()) throw notFound();
  const buf = await readFile(target);
  if (looksBinary(buf)) throw badRequest(`cannot read binary file: ${rel}`);

  const lines = buf.toString("utf-8").split(/\r?\n/);
  // endLine is exclusive, so the last 1-based line returned is cap - 1.
  const endInclusive = Math.min(cap - 1, lines.length);
  const slice = lines.slice(startLine - 1, endInclusive);
  const numbered = slice
    .map((line, i) => `${startLine + i}: ${line}`)
    .join("\n");
  const more =
    endInclusive < lines.length ? `\n… (more lines beyond ${cap})` : "";
  return `File "${rel}", lines ${startLine}-${endInclusive}:\n${numbered}${more}`;
};

/**
 * Replace a range of lines in an existing file in the workspace. Lines are
 * 1-based: `start_line` is inclusive, `end_line` is exclusive. When
 * `end_line` equals `start_line`, `content` is inserted before that line
 * without deleting anything; when `end_line` exceeds the file's length it is
 * clamped to the last line so the edit can extend through the end. The target
 * must already exist, be a regular file, be non-binary, and the result must
 * stay under the size cap. The model is expected to have read the file first
 * (via `read_file`) to know the exact lines to replace.
 */
export const editFileRange: LlmToolHandler = async (args, root) => {
  const rel = typeof args.path === "string" ? args.path : "";
  if (!rel) throw badRequest("path is required");
  if (typeof args.content !== "string") {
    throw badRequest("content is required");
  }
  const content = args.content;

  const startLine =
    typeof args.start_line === "number" ? Math.trunc(args.start_line) : 1;
  const endLine =
    typeof args.end_line === "number" ? Math.trunc(args.end_line) : startLine;

  if (startLine < 1) throw badRequest("start_line must be >= 1");
  if (endLine < startLine) {
    throw badRequest("end_line must be >= start_line");
  }

  const target = await resolveWithinRoot(root, rel);
  const info = await stat(target);
  if (!info.isFile()) throw notFound();
  if (info.size > MAX_BYTES) {
    throw badRequest(
      `file too large to edit: ${info.size} bytes (max ${MAX_BYTES})`
    );
  }
  const buf = await readFile(target);
  if (looksBinary(buf)) throw badRequest(`cannot edit binary file: ${rel}`);

  // Lines are 1-based with an exclusive end: the replaced 1-based range is
  // startLine .. (endLine - 1). In 0-based terms the replacement spans
  // [startLine - 1, endLine - 1), so the "after" segment starts at index
  // endLine - 1. clampEnd allows endLine to reach lines.length + 1 (replace
  // through the last line) and clamps anything beyond. Preserve the file's
  // dominant line ending so a one-line edit doesn't re-normalize the whole
  // file to LF.
  const lines = buf.toString("utf-8").split(/\r?\n/);
  const eol = buf.includes("\r\n") ? "\r\n" : "\n";
  const clampEnd = Math.min(endLine, lines.length + 1);
  if (clampEnd - startLine > MAX_LINES_PER_EDIT) {
    throw badRequest(
      `range too large: ${clampEnd - startLine} lines (max ${MAX_LINES_PER_EDIT})`
    );
  }
  // An empty content deletes the range; otherwise the content's lines replace
  // it. (Splitting "" would yield a single blank line, which we don't want.)
  const newLines = content === "" ? [] : content.split(/\r?\n/);
  const result = [
    ...lines.slice(0, startLine - 1),
    ...newLines,
    ...lines.slice(clampEnd - 1),
  ];
  const resultBuf = Buffer.from(result.join(eol), "utf-8");
  if (resultBuf.length > MAX_BYTES) {
    throw badRequest(
      `result too large to save: ${resultBuf.length} bytes (max ${MAX_BYTES})`
    );
  }
  await writeFile(target, resultBuf);
  const replaced = clampEnd - startLine;
  const rangeDesc =
    replaced === 0
      ? `inserted at line ${startLine}`
      : `replaced lines ${startLine}-${clampEnd - 1}`;
  return `Edited "${rel}": ${rangeDesc} with ${newLines.length} line(s).`;
};

/** Create a directory in the workspace (root-scoped; parent must exist). */
export const createDirectory: LlmToolHandler = async (args, root) => {
  const rel = typeof args.path === "string" ? args.path : "";
  if (!rel) throw badRequest("path is required");
  await createDir(root, rel);
  return `Created directory "${rel}".`;
};

/** Create a file in the workspace (root-scoped; parent must exist). */
export const createFile: LlmToolHandler = async (args, root) => {
  const rel = typeof args.path === "string" ? args.path : "";
  if (!rel) throw badRequest("path is required");
  const content = typeof args.content === "string" ? args.content : "";
  await createFileCore(root, rel, content);
  return `Created file "${rel}".`;
};

/**
 * Delete a file in the workspace (root-scoped). Permanent. The root itself is
 * rejected so a malformed path ("", ".", a root alias) cannot wipe it.
 */
export const deleteFile: LlmToolHandler = async (args, root) => {
  const rel = typeof args.path === "string" ? args.path : "";
  if (!rel) throw badRequest("path is required");
  const realRoot = await realpath(root);
  const target = await resolveWithinRoot(root, rel);
  if (target === realRoot) {
    throw badRequest("cannot delete the workspace root");
  }
  const info = await stat(target);
  if (!info.isFile()) throw notFound();
  await unlink(target);
  return `Deleted file "${rel}".`;
};

/** Delete a directory and its contents in the workspace (root-scoped). */
export const deleteDirectory: LlmToolHandler = async (args, root) => {
  const rel = typeof args.path === "string" ? args.path : "";
  if (!rel) throw badRequest("path is required");
  const realRoot = await realpath(root);
  const target = await resolveWithinRoot(root, rel);
  if (target === realRoot) {
    throw badRequest("cannot delete the workspace root");
  }
  const info = await stat(target);
  if (!info.isDirectory()) throw notFound();
  await rm(target, { recursive: true });
  return `Deleted directory "${rel}" and its contents.`;
};
