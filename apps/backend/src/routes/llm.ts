import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppContext } from "../context.js";
import { AppError, badRequest, notFound } from "../errors.js";
import {
  createDir,
  createFile as createFileCore,
  resolveWithinRoot,
} from "../fs.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";
import { listDir } from "./ls.js";

/** The maximum number of lines a single read_file call may return. */
const MAX_LINES_PER_READ = 300;

// A NUL byte in the leading window means the content is binary, not text.
const BINARY_SNIFF_BYTES = 8 * 1024;

function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES);
  return buf.subarray(0, end).includes(0);
}

/**
 * A tool the LLM can run against the workspace. The model calls these through
 * POST /api/llm/tool; each tool maps a name and JSON arguments to a text
 * result the model can read back. Every tool reaches the filesystem only via
 * the sandboxed resolvers in fs.ts, so path safety is centralized here.
 */
type LlmToolHandler = (
  args: Record<string, unknown>,
  root: string
) => Promise<string>;

/** List the contents of a directory in the workspace (root-scoped). */
const listDirectory: LlmToolHandler = async (args, root) => {
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
const readFileRange: LlmToolHandler = async (args, root) => {
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

/** Create a directory in the workspace (root-scoped; parent must exist). */
const createDirectory: LlmToolHandler = async (args, root) => {
  const rel = typeof args.path === "string" ? args.path : "";
  if (!rel) throw badRequest("path is required");
  await createDir(root, rel);
  return `Created directory "${rel}".`;
};

/** Create a file in the workspace (root-scoped; parent must exist). */
const createFile: LlmToolHandler = async (args, root) => {
  const rel = typeof args.path === "string" ? args.path : "";
  if (!rel) throw badRequest("path is required");
  const content = typeof args.content === "string" ? args.content : "";
  await createFileCore(root, rel, content);
  return `Created file "${rel}".`;
};

/** The tools available to the model, keyed by the name the model uses. */
const tools: Record<string, LlmToolHandler> = {
  list_directory: listDirectory,
  read_file: readFileRange,
  create_directory: createDirectory,
  create_file: createFile,
};

/**
 * Execute a tool call on the backend and return the result as model-readable
 * text. Unknown tools and thrown errors are returned as 200 with an error
 * string so the model can read the problem and adapt, rather than the client
 * tool loop crashing.
 */
export function llmToolRoutes(ctx: AppContext): Route[] {
  const root = resolve(ctx.rootPath);
  return [
    {
      method: "POST",
      pattern: "/api/llm/tool",
      handler: async (_req, res, _params, body) => {
        const payload = (body ?? {}) as {
          name?: unknown;
          arguments?: unknown;
        };
        const name = typeof payload.name === "string" ? payload.name : "";
        let args: Record<string, unknown> = {};
        if (typeof payload.arguments === "string") {
          try {
            args = JSON.parse(payload.arguments || "{}") as Record<
              string,
              unknown
            >;
          } catch {
            args = {};
          }
        }

        const tool = tools[name];
        if (!tool) {
          sendJson(res, 200, { result: `Error: unknown tool "${name}".` });
          return;
        }
        try {
          const result = await tool(args, root);
          sendJson(res, 200, { result });
        } catch (err) {
          const message =
            err instanceof AppError ? err.message : (err as Error).message;
          sendJson(res, 200, { result: `Error: ${message}` });
        }
      },
    },
  ];
}
