import { readdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import { createInterface } from "node:readline";
import type { ToolCall, ToolResponse } from "./types";

export const DEFAULT_LIST_LIMIT = 200;
export const DEFAULT_READ_LIMIT = 200;

const LIST_FILES_TOOL = {
  type: "function",
  function: {
    name: "list_files",
    description: "List the file and directory entries in a directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The directory to list. Defaults to the current working directory.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of entries to return. Defaults to 200.",
        },
      },
      required: [] as string[],
    },
  },
};

const READ_FILE_TOOL = {
  type: "function",
  function: {
    name: "read_file",
    description:
      "Read the contents of a text file. Files may be arbitrarily large; by " +
      "default the first 200 lines are returned. Use startLine and endLine to " +
      "read a specific range, and a larger limit to read more at once.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The file to read. May be relative to the current working " +
            "directory or an absolute path.",
        },
        startLine: {
          type: "integer",
          description: "1-indexed line to start reading from. Defaults to 1.",
        },
        endLine: {
          type: "integer",
          description:
            "1-indexed inclusive line to stop reading at. Defaults to " +
            "startLine plus limit minus 1.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum number of lines to return when endLine is not given. " +
            "Defaults to 200.",
        },
      },
      required: ["path"] as string[],
    },
  },
};

export const tools = [LIST_FILES_TOOL, READ_FILE_TOOL];

export async function executeToolCall(call: ToolCall): Promise<ToolResponse> {
  if (call.function.name === "list_files") {
    const raw: unknown = call.function.arguments;
    const args = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
    >;
    const path =
      typeof args["path"] === "string" && args["path"] !== ""
        ? args["path"]
        : process.cwd();
    const rawLimit = args["limit"];
    const limit =
      typeof rawLimit === "number" && rawLimit > 0
        ? Math.floor(rawLimit)
        : DEFAULT_LIST_LIMIT;
    try {
      const entries = await readdir(path, { withFileTypes: true });
      const sorted = [...entries].sort((a: Dirent, b: Dirent) =>
        a.name.localeCompare(b.name),
      );
      const total = sorted.length;
      const items = sorted.slice(0, limit).map((entry: Dirent) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      }));
      const result = {
        total,
        truncated: total > limit,
        entries: items,
      };
      return { content: JSON.stringify(result, null, 2) };
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  if (call.function.name === "read_file") {
    const raw: unknown = call.function.arguments;
    const args = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
    >;
    const path = args["path"];
    if (typeof path !== "string" || path === "") {
      return { content: "Error: read_file requires a non-empty 'path'." };
    }
    const rawStart = args["startLine"];
    const startLine =
      typeof rawStart === "number" && rawStart > 0 ? Math.floor(rawStart) : 1;
    const rawLimit = args["limit"];
    const limit =
      typeof rawLimit === "number" && rawLimit > 0
        ? Math.floor(rawLimit)
        : DEFAULT_READ_LIMIT;
    const rawEnd = args["endLine"];
    const endLine =
      typeof rawEnd === "number" && rawEnd > 0
        ? Math.floor(rawEnd)
        : startLine + limit - 1;
    return await readTextFile(path, startLine, endLine);
  }
  return { content: `Unknown tool: ${call.function.name}` };
}

async function readTextFile(
  path: string,
  startLine: number,
  endLine: number,
): Promise<ToolResponse> {
  const result = await new Promise<
    | { ok: true; lines: string[]; stoppedEarly: boolean }
    | {
        ok: false;
        error: string;
      }
  >((resolve) => {
    const lines: string[] = [];
    let lineNumber = 0;
    let stoppedEarly = false;
    let settled = false;
    const rl = createInterface({
      input: createReadStream(path, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    const finish = (): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve({ ok: true, lines, stoppedEarly });
    };
    rl.on("line", (line: string) => {
      lineNumber += 1;
      if (lineNumber >= startLine && lineNumber <= endLine) {
        lines.push(line);
      }
      if (lineNumber >= endLine) {
        stoppedEarly = true;
        finish();
      }
    });
    rl.on("close", finish);
    rl.on("error", (err) => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });
  if (!result.ok) {
    return { content: `Error: ${result.error}` };
  }
  return {
    content: JSON.stringify(
      {
        path,
        startLine,
        endLine,
        returnedLines: result.lines.length,
        truncated: result.stoppedEarly,
        lines: result.lines,
      },
      null,
      2,
    ),
  };
}
