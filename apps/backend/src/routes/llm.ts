import { type ChildProcess, execSync, spawn } from "node:child_process";
import { readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { LlmToolName } from "@vise/shared";
import type { AppContext } from "../context.js";
import { AppError, badRequest, notFound } from "../errors.js";
import {
  createDir,
  createFile as createFileCore,
  looksBinary,
  resolveWithinRoot,
} from "../fs.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";
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

/** The maximum combined output (bytes) a run_command call may return. */
const MAX_OUTPUT_BYTES = 1024 * 1024; // 1 MB

/** How long a run_command call may run before it is killed as hung. */
const COMMAND_TIMEOUT_MS = 30_000; // 30 seconds

/**
 * Kills a spawned process and its entire process tree. On Windows,
 * `child.kill()` signals only the top-level process (e.g. powershell.exe);
 * any descendants (node, pnpm, git, …) survive and keep running. We kill the
 * tree with `taskkill /T /F` so a hung command (and its children) die together.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    return;
  }
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
  } catch {
    // The process may already have exited; fall back to a plain kill.
    child.kill();
  }
}

/**
 * Concurrency guard: at most one command runs at a time. A single model reply
 * can contain multiple tool_calls, and overlapping turns must not pile up
 * parallel shells. Returns false (so the caller can reject) when a command is
 * already in flight.
 */
let commandInFlight = false;

/**
 * True when the model-supplied name is one of the tools we expose. Derived from
 * the handler record above, so the shared package is used type-only here and
 * the backend stays free of runtime dependencies.
 */
function isLlmToolName(value: string): value is LlmToolName {
  return value in tools;
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
const editFileRange: LlmToolHandler = async (args, root) => {
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

/** Delete a file in the workspace (root-scoped). Permanent. */
const deleteFile: LlmToolHandler = async (args, root) => {
  const rel = typeof args.path === "string" ? args.path : "";
  if (!rel) throw badRequest("path is required");
  const target = await resolveWithinRoot(root, rel);
  const info = await stat(target);
  if (!info.isFile()) throw notFound();
  await unlink(target);
  return `Deleted file "${rel}".`;
};

/** Delete a directory and its contents in the workspace (root-scoped). */
const deleteDirectory: LlmToolHandler = async (args, root) => {
  const rel = typeof args.path === "string" ? args.path : "";
  if (!rel) throw badRequest("path is required");
  const target = await resolveWithinRoot(root, rel);
  const info = await stat(target);
  if (!info.isDirectory()) throw notFound();
  await rm(target, { recursive: true });
  return `Deleted directory "${rel}" and its contents.`;
};

/**
 * Run a PowerShell command in the workspace root and return its combined
 * output and exit status as model-readable text. The command runs
 * non-interactively: it is spawned in its own process, given a hard timeout
 * (killed as hung when exceeded, along with its whole process tree), and its
 * stdout/stderr are capped at MAX_OUTPUT_BYTES so a chatty command can't flood
 * the model's context. stdout and stderr are kept distinct in the result so the
 * model can tell a failure's diagnostics apart from normal output. At most one
 * command runs at a time. The working directory is the workspace root, matching
 * the file tools, so relative paths in the command resolve against it.
 */
const runCommand: LlmToolHandler = (args, root) => {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command) throw badRequest("command is required");
  if (commandInFlight)
    throw badRequest("a command is already running; wait for it to finish");

  return new Promise<string>((resolvePromise, reject) => {
    // -NoProfile keeps it fast and free of the user's profile side effects;
    // -NonInteractive prevents any prompt from blocking the process.
    commandInFlight = true;
    // spawn can throw synchronously (e.g. a bad cwd, or a NUL byte in the
    // command); in that case no child is created so the close/error handlers
    // below never fire — reset the flag here or it wedges run_command forever.
    let child: ChildProcess;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { cwd: root }
      );
    } catch (err) {
      commandInFlight = false;
      reject(
        new AppError(
          500,
          "spawn_error",
          `failed to run command: ${err instanceof Error ? err.message : String(err)}`
        )
      );
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;

    const onChunk = (chunk: Buffer, target: "out" | "err") => {
      if (truncated) return;
      if (target === "out") {
        out.push(chunk);
        outBytes += chunk.length;
      } else {
        err.push(chunk);
        errBytes += chunk.length;
      }
      if (outBytes + errBytes > MAX_OUTPUT_BYTES) truncated = true;
    };
    child.stdout?.on("data", (c: Buffer) => onChunk(c, "out"));
    child.stderr?.on("data", (c: Buffer) => onChunk(c, "err"));

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, COMMAND_TIMEOUT_MS);

    const finish = () => {
      commandInFlight = false;
    };

    child.on("error", (err) => {
      clearTimeout(timer);
      finish();
      reject(
        new AppError(
          500,
          "spawn_error",
          `failed to run command: ${err.message}`
        )
      );
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      finish();
      const stdout = Buffer.concat(out).toString("utf-8").trimEnd();
      const stderr = Buffer.concat(err).toString("utf-8").trimEnd();
      const combined = stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout;
      const body = truncated
        ? `${combined.slice(0, MAX_OUTPUT_BYTES)}\n… (output capped at ${MAX_OUTPUT_BYTES} bytes)`
        : combined;
      const status = signal != null ? `signal ${signal}` : `exit ${code ?? 0}`;
      if (timedOut) {
        resolvePromise(
          `$ ${command}\ntimed out after ${COMMAND_TIMEOUT_MS / 1000}s\n${body}`
        );
      } else {
        resolvePromise(`$ ${command}\n${status}\n${body}`.trimEnd());
      }
    });
  });
};

/**
 * The tools available to the model, keyed by the name the model uses. The keys
 * are checked against the shared LlmToolName union, so a renamed or misspelled
 * tool name here is a compile error.
 */
const tools: Record<LlmToolName, LlmToolHandler> = {
  list_directory: listDirectory,
  read_file: readFileRange,
  edit_file: editFileRange,
  create_directory: createDirectory,
  create_file: createFile,
  delete_file: deleteFile,
  delete_directory: deleteDirectory,
  run_command: runCommand,
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

        const tool = isLlmToolName(name) ? tools[name] : undefined;
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
